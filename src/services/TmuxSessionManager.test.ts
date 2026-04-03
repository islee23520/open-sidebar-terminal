import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { TmuxSessionManager, TmuxUnavailableError } from "./TmuxSessionManager";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

type MockExecStep = {
  stdout?: string;
  stderr?: string;
  error?: (Error & { code?: number | string }) | null;
};

describe("TmuxSessionManager", () => {
  let manager: TmuxSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TmuxSessionManager();
  });

  function mockExecSequence(steps: MockExecStep[]): void {
    let callIndex = 0;

    vi.mocked(execFile).mockImplementation(((...args: any[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const step = steps[callIndex++] ?? { stdout: "", stderr: "" };

      callback(step.error ?? null, step.stdout ?? "", step.stderr ?? "");
      return {} as any;
    }) as any);
  }

  it("parses discovered tmux sessions into sidebar entries", async () => {
    mockExecSequence([
      {
        stdout: [
          "repo-a\t1\t/workspaces/repo-a",
          "repo-b\t0\t/workspaces/repo-b",
        ].join("\n"),
      },
    ]);

    const sessions = await manager.discoverSessions();

    expect(sessions).toEqual([
      {
        id: "repo-a",
        name: "repo-a",
        workspace: "repo-a",
        isActive: true,
      },
      {
        id: "repo-b",
        name: "repo-b",
        workspace: "repo-b",
        isActive: false,
      },
    ]);
  });

  it("reports available when tmux version command succeeds", async () => {
    mockExecSequence([
      {
        stdout: "tmux 3.4",
      },
    ]);

    await expect(manager.isAvailable()).resolves.toBe(true);
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual(["-V"]);
  });

  it("reports unavailable when tmux binary is missing", async () => {
    const missingTmuxError = Object.assign(new Error("spawn tmux ENOENT"), {
      code: "ENOENT",
    });

    mockExecSequence([
      {
        error: missingTmuxError,
      },
    ]);

    await expect(manager.isAvailable()).resolves.toBe(false);
  });

  it("reuses an existing tmux session without non-interactive attach", async () => {
    mockExecSequence([
      {
        stdout: "repo-a\t0\t/workspaces/repo-a",
      },
    ]);

    const result = await manager.ensureSession("repo-a", "/workspaces/repo-a");

    expect(result).toEqual({
      action: "attached",
      session: {
        id: "repo-a",
        name: "repo-a",
        workspace: "repo-a",
        isActive: true,
      },
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("prefers exact workspace path match over creating a new session", async () => {
    mockExecSequence([
      {
        stdout: ["legacy-repo-a\t0\t/workspaces/repo-a"].join("\n"),
      },
    ]);

    const result = await manager.ensureSession("repo-a", "/workspaces/repo-a");

    expect(result).toEqual({
      action: "attached",
      session: {
        id: "legacy-repo-a",
        name: "legacy-repo-a",
        workspace: "repo-a",
        isActive: true,
      },
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("prefers the active session when multiple tmux sessions share a workspace", async () => {
    mockExecSequence([
      {
        stdout: [
          "repo-a-2\t0\t/workspaces/repo-a",
          "repo-a-dev\t1\t/workspaces/repo-a",
        ].join("\n"),
      },
    ]);

    const session = await manager.findSessionForWorkspace("/workspaces/repo-a");

    expect(session).toEqual({
      id: "repo-a-dev",
      name: "repo-a-dev",
      workspace: "repo-a",
      isActive: true,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("avoids wrong-session attachment on name collision by preferring workspace path", async () => {
    mockExecSequence([
      {
        stdout: [
          "repo-a\t0\t/workspaces/repo-a-archive",
          "repo-a-current\t0\t/workspaces/repo-a",
        ].join("\n"),
      },
    ]);

    const result = await manager.ensureSession("repo-a", "/workspaces/repo-a");

    expect(result).toEqual({
      action: "attached",
      session: {
        id: "repo-a-current",
        name: "repo-a-current",
        workspace: "repo-a",
        isActive: true,
      },
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("creates a collision-safe session when stale metadata prevents workspace match", async () => {
    mockExecSequence([
      {
        stdout: ["repo-a\t0\t", "repo-a-2\t0\t/workspaces/old"].join("\n"),
      },
      {
        stdout: "",
      },
      {
        stdout: "",
      },
    ]);

    const result = await manager.ensureSession("repo-a", "/workspaces/repo-a");

    expect(result).toEqual({
      action: "created",
      session: {
        id: "repo-a-3",
        name: "repo-a-3",
        workspace: "repo-a",
        isActive: true,
      },
    });
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toEqual([
      "new-session",
      "-d",
      "-s",
      "repo-a-3",
      "-c",
      "/workspaces/repo-a",
    ]);
  });

  it("creates a detached session when no tmux sessions are available", async () => {
    const noServerError = Object.assign(new Error("no server running"), {
      code: 1,
    });

    mockExecSequence([
      {
        error: noServerError,
        stderr: "no server running on /tmp/tmux-1000/default",
      },
      {
        stdout: "",
      },
      {
        stdout: "",
      },
    ]);

    const result = await manager.ensureSession("repo-c", "/workspaces/repo-c");

    expect(result).toEqual({
      action: "created",
      session: {
        id: "repo-c",
        name: "repo-c",
        workspace: "repo-c",
        isActive: true,
      },
    });
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toEqual([
      "new-session",
      "-d",
      "-s",
      "repo-c",
      "-c",
      "/workspaces/repo-c",
    ]);
  });

  it("kills an existing tmux session", async () => {
    mockExecSequence([
      {
        stdout: "",
      },
    ]);

    await expect(manager.killSession("repo-k")).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
      "kill-session",
      "-t",
      "repo-k",
    ]);
  });

  describe("pane management", () => {
    it("splits pane horizontally and returns new pane ID", async () => {
      mockExecSequence([{ stdout: "%5" }]);
      const result = await manager.splitPane("%0", "h");
      expect(result).toBe("%5");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "split-window",
        "-t",
        "%0",
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
      ]);
    });

    it("splits pane vertically with command", async () => {
      mockExecSequence([{ stdout: "%6" }]);
      const result = await manager.splitPane("%0", "v", { command: "htop" });
      expect(result).toBe("%6");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "split-window",
        "-t",
        "%0",
        "-v",
        "-P",
        "-F",
        "#{pane_id}",
        "htop",
      ]);
    });

    it("splits pane with working directory", async () => {
      mockExecSequence([{ stdout: "%7" }]);
      const result = await manager.splitPane("%0", "h", {
        workingDirectory: "/some/path",
      });
      expect(result).toBe("%7");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "split-window",
        "-t",
        "%0",
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
        "-c",
        "/some/path",
      ]);
    });

    it("kills a pane", async () => {
      mockExecSequence([{ stdout: "" }]);
      await manager.killPane("%0");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "kill-pane",
        "-t",
        "%0",
      ]);
    });

    it("selects a pane", async () => {
      mockExecSequence([{ stdout: "" }]);
      await manager.selectPane("%0");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "select-pane",
        "-t",
        "%0",
      ]);
    });

    it("selects the target window before selecting a pane in another window", async () => {
      mockExecSequence([{ stdout: "" }, { stdout: "" }]);
      await manager.selectPane("%3", "@2");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "select-window",
        "-t",
        "@2",
      ]);
      expect(vi.mocked(execFile).mock.calls[1]?.[1]).toEqual([
        "select-pane",
        "-t",
        "%3",
      ]);
    });

    it("resizes a pane", async () => {
      mockExecSequence([{ stdout: "" }]);
      await manager.resizePane("%0", "L", 5);
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "resize-pane",
        "-t",
        "%0",
        "-L",
        "5",
      ]);
    });

    it("swaps two panes", async () => {
      mockExecSequence([{ stdout: "" }]);
      await manager.swapPanes("%0", "%1");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "swap-pane",
        "-s",
        "%0",
        "-t",
        "%1",
      ]);
    });

    it("creates a new window in a session", async () => {
      mockExecSequence([{ stdout: "" }]);
      await manager.createWindow("test-session");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "new-window",
        "-t",
        "test-session",
      ]);
    });

    it("throws TmuxUnavailableError for createWindow when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.createWindow("test-session")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("kills a window", async () => {
      mockExecSequence([{ stdout: "" }]);
      await manager.killWindow("@0");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "kill-window",
        "-t",
        "@0",
      ]);
    });

    it("throws TmuxUnavailableError for killWindow when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.killWindow("@0")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("throws TmuxUnavailableError for splitPane when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.splitPane("%0", "h")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("throws TmuxUnavailableError for killPane when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.killPane("%0")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("throws TmuxUnavailableError for selectPane when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.selectPane("%0")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("throws TmuxUnavailableError for resizePane when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.resizePane("%0", "L", 5)).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("throws TmuxUnavailableError for swapPanes when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.swapPanes("%0", "%1")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("lists panes for a session", async () => {
      mockExecSequence([
        {
          stdout: "%0\t0\tbash\t1\tbash\t@0\n%1\t1\tvim\t0\tvim\t@0",
        },
      ]);
      const panes = await manager.listPanes("test-session");
      expect(panes).toEqual([
        {
          paneId: "%0",
          index: 0,
          title: "bash",
          isActive: true,
          currentCommand: "bash",
          windowId: "@0",
        },
        {
          paneId: "%1",
          index: 1,
          title: "vim",
          isActive: false,
          currentCommand: "vim",
          windowId: "@0",
        },
      ]);
    });

    it("returns empty array when session has no panes (no server error)", async () => {
      const err = Object.assign(new Error("no server running"), {
        code: 1,
        stderr: "failed to connect to server",
      });
      mockExecSequence([{ error: err }]);
      const panes = await manager.listPanes("test-session");
      expect(panes).toEqual([]);
    });

    it("throws TmuxUnavailableError for listPanes when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.listPanes("test-session")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("lists pane DTOs for a session", async () => {
      mockExecSequence([
        {
          stdout: "%0\t0\tbash\t0\tbash\t@0\n%2\t1\thtop\t1\thtop\t@0",
        },
      ]);
      const dtos = await manager.listPaneDtos("test-session");
      expect(dtos).toEqual([
        {
          paneId: "%0",
          index: 0,
          title: "bash",
          isActive: false,
          currentCommand: "bash",
          windowId: "@0",
        },
        {
          paneId: "%2",
          index: 1,
          title: "htop",
          isActive: true,
          currentCommand: "htop",
          windowId: "@0",
        },
      ]);
    });

    it("lists windows for a session", async () => {
      mockExecSequence([
        {
          stdout: "@0\t0\tmain\t1\n@1\t1\tlogs\t0",
        },
      ]);
      const windows = await manager.listWindows("test-session");
      expect(windows).toEqual([
        { windowId: "@0", index: 0, name: "main", isActive: true },
        { windowId: "@1", index: 1, name: "logs", isActive: false },
      ]);
    });

    it("returns empty array when list-windows fails with no server error", async () => {
      const err = Object.assign(new Error("no server running"), {
        code: 1,
        stderr: "failed to connect to server",
      });
      mockExecSequence([{ error: err }]);
      const windows = await manager.listWindows("test-session");
      expect(windows).toEqual([]);
    });

    it("throws TmuxUnavailableError for listWindows when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.listWindows("test-session")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });

    it("sends text to a pane", async () => {
      mockExecSequence([{ stdout: "" }]);
      await manager.sendTextToPane("%0", "ls");
      expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
        "send-keys",
        "-t",
        "%0",
        "ls",
        "C-m",
      ]);
    });

    it("throws TmuxUnavailableError for sendTextToPane when tmux missing", async () => {
      const err = Object.assign(new Error("spawn tmux ENOENT"), {
        code: "ENOENT",
      });
      mockExecSequence([{ error: err }]);
      await expect(manager.sendTextToPane("%0", "ls")).rejects.toBeInstanceOf(
        TmuxUnavailableError,
      );
    });
  });

  it("surfaces a dedicated error when tmux is missing", async () => {
    const missingTmuxError = Object.assign(new Error("spawn tmux ENOENT"), {
      code: "ENOENT",
    });

    mockExecSequence([
      {
        error: missingTmuxError,
      },
    ]);

    await expect(manager.discoverSessions()).rejects.toBeInstanceOf(
      TmuxUnavailableError,
    );
  });

  it("builds an empty no-sessions snapshot when tmux has no server", async () => {
    const noServerError = Object.assign(new Error("no server running"), {
      code: 1,
    });

    mockExecSequence([
      {
        error: noServerError,
        stderr: "failed to connect to server",
      },
    ]);

    const snapshot = await manager.createTreeSnapshot();

    expect(snapshot).toEqual({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-sessions",
    });
  });

  it("builds an empty no-tmux snapshot when tmux is unavailable", async () => {
    const missingTmuxError = Object.assign(new Error("tmux: not found"), {
      code: "ENOENT",
    });

    mockExecSequence([
      {
        error: missingTmuxError,
      },
    ]);

    const snapshot = await manager.createTreeSnapshot();

    expect(snapshot).toEqual({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-tmux",
    });
  });
});
