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
    expect(execFile).toHaveBeenCalledTimes(2);
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
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toEqual([
      "new-session",
      "-d",
      "-s",
      "repo-c",
      "-c",
      "/workspaces/repo-c",
    ]);
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
