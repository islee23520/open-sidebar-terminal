import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import type * as nodePtyTypes from "../test/mocks/node-pty";
import type * as vscodeTypes from "../test/mocks/vscode";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { InstanceStore } from "../services/InstanceStore";
import { OutputChannelService } from "../services/OutputChannelService";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import { TerminalManager } from "../terminals/TerminalManager";
import { TreeSnapshot } from "../webview/sidebar/types";
import { OpenCodeTuiProvider } from "./OpenCodeTuiProvider";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);
await vi.importActual<typeof nodePtyTypes>("../test/mocks/node-pty");

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

vi.mock("node-pty", async () => {
  const actual = await vi.importActual("../test/mocks/node-pty");
  return actual;
});

describe("OpenCodeTuiProvider", () => {
  let terminalManager: TerminalManager;
  let captureManager: OutputCaptureManager;
  let provider: OpenCodeTuiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    OutputChannelService.resetInstance();
    terminalManager = new TerminalManager();
    captureManager = new OutputCaptureManager();
    vscode.workspace.workspaceFolders = undefined;
  });

  afterEach(() => {
    provider?.dispose();
    terminalManager.dispose();
    OutputChannelService.resetInstance();
  });

  function mockConfiguration(options?: {
    autoStartOnOpen?: boolean;
    enableHttpApi?: boolean;
    command?: string;
  }): void {
    const {
      autoStartOnOpen = false,
      enableHttpApi = false,
      command = "opencode -c",
    } = options ?? {};

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "autoStartOnOpen") {
          return autoStartOnOpen;
        }
        if (key === "enableHttpApi") {
          return enableHttpApi;
        }
        if (key === "command") {
          return command;
        }
        if (key === "httpTimeout") {
          return 5000;
        }
        if (key === "logLevel") {
          return "error";
        }
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);
  }

  function createProvider(options?: {
    instanceStore?: InstanceStore;
    tmuxSessionManager?: TmuxSessionManager;
  }): OpenCodeTuiProvider {
    const context = new vscode.ExtensionContext();
    return new OpenCodeTuiProvider(
      context as any,
      terminalManager,
      captureManager,
      options?.instanceStore,
      options?.tmuxSessionManager,
    );
  }

  function resolveProvider(target: OpenCodeTuiProvider) {
    const view = vscode.WebviewView() as any;
    target.resolveWebviewView(view, {} as any, {} as any);
    const messageHandler = vi.mocked(view.webview.onDidReceiveMessage).mock
      .calls[0]?.[0] as (message: any) => void;

    return { view, messageHandler };
  }

  async function flushAsyncStartup(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("routes switchSession messages through tmux session switching", () => {
    mockConfiguration();
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-b-instance",
        workspaceUri: "file:///workspaces/workspace-b",
      },
      runtime: { terminalKey: "workspace-b-instance", tmuxSessionId: "tmux-b" },
      state: "connected",
    });

    provider = createProvider({ instanceStore });
    const { messageHandler } = resolveProvider(provider);
    const switchSpy = vi
      .spyOn(provider, "switchToTmuxSession")
      .mockResolvedValue(undefined);

    messageHandler({ type: "switchSession", sessionId: "tmux-b" });

    expect(switchSpy).toHaveBeenCalledWith("tmux-b");
  });

  it("routes kill/create/native session messages to provider handlers", () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const killSpy = vi
      .spyOn(provider, "killTmuxSession")
      .mockResolvedValue(undefined);
    const createSpy = vi
      .spyOn(provider, "createTmuxSession")
      .mockResolvedValue(undefined);
    const nativeSpy = vi
      .spyOn(provider, "switchToNativeShell")
      .mockResolvedValue(undefined);

    messageHandler({ type: "killSession", sessionId: "tmux-k" });
    messageHandler({ type: "createTmuxSession" });
    messageHandler({ type: "switchNativeShell" });

    expect(killSpy).toHaveBeenCalledWith("tmux-k");
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(nativeSpy).toHaveBeenCalledTimes(1);
  });

  it("emits a populated treeSnapshot to the webview", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const snapshot: TreeSnapshot = {
      type: "treeSnapshot",
      sessions: [
        {
          id: "workspace-a",
          name: "workspace-a",
          workspace: "repo-a",
          isActive: true,
        },
      ],
      activeSessionId: "workspace-a",
    };
    const createTreeSnapshot = vi.fn().mockResolvedValue(snapshot);
    const tmuxSessionManager = {
      createTreeSnapshot,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const { view } = resolveProvider(provider);
    await flushAsyncStartup();

    expect(createTreeSnapshot).toHaveBeenCalledWith("opencode-main");
    expect(view.webview.postMessage).toHaveBeenCalledWith(snapshot);
  });

  it("emits treeSnapshot with active tmux session id when runtime has mapping", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-d-instance",
        workspaceUri: "file:///workspaces/workspace-d",
      },
      runtime: { terminalKey: "workspace-d-instance", tmuxSessionId: "tmux-d" },
      state: "connected",
    });
    const createTreeSnapshot = vi.fn().mockResolvedValue({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-sessions",
    } satisfies TreeSnapshot);
    const tmuxSessionManager = {
      createTreeSnapshot,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });
    resolveProvider(provider);
    await flushAsyncStartup();

    expect(createTreeSnapshot).toHaveBeenCalledWith("tmux-d");
  });

  it("emits explicit empty state snapshots from tmux manager", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const snapshot: TreeSnapshot = {
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-tmux",
    };
    const createTreeSnapshot = vi.fn().mockResolvedValue(snapshot);
    const tmuxSessionManager = {
      createTreeSnapshot,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const { view } = resolveProvider(provider);
    await flushAsyncStartup();

    expect(view.webview.postMessage).toHaveBeenCalledWith(snapshot);
  });

  it("emits a no-workspace empty state when no workspace context exists", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    vscode.workspace.workspaceFolders = undefined;
    const createTreeSnapshot = vi.fn().mockResolvedValue({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-sessions",
    } satisfies TreeSnapshot);
    const tmuxSessionManager = {
      createTreeSnapshot,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const { view } = resolveProvider(provider);
    await flushAsyncStartup();

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-workspace",
    });
  });

  it("filters treeSnapshot sessions to current workspace only", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    vscode.workspace.workspaceFolders = [
      {
        uri: {
          fsPath: "/workspaces/repo-a",
          toString: () => "file:///workspaces/repo-a",
        },
      },
    ] as any;

    const createTreeSnapshot = vi.fn().mockResolvedValue({
      type: "treeSnapshot",
      sessions: [
        { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
        { id: "repo-b", name: "repo-b", workspace: "repo-b", isActive: false },
      ],
      activeSessionId: "repo-a",
    } satisfies TreeSnapshot);
    const tmuxSessionManager = {
      createTreeSnapshot,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const { view } = resolveProvider(provider);
    await flushAsyncStartup();

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "treeSnapshot",
      sessions: [
        { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
      ],
      activeSessionId: "repo-a",
      emptyState: undefined,
    });
  });

  it("starts the default terminal path without sidebar tree interaction", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    provider = createProvider();
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    const { messageHandler } = resolveProvider(provider);

    messageHandler({ type: "ready", cols: 120, rows: 40 });
    await flushAsyncStartup();

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "opencode-main",
      "opencode -c",
      {},
      undefined,
      120,
      40,
      "opencode-main",
      expect.any(String),
    );
  });

  it("ensures and reuses a matching tmux workspace session on startup", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-a",
        workspaceUri: "file:///workspaces/repo-a",
      },
      runtime: { terminalKey: "workspace-a" },
      state: "connected",
    });
    const ensureSession = vi.fn().mockResolvedValue({
      action: "attached",
      session: {
        id: "repo-a-tmux",
        name: "repo-a-tmux",
        workspace: "repo-a",
        isActive: true,
      },
    });
    const tmuxSessionManager = {
      ensureSession,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    const { messageHandler } = resolveProvider(provider);

    messageHandler({ type: "ready", cols: 100, rows: 35 });
    await flushAsyncStartup();

    expect(ensureSession).toHaveBeenCalledWith("repo-a", "/workspaces/repo-a");
    expect(createTerminalSpy).toHaveBeenCalledWith(
      "workspace-a",
      "tmux attach-session -t repo-a-tmux",
      {},
      undefined,
      100,
      35,
      "workspace-a",
      "/workspaces/repo-a",
    );

    expect(instanceStore.get("workspace-a")?.runtime.tmuxSessionId).toBe(
      "repo-a-tmux",
    );
  });

  it("creates a workspace tmux session when none exists", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-b",
        workspaceUri: "file:///workspaces/repo-b",
      },
      runtime: { terminalKey: "workspace-b" },
      state: "connected",
    });
    const ensureSession = vi.fn().mockResolvedValue({
      action: "created",
      session: {
        id: "repo-b-tmux",
        name: "repo-b-tmux",
        workspace: "repo-b",
        isActive: true,
      },
    });
    const tmuxSessionManager = {
      ensureSession,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    const { messageHandler } = resolveProvider(provider);

    messageHandler({ type: "ready", cols: 120, rows: 40 });
    await flushAsyncStartup();

    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(ensureSession).toHaveBeenCalledWith("repo-b", "/workspaces/repo-b");
    expect(createTerminalSpy).toHaveBeenCalledWith(
      "workspace-b",
      "tmux attach-session -t repo-b-tmux",
      {},
      undefined,
      120,
      40,
      "workspace-b",
      "/workspaces/repo-b",
    );
    expect(instanceStore.get("workspace-b")?.runtime.tmuxSessionId).toBe(
      "repo-b-tmux",
    );
  });

  it("does not duplicate startup orchestration on repeated ready messages", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-c",
        workspaceUri: "file:///workspaces/repo-c",
      },
      runtime: { terminalKey: "workspace-c" },
      state: "connected",
    });
    const ensureSession = vi.fn().mockResolvedValue({
      action: "attached",
      session: {
        id: "repo-c",
        name: "repo-c",
        workspace: "repo-c",
        isActive: true,
      },
    });
    const tmuxSessionManager = {
      ensureSession,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    const { messageHandler } = resolveProvider(provider);

    messageHandler({ type: "ready", cols: 110, rows: 34 });
    await flushAsyncStartup();
    messageHandler({ type: "ready", cols: 110, rows: 34 });
    await flushAsyncStartup();

    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(createTerminalSpy).toHaveBeenCalledTimes(1);
  });

  it("attaches to existing tmux session when no workspace is open", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const ensureSession = vi.fn().mockResolvedValue({
      action: "attached",
      session: {
        id: "home",
        name: "home",
        workspace: "home",
        isActive: true,
      },
    });
    const discoverSessions = vi.fn().mockResolvedValue([
      {
        id: "shared-session",
        name: "shared-session",
        workspace: "shared",
        isActive: true,
      },
    ]);
    const tmuxSessionManager = {
      ensureSession,
      discoverSessions,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    const { messageHandler } = resolveProvider(provider);

    messageHandler({ type: "ready", cols: 96, rows: 28 });
    await flushAsyncStartup();

    expect(ensureSession).not.toHaveBeenCalled();
    expect(discoverSessions).toHaveBeenCalledTimes(1);
    expect(createTerminalSpy).toHaveBeenCalledWith(
      "opencode-main",
      "tmux attach-session -t shared-session",
      {},
      undefined,
      96,
      28,
      "opencode-main",
      os.homedir(),
    );
  });

  it("forces attach to the selected tmux session when switching tabs", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-z-instance",
        workspaceUri: "file:///workspaces/repo-z",
      },
      runtime: { terminalKey: "workspace-z-instance", tmuxSessionId: "old-z" },
      state: "connected",
    });

    const ensureSession = vi.fn().mockResolvedValue({
      action: "attached",
      session: {
        id: "repo-z",
        name: "repo-z",
        workspace: "repo-z",
        isActive: true,
      },
    });
    const tmuxSessionManager = {
      ensureSession,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToTmuxSession("target-z");
    await flushAsyncStartup();

    expect(ensureSession).not.toHaveBeenCalled();
    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    expect(lastCall?.[1]).toBe("tmux attach-session -t target-z");
    expect(lastCall?.[6]).toBe("workspace-z-instance");
  });

  it("switches to native shell explicitly when requested", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const ensureSession = vi.fn();
    const discoverSessions = vi.fn();
    const tmuxSessionManager = {
      ensureSession,
      discoverSessions,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToNativeShell();
    await flushAsyncStartup();

    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall?.[1]).toBe("opencode -c");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(discoverSessions).not.toHaveBeenCalled();
  });

  it("creates a new tmux session from tab action with collision-safe naming", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const discoverSessions = vi.fn().mockResolvedValue([
      { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: false },
      {
        id: "repo-a-2",
        name: "repo-a-2",
        workspace: "repo-a",
        isActive: false,
      },
    ]);
    const createSession = vi.fn().mockResolvedValue(undefined);
    const tmuxSessionManager = {
      discoverSessions,
      createSession,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    vscode.workspace.workspaceFolders = [
      {
        uri: {
          fsPath: "/workspaces/repo-a",
          toString: () => "file:///workspaces/repo-a",
        },
      },
    ] as any;

    await provider.createTmuxSession();
    await flushAsyncStartup();

    expect(createSession).toHaveBeenCalledWith(
      "repo-a-3",
      "/workspaces/repo-a",
    );
    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall?.[1]).toBe("tmux attach-session -t repo-a-3");
  });

  it("ignores treeSnapshot payloads in the provider message handler", () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const switchSpy = vi
      .spyOn(provider, "switchToInstance")
      .mockResolvedValue(undefined);
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();
    const snapshot: TreeSnapshot = {
      type: "treeSnapshot",
      sessions: [
        {
          id: "workspace-a",
          name: "workspace-a",
          workspace: "repo-a",
          isActive: true,
        },
      ],
      activeSessionId: "workspace-a",
    };

    messageHandler(snapshot as any);

    expect(switchSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("switches active instances without respawning when a terminal already exists", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: { id: "session-a" },
      runtime: { terminalKey: "session-a" },
      state: "connected",
    });
    instanceStore.upsert({
      config: { id: "session-b" },
      runtime: { terminalKey: "session-b" },
      state: "connected",
    });

    provider = createProvider({ instanceStore });
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();
    const resizeSpy = vi.spyOn(terminalManager, "resizeTerminal");
    terminalManager.createTerminal(
      "session-b",
      "opencode -c",
      {},
      undefined,
      undefined,
      undefined,
      "session-b",
    );

    const { view } = resolveProvider(provider);
    (provider as any).lastKnownCols = 90;
    (provider as any).lastKnownRows = 30;

    instanceStore.setActive("session-b");
    await Promise.resolve();

    expect((provider as any).activeInstanceId).toBe("session-b");
    expect(startSpy).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "clearTerminal",
    });
    expect(resizeSpy).toHaveBeenCalledWith("session-b", 90, 30);
  });

  it("switches active instances and spawns a new terminal when it does not exist", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: { id: "session-a" },
      runtime: { terminalKey: "session-a" },
      state: "connected",
    });
    instanceStore.upsert({
      config: { id: "session-c" },
      runtime: { terminalKey: "session-c" },
      state: "connected",
    });

    provider = createProvider({ instanceStore });
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();

    const { view } = resolveProvider(provider);

    instanceStore.setActive("session-c");
    await Promise.resolve();

    expect((provider as any).activeInstanceId).toBe("session-c");
    expect(startSpy).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "clearTerminal",
    });
  });
});
