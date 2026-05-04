import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZellijSessionManager } from "./ZellijSessionManager";

type MockExecStep = {
  stdout?: string;
  stderr?: string;
  error?: (Error & { code?: number | string; stderr?: string }) | null;
};

describe("ZellijSessionManager", () => {
  let manager: ZellijSessionManager;
  let execCalls: Array<{ file: string; args: string[]; cwd?: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    execCalls = [];
    manager = new ZellijSessionManager();
  });

  function mockExecSequence(steps: MockExecStep[]): void {
    let callIndex = 0;
    manager = new ZellijSessionManager(undefined, (file, args, options, callback) => {
      execCalls.push({ file, args, cwd: options.cwd?.toString() });
      const step = steps[callIndex++] ?? { stdout: "", stderr: "" };
      callback(step.error ?? null, step.stdout ?? "", step.stderr ?? "");
    });
  }

  it("reports available when zellij version command succeeds", async () => {
    mockExecSequence([{ stdout: "zellij 0.41.2" }]);

    await expect(manager.isAvailable()).resolves.toBe(true);
    expect(execCalls[0]?.args).toEqual(["--version"]);
  });

  it("reports unavailable when zellij binary is missing", async () => {
    const missingZellijError = Object.assign(new Error("spawn zellij ENOENT"), {
      code: "ENOENT",
    });
    mockExecSequence([{ error: missingZellijError }]);

    await expect(manager.isAvailable()).resolves.toBe(false);
  });

  it("parses zellij sessions", async () => {
    mockExecSequence([{ stdout: "repo-a\nrepo-b (current)\n" }]);

    await expect(manager.discoverSessions()).resolves.toEqual([
      { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: false },
      { id: "repo-b", name: "repo-b", workspace: "repo-b", isActive: true },
    ]);
  });

  it("creates missing sessions with create-background attach", async () => {
    mockExecSequence([{ stdout: "" }, { stdout: "" }]);

    await expect(
      manager.ensureSession("repo-a", "/workspace/repo-a"),
    ).resolves.toMatchObject({
      action: "created",
      session: { id: "repo-a" },
    });

    expect(execCalls[1]?.args).toEqual([
      "attach",
      "--create-background",
      "repo-a",
    ]);
    expect(execCalls[1]?.cwd).toBe("/workspace/repo-a");
  });

  it("builds attach command", () => {
    expect(manager.getAttachCommand("repo-a")).toBe("zellij attach 'repo-a'");
  });

  it("kills a named session", async () => {
    mockExecSequence([{ stdout: "" }]);

    await expect(manager.killSession("repo-a")).resolves.toBeUndefined();

    expect(execCalls[0]?.args).toEqual(["kill-session", "repo-a"]);
  });

  it("switches sessions by name", async () => {
    mockExecSequence([{ stdout: "" }]);

    await expect(manager.switchSession("repo-b")).resolves.toBeUndefined();

    expect(execCalls[0]?.args).toEqual(["action", "switch-session", "repo-b"]);
  });

  it("splits panes horizontally and returns the new pane id", async () => {
    mockExecSequence([{ stdout: "terminal_7\n" }]);

    await expect(
      manager.splitPane("h", {
        command: "npm test",
        workingDirectory: "/workspace/repo-a",
      }),
    ).resolves.toBe("terminal_7");

    expect(execCalls[0]).toEqual({
      file: "zellij",
      args: [
        "action",
        "new-pane",
        "--direction",
        "right",
        "--cwd",
        "/workspace/repo-a",
        "--command",
        "npm test",
      ],
      cwd: "/workspace/repo-a",
    });
  });

  it("splits panes vertically", async () => {
    mockExecSequence([{ stdout: "plugin_2\n" }]);

    await expect(manager.splitPane("v")).resolves.toBe("plugin_2");

    expect(execCalls[0]?.args).toEqual([
      "action",
      "new-pane",
      "--direction",
      "down",
    ]);
  });

  it("throws when split pane output has no pane id", async () => {
    mockExecSequence([{ stdout: "" }]);

    await expect(manager.splitPane("h")).rejects.toThrow(
      "Failed to get pane ID",
    );
  });

  it("closes, focuses, resizes, and zooms panes", async () => {
    mockExecSequence([
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
    ]);

    await manager.killPane();
    await manager.selectPane("terminal_1");
    await manager.resizePane("left", 5);
    await manager.zoomPane();

    expect(execCalls.map((call) => call.args)).toEqual([
      ["action", "close-pane"],
      ["action", "focus-pane-id", "terminal_1"],
      ["action", "resize", "--left", "+5"],
      ["action", "toggle-fullscreen"],
    ]);
  });

  it("formats negative resize adjustments", async () => {
    mockExecSequence([{ stdout: "" }]);

    await manager.resizePane("up", -3);

    expect(execCalls[0]?.args).toEqual(["action", "resize", "--up", "-3"]);
  });

  it("sends text and optionally submits Enter", async () => {
    mockExecSequence([{ stdout: "" }, { stdout: "" }, { stdout: "" }]);

    await manager.sendTextToPane("hello");
    await manager.sendTextToPane("run", { submit: true });

    expect(execCalls.map((call) => call.args)).toEqual([
      ["action", "write-chars", "hello"],
      ["action", "write-chars", "run"],
      ["action", "send-keys", "Enter"],
    ]);
  });

  it("parses tab-separated pane output", async () => {
    mockExecSequence([
      {
        stdout:
          "terminal_1\nterminal_2\tserver\tfocused=true\tfloating=true\nplugin_3\tlogs\tfocused=false\n",
      },
    ]);

    await expect(manager.listPanes()).resolves.toEqual([
      { id: "terminal_1", title: "", isFocused: false, isFloating: false },
      { id: "terminal_2", title: "server", isFocused: true, isFloating: true },
      { id: "plugin_3", title: "logs", isFocused: false, isFloating: false },
    ]);
  });

  it("parses JSON pane output", async () => {
    mockExecSequence([
      {
        stdout: JSON.stringify([
          { id: "terminal_1", title: "shell", is_focused: true },
          { id: "plugin_2", name: "status", is_floating: true },
        ]),
      },
    ]);

    await expect(manager.listPanes()).resolves.toEqual([
      { id: "terminal_1", title: "shell", isFocused: true, isFloating: false },
      { id: "plugin_2", title: "status", isFocused: false, isFloating: true },
    ]);
  });

  it("returns empty panes for no-session errors", async () => {
    const error = Object.assign(new Error("command failed"), {
      code: 1,
      stderr: "There is no active session!",
    });
    mockExecSequence([{ error }]);

    await expect(manager.listPanes()).resolves.toEqual([]);
  });

  it("creates and navigates tabs", async () => {
    mockExecSequence([
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "" },
    ]);

    await manager.createTab({ name: "tests", workingDirectory: "/tmp/repo" });
    await manager.nextTab();
    await manager.prevTab();
    await manager.killTab();
    await manager.selectTab(2);
    await manager.renameTab("server");

    expect(execCalls.map((call) => call.args)).toEqual([
      ["action", "new-tab", "--name", "tests", "--cwd", "/tmp/repo"],
      ["action", "go-to-next-tab"],
      ["action", "go-to-previous-tab"],
      ["action", "close-tab"],
      ["action", "go-to-tab", "2"],
      ["action", "rename-tab", "server"],
    ]);
    expect(execCalls[0]?.cwd).toBe("/tmp/repo");
  });

  it("parses zellij action list-tabs columnar output", async () => {
    // Real zellij 0.44.1 output: 'TAB_ID  POSITION  NAME'
    mockExecSequence([
      {
        stdout: "TAB_ID  POSITION  NAME\n0  0  main\n1  1  tests\n",
      },
    ]);

    // POSITION 0 → display index 1, POSITION 1 → display index 2
    await expect(manager.listTabs()).resolves.toEqual([
      { index: 1, name: "main", isActive: false },
      { index: 2, name: "tests", isActive: false },
    ]);
  });

  it("parses human-readable tab output", async () => {
    mockExecSequence([{ stdout: "1: main (active)\n2: tests\n" }]);

    await expect(manager.listTabs()).resolves.toEqual([
      { index: 1, name: "main", isActive: true },
      { index: 2, name: "tests", isActive: false },
    ]);
  });

  it("parses JSON tab output", async () => {
    mockExecSequence([
      {
        stdout: JSON.stringify([
          { index: 1, name: "main", active: true },
          { index: 2, title: "logs", is_active: false },
        ]),
      },
    ]);

    await expect(manager.listTabs()).resolves.toEqual([
      { index: 1, name: "main", isActive: true },
      { index: 2, name: "logs", isActive: false },
    ]);
  });

  it("returns active focus from current tab info and focused pane", async () => {
    mockExecSequence([
      { stdout: "name: main\n" },
      { stdout: "terminal_1\tone\nterminal_2\ttwo\tfocused=true\n" },
    ]);

    await expect(manager.getActiveFocus()).resolves.toEqual({
      tabName: "main",
      paneId: "terminal_2",
    });
  });

  it("returns undefined active focus when no focused pane exists", async () => {
    mockExecSequence([{ stdout: "name: main\n" }, { stdout: "terminal_1\tone\n" }]);

    await expect(manager.getActiveFocus()).resolves.toBeUndefined();
  });

  it("dumps focused pane screen content", async () => {
    mockExecSequence([{ stdout: "screen\ncontent\n" }]);

    await expect(manager.dumpScreen()).resolves.toBe("screen\ncontent\n");
    expect(execCalls[0]?.args).toEqual([
      "action",
      "dump-screen",
    ]);
  });

  it("returns an empty screen for no-session dump errors", async () => {
    const error = Object.assign(new Error("no sessions"), { code: 1 });
    mockExecSequence([{ error }]);

    await expect(manager.dumpScreen()).resolves.toBe("");
  });
});
