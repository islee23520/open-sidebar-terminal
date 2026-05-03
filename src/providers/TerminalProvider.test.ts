import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import type * as nodePtyTypes from "../test/mocks/node-pty";
import type * as vscodeTypes from "../test/mocks/vscode";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { InstanceStore } from "../services/InstanceStore";
import { OutputChannelService } from "../services/OutputChannelService";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import { PortManager } from "../services/PortManager";
import { TerminalManager } from "../terminals/TerminalManager";
import { TerminalProvider } from "./TerminalProvider";
import { DEFAULT_AI_TOOLS } from "../types";

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => "<html><body>{{CSP_SOURCE}}</body></html>"),
  },
  readFileSync: vi.fn(() => "<html><body>{{CSP_SOURCE}}</body></html>"),
}));

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

describe("TerminalProvider", () => {
  let terminalManager: TerminalManager;
  let captureManager: OutputCaptureManager;
  let provider: TerminalProvider;

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
    defaultAiTool?: string;
    aiTools?: readonly unknown[];
    nativeShellDefault?: string;
    tmuxSessionDefault?: string;
    collapseSecondaryBarOnEditorOpen?: boolean;
  }) {
    const {
      autoStartOnOpen = false,
      enableHttpApi = false,
      defaultAiTool = "opencode",
      aiTools = DEFAULT_AI_TOOLS,
      nativeShellDefault = "",
      tmuxSessionDefault = "",
      collapseSecondaryBarOnEditorOpen = false,
    } = options ?? {};

    const configuration = {
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "autoStartOnOpen") {
          return autoStartOnOpen;
        }
        if (key === "enableHttpApi") {
          return enableHttpApi;
        }
        if (key === "defaultAiTool") {
          return defaultAiTool;
        }
        if (key === "aiTools") {
          return aiTools;
        }
        if (key === "httpTimeout") {
          return 5000;
        }
        if (key === "logLevel") {
          return "error";
        }
        if (key === "nativeShellDefault") {
          return nativeShellDefault;
        }
        if (key === "tmuxSessionDefault") {
          return tmuxSessionDefault;
        }
        if (key === "collapseSecondaryBarOnEditorOpen") {
          return collapseSecondaryBarOnEditorOpen;
        }
        return defaultValue;
      }),
      update: vi.fn(),
    };

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      configuration as any,
    );

    return configuration;
  }

  function createProvider(options?: {
    instanceStore?: InstanceStore;
    tmuxSessionManager?: TmuxSessionManager;
  }): TerminalProvider {
    const context = new vscode.ExtensionContext();
    const portManager = new PortManager();
    return new TerminalProvider(
      context as any,
      terminalManager,
      captureManager,
      portManager,
      options?.instanceStore,
      options?.tmuxSessionManager,
    );
  }

  function resolveProvider(target: TerminalProvider) {
    const view = vscode.WebviewView() as any;
    target.resolveWebviewView(view, {} as any, {} as any);
    const messageHandler = vi.mocked(view.webview.onDidReceiveMessage).mock
      .calls[0]?.[0] as (message: any) => void;

    return { view, messageHandler };
  }

  async function flushAsyncStartup(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
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

  it("routes kill/create session messages to provider handlers", () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const killSpy = vi
      .spyOn(provider, "killTmuxSession")
      .mockResolvedValue(undefined);
    const createSpy = vi
      .spyOn(provider, "createTmuxSession")
      .mockResolvedValue(undefined);

    messageHandler({ type: "killSession", sessionId: "tmux-k" });
    messageHandler({ type: "createTmuxSession" });

    expect(killSpy).toHaveBeenCalledWith("tmux-k");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("routes launchAiTool messages through the provider launch path", async () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const launchSpy = vi.spyOn(provider, "launchAiTool").mockResolvedValue();

    messageHandler({
      type: "launchAiTool",
      sessionId: "tmux-a",
      tool: "codex",
      savePreference: true,
    });
    await Promise.resolve();

    expect(launchSpy).toHaveBeenCalledWith("tmux-a", "codex", true, undefined);
  });

  it("opens the AI tool selector for explicit manual requests", async () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const showSpy = vi
      .spyOn(provider, "showAiToolSelector")
      .mockResolvedValue(undefined);

    messageHandler({ type: "requestAiToolSelector" });
    await Promise.resolve();

    expect(showSpy).toHaveBeenCalledWith(
      "opencode-main",
      "opencode-main",
      true,
      undefined,
    );
  });

  it("routes zoomTmuxPane messages through the provider zoom path", async () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const zoomSpy = vi.spyOn(provider, "zoomTmuxPane").mockResolvedValue();

    messageHandler({ type: "zoomTmuxPane" });
    await Promise.resolve();

    expect(zoomSpy).toHaveBeenCalledTimes(1);
  });

  it("routes executeTmuxRawCommand messages through the provider raw tmux path", async () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const rawSpy = vi
      .spyOn(provider, "executeRawTmuxCommand")
      .mockResolvedValue("");

    messageHandler({
      type: "executeTmuxRawCommand",
      subcommand: "choose-tree",
    });
    await Promise.resolve();

    expect(rawSpy).toHaveBeenCalledWith("choose-tree", undefined);
  });

  it("opens the terminal renderer in an editor tab", async () => {
    mockConfiguration();
    provider = createProvider();
    resolveProvider(provider);

    await provider.openInEditorTab();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "opencodeTui.terminalEditor",
      "Open Sidebar Terminal",
      vscode.ViewColumn.Beside,
      expect.objectContaining({
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: expect.any(Array),
      }),
    );

    const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0]
      ?.value as any;
    expect(panel.webview.options).toEqual(
      expect.objectContaining({
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: expect.any(Array),
      }),
    );
    provider.focus();
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "focusTerminal",
    });
  });

  it("reinitializes a restored editor panel during deserialization", async () => {
    mockConfiguration();
    provider = createProvider();
    resolveProvider(provider);

    const restoredPanel = (vscode.window.createWebviewPanel as any)();
    restoredPanel.webview.cspSource = "default-src 'none'";

    await provider.deserializeWebviewPanel(restoredPanel, undefined);

    expect(restoredPanel.webview.html).toContain("default-src 'none'");
    expect(restoredPanel.webview.onDidReceiveMessage).toHaveBeenCalledTimes(1);
  });

  it("toggles from the sidebar into the editor panel", async () => {
    mockConfiguration();
    provider = createProvider();
    resolveProvider(provider);

    await provider.toggleEditorAttachment();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it("toggles from the editor panel back to the sidebar", async () => {
    mockConfiguration();
    provider = createProvider();
    const { view } = resolveProvider(provider);

    await provider.openInEditorTab();
    const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0]
      ?.value as any;
    const disposeListener = vi.mocked(panel.onDidDispose).mock.calls[0]?.[0] as
      | (() => void)
      | undefined;

    await provider.toggleEditorAttachment();
    disposeListener?.();

    expect(panel.dispose).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.view.extension.opencodeTuiContainer",
    );
    expect(view.show).toHaveBeenCalledWith(true);
  });

  it("starts the default AI tool directly for non-tmux sessions", async () => {
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
      os.homedir(),
    );
  });

  it("uses defaultAiTool config for non-tmux sessions", async () => {
    mockConfiguration({
      autoStartOnOpen: false,
      enableHttpApi: false,
      defaultAiTool: "codex",
    });
    provider = createProvider();
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    const { messageHandler } = resolveProvider(provider);

    messageHandler({ type: "ready", cols: 120, rows: 40 });
    await flushAsyncStartup();

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "opencode-main",
      "codex",
      {},
      undefined,
      120,
      40,
      "opencode-main",
      expect.any(String),
    );
  });

  it("launches the selected tmux AI tool and stores it on the mapped instance", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-codex",
        workspaceUri: "file:///workspaces/repo-codex",
      },
      runtime: { terminalKey: "workspace-codex", tmuxSessionId: "tmux-codex" },
      state: "connected",
    });
    const listPanes = vi
      .fn()
      .mockResolvedValue([{ paneId: "%1", isActive: true }]);
    const sendTextToPane = vi.fn().mockResolvedValue(undefined);
    const tmuxSessionManager = {
      listPanes,
      sendTextToPane,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });
    resolveProvider(provider);

    await provider.launchAiTool("tmux-codex", "codex", true);

    expect(sendTextToPane).toHaveBeenCalledWith("%1", "codex");
    expect(instanceStore.get("workspace-codex")?.config.selectedAiTool).toBe(
      "codex",
    );
  });

  it("formats editor references through the active tool operator", async () => {
    mockConfiguration({
      autoStartOnOpen: false,
      enableHttpApi: false,
      defaultAiTool: "codex",
    });
    provider = createProvider();
    resolveProvider(provider);

    const editor = {
      document: {
        uri: { fsPath: "/workspaces/repo-a/src/example.ts", path: "" },
      },
      selection: {
        isEmpty: false,
        start: { line: 4 },
        end: { line: 6 },
      },
    } as any;
    vi.mocked(vscode.workspace.asRelativePath).mockReturnValueOnce(
      "src/example.ts",
    );

    await provider.startOpenCode();

    expect(provider.formatEditorReference(editor)).toBe(
      "@src/example.ts#L5-L7",
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
      "tmux attach-session -t repo-a-tmux \\; set-option -u status off",
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
      "tmux attach-session -t repo-b-tmux \\; set-option -u status off",
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

  it("re-attaches to another workspace tmux session instead of creating a native shell fallback", async () => {
    mockConfiguration({
      autoStartOnOpen: false,
      enableHttpApi: false,
      nativeShellDefault: "shell",
    });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-fallback",
        workspaceUri: "file:///workspaces/repo-fallback",
      },
      runtime: {
        terminalKey: "workspace-fallback",
        tmuxSessionId: "repo-fallback-1",
      },
      state: "connected",
    });
    const setMouseOn = vi.fn().mockResolvedValue(undefined);
    const killSession = vi.fn().mockResolvedValue(undefined);
    const findSessionForWorkspace = vi.fn().mockResolvedValue({
      id: "repo-fallback-2",
      name: "repo-fallback-2",
      workspace: "repo-fallback",
      isActive: true,
    });
    const tmuxSessionManager = {
      setMouseOn,
      killSession,
      findSessionForWorkspace,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToTmuxSession("repo-fallback-1");
    await flushAsyncStartup();
    await provider.killTmuxSession("repo-fallback-1");
    await flushAsyncStartup();

    expect(killSession).toHaveBeenCalledWith("repo-fallback-1");
    expect(findSessionForWorkspace).toHaveBeenCalledWith(
      "/workspaces/repo-fallback",
    );
    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall?.[1]).toBe(
      "tmux attach-session -t repo-fallback-2 \\; set-option -u status off",
    );
    expect(instanceStore.get("workspace-fallback")?.runtime.tmuxSessionId).toBe(
      "repo-fallback-2",
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
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
      "tmux attach-session -t shared-session \\; set-option -u status off",
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
    expect(lastCall?.[1]).toBe(
      "tmux attach-session -t target-z \\; set-option -u status off",
    );
    expect(lastCall?.[6]).toBe("workspace-z-instance");
  });

  it("switches to native shell without showing a dialog", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const ensureSession = vi.fn();
    const discoverSessions = vi.fn().mockResolvedValue([]);
    const tmuxSessionManager = {
      ensureSession,
      discoverSessions,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToNativeShell();
    await flushAsyncStartup();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall?.[1]).toBeUndefined();
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("does not re-attach to tmux when switching to native shell in a workspace", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const ensureSession = vi.fn();
    const discoverSessions = vi.fn().mockResolvedValue([]);
    const tmuxSessionManager = {
      ensureSession,
      discoverSessions,
    } as unknown as TmuxSessionManager;

    vscode.workspace.workspaceFolders = [
      { uri: { fsPath: "/workspace/myproject" } },
    ] as any;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToNativeShell();
    await flushAsyncStartup();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall?.[1]).toBeUndefined();
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("switches to native shell with default zsh (no AI tool command)", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const tmuxSessionManager = {
      ensureSession: vi.fn(),
      discoverSessions: vi.fn(),
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToNativeShell();
    await flushAsyncStartup();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall?.[1]).toBeUndefined();
  });

  it("always proceeds with native shell switch regardless of any prior dialog state", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const tmuxSessionManager = {
      ensureSession: vi.fn(),
      discoverSessions: vi.fn(),
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToNativeShell();
    await flushAsyncStartup();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(createTerminalSpy).toHaveBeenCalled();
  });

  it("switches to native shell without a dialog even when defaultAiTool is set", async () => {
    mockConfiguration({
      autoStartOnOpen: false,
      enableHttpApi: false,
      defaultAiTool: "opencode",
    });
    const tmuxSessionManager = {
      ensureSession: vi.fn(),
      discoverSessions: vi.fn(),
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    await provider.switchToNativeShell();
    await flushAsyncStartup();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    const lastCall =
      createTerminalSpy.mock.calls[createTerminalSpy.mock.calls.length - 1];
    expect(lastCall?.[1]).toBeUndefined();
  });

  it("switches to native shell without showing a QuickPick or persisting any choice", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const tmuxSessionManager = {
      ensureSession: vi.fn(),
      discoverSessions: vi.fn(),
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    resolveProvider(provider);

    await provider.switchToNativeShell();
    await flushAsyncStartup();

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("creates a new tmux session and attaches the terminal immediately", async () => {
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

    const result = await provider.createTmuxSession();
    await flushAsyncStartup();

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      "repo-a-3",
      "/workspaces/repo-a",
    );
    expect(result).toBe("repo-a-3");
    expect(createTerminalSpy).toHaveBeenCalled();
  });

  it("creates a new tmux session and launches opencode when user picks opencode", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const discoverSessions = vi.fn().mockResolvedValue([]);
    const createSession = vi.fn().mockResolvedValue(undefined);
    const ensureSession = vi.fn().mockResolvedValue({
      action: "created",
      session: {
        id: "repo-b",
        name: "repo-b",
        workspace: "repo-b",
        isActive: true,
      },
    });
    const tmuxSessionManager = {
      discoverSessions,
      createSession,
      ensureSession,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    resolveProvider(provider);

    vscode.workspace.workspaceFolders = [
      {
        uri: {
          fsPath: "/workspaces/repo-b",
          toString: () => "file:///workspaces/repo-b",
        },
      },
    ] as any;

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "$(terminal) OpenCode",
      description: "Launch OpenCode in the terminal",
    } as any);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      undefined,
    );

    await provider.createTmuxSession();
    await flushAsyncStartup();

    expect(createSession).toHaveBeenCalledWith("repo-b", "/workspaces/repo-b");
    expect(createTerminalSpy).toHaveBeenCalled();
  });

  it("always creates the tmux session without showing a dialog", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const discoverSessions = vi.fn().mockResolvedValue([]);
    const createSession = vi.fn().mockResolvedValue(undefined);
    const tmuxSessionManager = {
      discoverSessions,
      createSession,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    resolveProvider(provider);

    vscode.workspace.workspaceFolders = [
      {
        uri: {
          fsPath: "/workspaces/repo-b",
          toString: () => "file:///workspaces/repo-b",
        },
      },
    ] as any;

    const result = await provider.createTmuxSession();

    expect(result).toBe("repo-b");
    expect(createSession).toHaveBeenCalledWith("repo-b", "/workspaces/repo-b");
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
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
      "opencode",
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

  it("normalizes workspace session ids when auto-launching a saved AI tool", () => {
    mockConfiguration({ defaultAiTool: "opencode" });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-saved-tool",
        workspaceUri: "file:///workspaces/repo-saved-tool",
        selectedAiTool: "codex",
      },
      runtime: {
        terminalKey: "workspace-saved-tool",
        tmuxSessionId: "tmux-saved-tool",
      },
      state: "connected",
    });

    provider = createProvider({ instanceStore });
    const launchSpy = vi.spyOn(provider, "launchAiTool").mockResolvedValue();

    provider.showAiToolSelector(
      "repo-saved-tool",
      "Repo Saved Tool",
      false,
      "%22",
    );

    expect(launchSpy).toHaveBeenCalledWith(
      "tmux-saved-tool",
      "codex",
      false,
      "%22",
    );
  });

  it("uses the configured default AI tool when no instance preference exists", () => {
    mockConfiguration({ defaultAiTool: "claude" });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-default-tool",
        workspaceUri: "file:///workspaces/repo-default-tool",
      },
      runtime: {
        terminalKey: "workspace-default-tool",
        tmuxSessionId: "tmux-default-tool",
      },
      state: "connected",
    });

    provider = createProvider({ instanceStore });
    const launchSpy = vi.spyOn(provider, "launchAiTool").mockResolvedValue();

    provider.showAiToolSelector("repo-default-tool", "Repo Default Tool");

    expect(launchSpy).toHaveBeenCalledWith(
      "tmux-default-tool",
      "claude",
      false,
      undefined,
    );
  });

  it("forces the AI tool selector to render even when a saved tool exists", () => {
    mockConfiguration({ defaultAiTool: "opencode" });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-force-show",
        workspaceUri: "file:///workspaces/repo-force-show",
        selectedAiTool: "codex",
      },
      runtime: {
        terminalKey: "workspace-force-show",
        tmuxSessionId: "tmux-force-show",
      },
      state: "connected",
    });

    provider = createProvider({ instanceStore });
    const launchSpy = vi.spyOn(provider, "launchAiTool").mockResolvedValue();
    const { view } = resolveProvider(provider);

    provider.showAiToolSelector(
      "repo-force-show",
      "Repo Force Show",
      true,
      "%9",
    );

    expect(launchSpy).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "showAiToolSelector",
      sessionId: "tmux-force-show",
      sessionName: "Repo Force Show",
      defaultTool: undefined,
      tools: DEFAULT_AI_TOOLS,
      targetPaneId: "%9",
    });
  });

  it("launches AI tools against the normalized tmux session and active pane", async () => {
    const configuration = mockConfiguration();
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-launch",
        workspaceUri: "file:///workspaces/repo-launch",
      },
      runtime: {
        terminalKey: "workspace-launch",
        tmuxSessionId: "tmux-launch",
      },
      state: "connected",
    });
    const listPanes = vi.fn().mockResolvedValue([
      { paneId: "%1", isActive: false },
      { paneId: "%2", isActive: true },
    ]);
    const sendTextToPane = vi.fn().mockResolvedValue(undefined);
    const tmuxSessionManager = {
      listPanes,
      sendTextToPane,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });

    await provider.launchAiTool("repo-launch", "codex", true);

    expect(configuration.update).toHaveBeenCalledWith(
      "defaultAiTool",
      "codex",
      vscode.ConfigurationTarget.Global,
    );
    expect(listPanes).toHaveBeenCalledWith("tmux-launch", {
      activeWindowOnly: true,
    });
    expect(sendTextToPane).toHaveBeenCalledWith("%2", "codex");
    expect(instanceStore.get("workspace-launch")?.config.selectedAiTool).toBe(
      "codex",
    );
  });

  it("uses the provided pane id and original session id when no tmux mapping exists", async () => {
    mockConfiguration();
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: {
        id: "workspace-direct-pane",
        workspaceUri: "file:///workspaces/repo-direct-pane",
      },
      runtime: {
        terminalKey: "workspace-direct-pane",
      },
      state: "connected",
    });
    const listPanes = vi.fn();
    const sendTextToPane = vi.fn().mockResolvedValue(undefined);
    const tmuxSessionManager = {
      listPanes,
      sendTextToPane,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ instanceStore, tmuxSessionManager });

    await provider.launchAiTool("repo-direct-pane", "opencode", false, "%77");

    expect(listPanes).not.toHaveBeenCalled();
    expect(sendTextToPane).toHaveBeenCalledWith("%77", "opencode -c");
    expect(
      instanceStore.get("workspace-direct-pane")?.config.selectedAiTool,
    ).toBe("opencode");
  });

  it("saves the tool preference even when tmux is unavailable", async () => {
    const configuration = mockConfiguration();
    provider = createProvider();

    await provider.launchAiTool("repo-no-tmux", "claude", true);

    expect(configuration.update).toHaveBeenCalledWith(
      "defaultAiTool",
      "claude",
      vscode.ConfigurationTarget.Global,
    );
  });

  it("returns early when the requested AI tool is not configured", async () => {
    const configuration = mockConfiguration();
    const listPanes = vi.fn();
    const sendTextToPane = vi.fn();
    const tmuxSessionManager = {
      listPanes,
      sendTextToPane,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });

    await provider.launchAiTool("repo-missing-tool", "missing-tool", true);

    expect(configuration.update).toHaveBeenCalledWith(
      "defaultAiTool",
      "missing-tool",
      vscode.ConfigurationTarget.Global,
    );
    expect(listPanes).not.toHaveBeenCalled();
    expect(sendTextToPane).not.toHaveBeenCalled();
  });

  it("warns when no tmux pane can be resolved for AI tool launch", async () => {
    mockConfiguration();
    const listPanes = vi.fn().mockResolvedValue([]);
    const sendTextToPane = vi.fn();
    const tmuxSessionManager = {
      listPanes,
      sendTextToPane,
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const warnSpy = vi.spyOn((provider as any).logger, "warn");

    await provider.launchAiTool("repo-no-pane", "codex", false);

    expect(sendTextToPane).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("launchAiTool skipped: no target pane"),
    );
  });

  it("warns when tmux commands fail during AI tool launch", async () => {
    mockConfiguration();
    const tmuxSessionManager = {
      listPanes: vi.fn().mockRejectedValue(new Error("tmux unavailable")),
      sendTextToPane: vi.fn(),
    } as unknown as TmuxSessionManager;

    provider = createProvider({ tmuxSessionManager });
    const warnSpy = vi.spyOn((provider as any).logger, "warn");

    await provider.launchAiTool("repo-launch-error", "codex", false);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to launch AI tool: tmux unavailable"),
    );
  });

  it("sends prompts through the HTTP client when available", async () => {
    mockConfiguration();
    provider = createProvider();
    const appendPrompt = vi.fn().mockResolvedValue(undefined);
    const runtime = (provider as any).sessionRuntime;

    vi.spyOn(runtime, "getApiClient").mockReturnValue({ appendPrompt } as any);
    vi.spyOn(runtime, "isHttpAvailable").mockReturnValue(true);
    const writeSpy = vi.spyOn(terminalManager, "writeToTerminal");

    await provider.sendPrompt("hello via http");

    expect(appendPrompt).toHaveBeenCalledWith("hello via http");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("falls back to terminal writes when the HTTP prompt append fails", async () => {
    mockConfiguration();
    provider = createProvider();
    const appendPrompt = vi.fn().mockRejectedValue(new Error("network down"));
    const runtime = (provider as any).sessionRuntime;

    vi.spyOn(runtime, "getApiClient").mockReturnValue({ appendPrompt } as any);
    vi.spyOn(runtime, "isHttpAvailable").mockReturnValue(true);
    const writeSpy = vi.spyOn(terminalManager, "writeToTerminal");
    const warnSpy = vi.spyOn((provider as any).logger, "warn");

    await provider.sendPrompt("hello fallback");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "HTTP API send failed, falling back to terminal write: network down",
      ),
    );
    expect(writeSpy).toHaveBeenCalledWith("opencode-main", "hello fallback");
  });

  it("resets stale runtime state and starts immediately when a visible webview opens", () => {
    mockConfiguration({ autoStartOnOpen: true });
    provider = createProvider();
    const runtime = (provider as any).sessionRuntime;

    vi.spyOn(runtime, "hasLiveTerminalProcess").mockReturnValue(false);
    vi.spyOn(runtime, "isStartedFlag")
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const resetStateSpy = vi.spyOn(runtime, "resetState");
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();

    resolveProvider(provider);

    expect(resetStateSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("waits for visibility before auto-starting hidden webviews", () => {
    mockConfiguration({ autoStartOnOpen: true });
    provider = createProvider();
    const view = vscode.WebviewView() as any;
    view.visible = false;
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();

    provider.resolveWebviewView(view, {} as any, {} as any);

    expect(startSpy).not.toHaveBeenCalled();

    const visibilityListener = vi.mocked(view.onDidChangeVisibility).mock
      .calls[0]?.[0] as () => void;
    view.visible = true;
    visibilityListener();

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "webviewVisible",
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("opens the terminal renderer in an editor tab and locks its editor group", async () => {
    mockConfiguration();
    provider = createProvider();
    resolveProvider(provider);

    await provider.openInEditorTab();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "opencodeTui.terminalEditor",
      "Open Sidebar Terminal",
      vscode.ViewColumn.Beside,
      expect.any(Object),
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.lockEditorGroup",
    );
  });

  it("closes the sidebar when opening the editor tab and collapse-on-open is enabled", async () => {
    mockConfiguration({ collapseSecondaryBarOnEditorOpen: true });
    provider = createProvider();
    resolveProvider(provider);

    await provider.openInEditorTab();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.closeAuxiliaryBar",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.closeSidebar",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.lockEditorGroup",
    );
  });

  it("closes the sidebars before creating the editor panel to avoid layout race", async () => {
    mockConfiguration({ collapseSecondaryBarOnEditorOpen: true });
    provider = createProvider();
    resolveProvider(provider);

    await provider.openInEditorTab();

    const executeCalls = vi.mocked(vscode.commands.executeCommand).mock.calls;
    const executeOrders = vi.mocked(vscode.commands.executeCommand).mock
      .invocationCallOrder;

    const closeAuxIdx = executeCalls.findIndex(
      (args) => args[0] === "workbench.action.closeAuxiliaryBar",
    );
    const closeSidebarIdx = executeCalls.findIndex(
      (args) => args[0] === "workbench.action.closeSidebar",
    );
    const createOrder = vi.mocked(vscode.window.createWebviewPanel).mock
      .invocationCallOrder[0];

    expect(executeOrders[closeAuxIdx]).toBeLessThan(createOrder);
    expect(executeOrders[closeSidebarIdx]).toBeLessThan(createOrder);
  });

  it("keeps the sidebar open when opening the editor tab and collapse-on-open is disabled", async () => {
    mockConfiguration({ collapseSecondaryBarOnEditorOpen: false });
    provider = createProvider();
    resolveProvider(provider);

    await provider.openInEditorTab();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.action.closeAuxiliaryBar",
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.action.closeSidebar",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.lockEditorGroup",
    );
  });

  it("reuses an existing editor panel instead of creating another one", async () => {
    mockConfiguration();
    provider = createProvider();
    resolveProvider(provider);

    await provider.openInEditorTab();
    const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0]
      ?.value as any;
    const focusSpy = vi.spyOn(provider, "focus");

    await provider.openInEditorTab();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Active);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.lockEditorGroup",
    );
  });

  it("replays the active session state to the editor panel so the toolbar stays visible", async () => {
    mockConfiguration();
    provider = createProvider();
    const runtime = (provider as any).sessionRuntime;
    vi.spyOn(runtime, "getSelectedTmuxSessionId").mockReturnValue(
      "tmux-selected",
    );
    vi.spyOn(runtime, "resolveTmuxSessionIdForInstance").mockReturnValue(
      undefined,
    );
    resolveProvider(provider);

    await provider.openInEditorTab();

    const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0]
      ?.value as any;
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "activeSession",
      sessionName: "tmux-selected",
      sessionId: "tmux-selected",
      backend: "tmux",
    });
  });

  it("executes the dashboard command when toggling the dashboard", () => {
    mockConfiguration();
    provider = createProvider();

    provider.toggleDashboard();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.openTerminalManager",
    );
  });

  it("posts a webview message when toggling the tmux command toolbar", () => {
    mockConfiguration();
    provider = createProvider();
    const runtime = (provider as any).sessionRuntime;
    vi.spyOn(runtime, "getSelectedTmuxSessionId").mockReturnValue(
      "tmux-selected",
    );
    const { view } = resolveProvider(provider);

    provider.toggleTmuxCommandToolbar();

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "toggleTmuxCommandToolbar",
    });
  });

  it("posts a webview message when the active instance has a tmux session", () => {
    mockConfiguration();
    provider = createProvider();
    const runtime = (provider as any).sessionRuntime;
    vi.spyOn(runtime, "getSelectedTmuxSessionId").mockReturnValue(undefined);
    vi.spyOn(runtime, "resolveTmuxSessionIdForInstance").mockReturnValue(
      "tmux-active",
    );
    const { view } = resolveProvider(provider);

    provider.toggleTmuxCommandToolbar();

    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "toggleTmuxCommandToolbar",
    });
  });

  it("does not post a webview message when no tmux session is attached", () => {
    mockConfiguration();
    provider = createProvider();
    const runtime = (provider as any).sessionRuntime;
    vi.spyOn(runtime, "getSelectedTmuxSessionId").mockReturnValue(undefined);
    vi.spyOn(runtime, "resolveTmuxSessionIdForInstance").mockReturnValue(
      undefined,
    );
    const { view } = resolveProvider(provider);

    provider.toggleTmuxCommandToolbar();

    expect(view.webview.postMessage).not.toHaveBeenCalledWith({
      type: "toggleTmuxCommandToolbar",
    });
  });

  it("delegates public runtime wrapper methods to SessionRuntime", async () => {
    mockConfiguration();
    provider = createProvider();
    const runtime = (provider as any).sessionRuntime;
    const apiClient = { appendPrompt: vi.fn() };
    const fileReference = "@src/example.ts#L1-L3";

    vi.spyOn(runtime, "getApiClient").mockReturnValue(apiClient as any);
    vi.spyOn(runtime, "isHttpAvailable").mockReturnValue(true);
    const restartSpy = vi
      .spyOn(runtime, "restart")
      .mockImplementation(() => {});
    const switchToInstanceSpy = vi
      .spyOn(runtime, "switchToInstance")
      .mockResolvedValue(undefined);
    const switchToTmuxSpy = vi
      .spyOn(runtime, "switchToTmuxSession")
      .mockResolvedValue(undefined);
    vi.spyOn(runtime, "resolveInstanceIdFromSessionId").mockReturnValue(
      "workspace-wrapper",
    );
    const switchToNativeSpy = vi
      .spyOn(runtime, "switchToNativeShell")
      .mockResolvedValue(undefined);
    vi.spyOn(runtime, "createTmuxSession").mockResolvedValue("tmux-wrapper");
    const killSessionSpy = vi
      .spyOn(runtime, "killTmuxSession")
      .mockResolvedValue(undefined);
    vi.spyOn(runtime, "getSelectedTmuxSessionId").mockReturnValue(
      "tmux-selected",
    );
    const zoomSpy = vi
      .spyOn(runtime, "zoomTmuxPane")
      .mockResolvedValue(undefined);
    vi.spyOn(runtime, "formatFileReference").mockReturnValue(fileReference);

    expect(provider.getApiClient()).toBe(apiClient);
    expect(provider.isHttpAvailable()).toBe(true);

    provider.restart();
    expect(restartSpy).toHaveBeenCalledTimes(1);

    await provider.switchToInstance("workspace-wrapper", {
      forceRestart: true,
    });
    expect(switchToInstanceSpy).toHaveBeenCalledWith("workspace-wrapper", {
      forceRestart: true,
    });

    await provider.switchToTmuxSession("tmux-wrapper");
    expect(switchToTmuxSpy).toHaveBeenCalledWith("tmux-wrapper");

    expect(provider.resolveInstanceIdFromSessionId("repo-wrapper")).toBe(
      "workspace-wrapper",
    );

    await provider.switchToNativeShell();
    expect(switchToNativeSpy).toHaveBeenCalledTimes(1);

    await expect(provider.createTmuxSession()).resolves.toBe("tmux-wrapper");

    await provider.killTmuxSession("tmux-wrapper");
    expect(killSessionSpy).toHaveBeenCalledWith("tmux-wrapper");

    expect(provider.getSelectedTmuxSessionId()).toBe("tmux-selected");

    await provider.zoomTmuxPane();
    expect(zoomSpy).toHaveBeenCalledTimes(1);

    expect(provider.formatFileReference({ path: "src/example.ts" })).toBe(
      fileReference,
    );

    const rawTmuxManager = {
      executeRawCommand: vi.fn(async () => "raw-result"),
    } as unknown as TmuxSessionManager;
    const activeStore = new InstanceStore();
    activeStore.upsert({
      config: {
        id: "workspace-raw",
        workspaceUri: "file:///workspaces/raw",
      },
      runtime: { terminalKey: "workspace-raw", tmuxSessionId: "tmux-active" },
      state: "connected",
    });
    activeStore.setActive("workspace-raw");
    provider = createProvider({
      instanceStore: activeStore,
      tmuxSessionManager: rawTmuxManager,
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(
      "renamed-session",
    );

    await expect(
      provider.executeRawTmuxCommand("rename-session"),
    ).resolves.toBe("raw-result");
    expect(rawTmuxManager.executeRawCommand).toHaveBeenCalledWith(
      "tmux-active",
      "rename-session",
      ["renamed-session"],
    );
  });

  it("formats URI references, posts clipboard content, and tracks terminal size", () => {
    mockConfiguration();
    provider = createProvider();
    const formatSpy = vi
      .spyOn(provider, "formatFileReference")
      .mockReturnValue("@src/from-uri.ts");
    const { view } = resolveProvider(provider);

    expect(
      provider.formatUriReference({
        fsPath: "/workspaces/repo-a/src/from-uri.ts",
        path: "/workspaces/repo-a/src/from-uri.ts",
      } as any),
    ).toBe("@src/from-uri.ts");
    expect(formatSpy).toHaveBeenCalledWith({
      path: "/workspaces/repo-a/src/from-uri.ts",
    });

    provider.pasteText("clipboard payload");
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "clipboardContent",
      text: "clipboard payload",
    });

    provider.requestPaste();
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "requestPaste",
    });

    provider.lastKnownCols = 132;
    provider.lastKnownRows = 44;

    expect(provider.lastKnownCols).toBe(132);
    expect(provider.lastKnownRows).toBe(44);
  });
});
