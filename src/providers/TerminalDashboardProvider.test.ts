import * as fs from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscodeTypes from "../test/mocks/vscode";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import { TerminalDashboardProvider } from "./TerminalDashboardProvider";

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => "<html><body>{{CSP_SOURCE}}</body></html>"),
  },
  readFileSync: vi.fn(() => "<html><body>{{CSP_SOURCE}}</body></html>"),
}));

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

/**
 * Tests for the TerminalDashboardProvider class.
 */
describe("TerminalDashboardProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscode.workspace.workspaceFolders = [
      {
        uri: {
          fsPath: "/workspaces/repo-a",
        },
      },
    ];
  });

  /**
   * Flushes the promise queue to ensure all async operations are completed.
   */
  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  /**
   * Creates an instance of TerminalDashboardProvider with mocked dependencies.
   */
  function createProvider(options?: {
    discoverSessions?: ReturnType<typeof vi.fn>;
    listPanes?: ReturnType<typeof vi.fn>;
    listWindows?: ReturnType<typeof vi.fn>;
    listWindowPaneGeometry?: ReturnType<typeof vi.fn>;
    instanceStore?: {
      getAll: ReturnType<typeof vi.fn>;
      getActive?: ReturnType<typeof vi.fn>;
      get?: ReturnType<typeof vi.fn>;
      upsert?: ReturnType<typeof vi.fn>;
      setActive?: ReturnType<typeof vi.fn>;
    };
    terminalProvider?: {
      showAiToolSelector: ReturnType<typeof vi.fn>;
      launchAiTool: ReturnType<typeof vi.fn>;
    };
    logger?: {
      debug: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  }) {
    const discoverSessions =
      options?.discoverSessions ?? vi.fn().mockResolvedValue([]);
    const listPanes = options?.listPanes ?? vi.fn().mockResolvedValue([]);
    const listWindows = options?.listWindows ?? vi.fn().mockResolvedValue([]);
    const listWindowPaneGeometry =
      options?.listWindowPaneGeometry ?? vi.fn().mockResolvedValue([]);
    const instanceStore = options?.instanceStore;
    const terminalProvider = options?.terminalProvider;
    const logger =
      options?.logger ??
      ({
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as const);
    const context = new vscode.ExtensionContext();
    const onPaneChangedEvent = new vscode.EventEmitter<void>();
    const tmuxSessionManager = {
      discoverSessions,
      listPanes,
      listWindows,
      listWindowPaneGeometry,
      selectPane: vi.fn().mockResolvedValue(undefined),
      splitPane: vi.fn().mockResolvedValue("%8"),
      createWindow: vi.fn().mockResolvedValue({ windowId: "@1", paneId: "%8" }),
      captureSessionPreview: vi.fn().mockResolvedValue(""),
      nextWindow: vi.fn().mockResolvedValue(undefined),
      prevWindow: vi.fn().mockResolvedValue(undefined),
      killWindow: vi.fn().mockResolvedValue(undefined),
      selectWindow: vi.fn().mockResolvedValue(undefined),
      killPane: vi.fn().mockResolvedValue(undefined),
      resizePane: vi.fn().mockResolvedValue(undefined),
      swapPanes: vi.fn().mockResolvedValue(undefined),
      listPaneDtos: vi.fn().mockResolvedValue([]),
      onPaneChanged: onPaneChangedEvent.event,
    } as unknown as TmuxSessionManager;

    return {
      discoverSessions,
      listPanes,
      listWindows,
      listWindowPaneGeometry,
      logger,
      instanceStore,
      terminalProvider,
      onPaneChangedEvent,
      tmuxSessionManager,
      provider: new TerminalDashboardProvider(
        context as never,
        tmuxSessionManager,
        logger as never,
        instanceStore as never,
        terminalProvider as never,
      ),
    };
  }

  /**
   * Resolves the webview view for the provider and returns the view and message handler.
   */
  function resolveProvider(provider: TerminalDashboardProvider) {
    const view = vscode.WebviewView();
    provider.resolveWebviewView(view as never, {} as never, {} as never);
    const messageCalls = vi.mocked(view.webview.onDidReceiveMessage).mock
      .calls as unknown[][];
    const messageHandler = (messageCalls[0]?.[0] ??
      (() =>
        Promise.reject(new Error("missing message handler")))) as unknown as (
      message: unknown,
    ) => Promise<void>;

    return { view, messageHandler };
  }

  function showProvider(provider: TerminalDashboardProvider) {
    const panel = {
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        postMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: { path?: string; fsPath?: string }) => ({
          toString: () => uri.path ?? uri.fsPath ?? "",
        })),
        cspSource: "",
      },
      visible: true,
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      reveal: vi.fn(),
      dispose: vi.fn(),
    };
    vi.mocked(vscode.window.createWebviewPanel).mockImplementationOnce(
      () => panel as never,
    );
    provider.show();
    const messageCalls = vi.mocked(panel.webview.onDidReceiveMessage).mock
      .calls as unknown[][];
    const messageHandler = (messageCalls[0]?.[0] ??
      (() =>
        Promise.reject(new Error("missing message handler")))) as unknown as (
      message: unknown,
    ) => Promise<void>;

    return { panel, messageHandler };
  }

  /**
   * Verifies that only sessions matching the current workspace are posted to the webview.
   */
  it("posts workspace-filtered tmux sessions to the dashboard webview", async () => {
    const { provider } = createProvider({
      discoverSessions: vi.fn().mockResolvedValue([
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
      ]),
    });

    const { view } = resolveProvider(provider);
    await flushPromises();

    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateTmuxSessions",
        workspace: "repo-a",
        sessions: [
          {
            id: "repo-a",
            name: "repo-a",
            workspace: "repo-a",
            isActive: true,
            paneCount: 0,
          },
        ],
        nativeShells: [],
        panes: {
          "repo-a": [],
        },
        windows: {
          "repo-a": [],
        },
      }),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "opencode",
            label: "OpenCode",
            args: ["-c"],
          }),
          expect.objectContaining({
            name: "claude",
            label: "Claude Code",
          }),
          expect.objectContaining({
            name: "codex",
            label: "Codex",
          }),
        ]),
      }),
    );
  });

  /**
   * Verifies that webview actions trigger the correct VS Code commands and refresh the session list.
   */
  it("routes activate/create/native actions through commands and refreshes", async () => {
    const { provider, discoverSessions } = createProvider({
      discoverSessions: vi.fn().mockResolvedValue([
        {
          id: "repo-a",
          name: "repo-a",
          workspace: "repo-a",
          isActive: false,
        },
      ]),
    });

    const { view, messageHandler } = resolveProvider(provider);
    await flushPromises();
    vi.mocked(view.webview.postMessage).mockClear();

    await messageHandler({ action: "activate", sessionId: "repo-a" });
    await messageHandler({ action: "create" });
    await messageHandler({ action: "switchNativeShell" });
    await flushPromises();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.switchTmuxSession",
      "repo-a",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.createTmuxSession",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.switchNativeShell",
    );
    expect(discoverSessions).toHaveBeenCalledTimes(4);
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateTmuxSessions",
        workspace: "repo-a",
        sessions: [
          {
            id: "repo-a",
            name: "repo-a",
            workspace: "repo-a",
            isActive: false,
            paneCount: 0,
          },
        ],
        nativeShells: [],
        panes: {
          "repo-a": [],
        },
        windows: {
          "repo-a": [],
        },
      }),
    );
  });

  /**
   * Verifies that the refresh action triggers a session discovery.
   */
  it("refreshes sessions when the refresh action is received", async () => {
    const { provider, discoverSessions } = createProvider();
    const { view, messageHandler } = resolveProvider(provider);
    await flushPromises();
    vi.mocked(view.webview.postMessage).mockClear();

    await messageHandler({ action: "refresh" });

    expect(discoverSessions).toHaveBeenCalledTimes(2);
    expect(view.webview.postMessage).toHaveBeenCalledTimes(1);
  });

  it("passes the pane window id when switching panes from another window", async () => {
    const { provider, tmuxSessionManager } = createProvider({
      discoverSessions: vi.fn().mockResolvedValue([
        {
          id: "repo-a",
          name: "repo-a",
          workspace: "repo-a",
          isActive: true,
        },
      ]),
    });
    const selectPane = vi.mocked(tmuxSessionManager.selectPane);
    const { messageHandler } = resolveProvider(provider);
    await flushPromises();

    await messageHandler({
      action: "switchPane",
      sessionId: "repo-a",
      paneId: "%3",
      windowId: "@2",
    });

    expect(selectPane).toHaveBeenCalledWith("%3", "@2");
  });

  it("uses the active pane cwd when splitting from the dashboard", async () => {
    const discoverSessions = vi.fn().mockResolvedValue([
      {
        id: "repo-a",
        name: "repo-a",
        workspace: "repo-a",
        isActive: true,
      },
    ]);
    const listPanes = vi.fn().mockResolvedValue([
      {
        paneId: "%7",
        index: 0,
        title: "shell",
        isActive: true,
        currentPath: "/workspaces/repo-a/packages/app",
      },
    ]);
    const listWindows = vi.fn().mockResolvedValue([]);
    const { provider, tmuxSessionManager } = createProvider({
      discoverSessions,
      listPanes,
      listWindows,
    });
    const splitPane = vi.mocked(tmuxSessionManager.splitPane);
    splitPane.mockResolvedValue("%8");
    const { messageHandler } = resolveProvider(provider);
    await flushPromises();

    await messageHandler({
      action: "splitPane",
      sessionId: "repo-a",
      direction: "h",
    });

    expect(splitPane).toHaveBeenCalledWith("%7", "h", {
      workingDirectory: "/workspaces/repo-a/packages/app",
    });
  });

  it("opens the AI tool selector only when the dashboard sends an explicit action", async () => {
    const { provider } = createProvider({
      discoverSessions: vi
        .fn()
        .mockResolvedValue([
          { id: "repo-a", name: "Repo A", workspace: "repo-a", isActive: true },
        ]),
      listPanes: vi.fn().mockResolvedValue([
        {
          paneId: "%1",
          index: 0,
          title: "active",
          isActive: true,
          currentPath: "/workspaces/repo-a",
        },
      ]),
    });
    const showSpy = vi.spyOn(provider, "showAiToolSelector");

    const { view, messageHandler } = resolveProvider(provider);
    await flushPromises();
    vi.mocked(view.webview.postMessage).mockClear();

    await messageHandler({
      action: "showAiToolSelector",
      sessionId: "repo-a",
      sessionName: "Repo A",
    });

    expect(showSpy).toHaveBeenCalledWith("repo-a", "Repo A", true, "%1");
    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "showAiToolSelector",
        sessionId: "repo-a",
      }),
    );
  });

  it("does not auto-open the AI tool selector after dashboard create, createWindow, or splitPane actions", async () => {
    const discoverSessions = vi
      .fn()
      .mockResolvedValue([
        { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
      ]);
    const listPanes = vi.fn().mockResolvedValue([
      {
        paneId: "%7",
        index: 0,
        title: "shell",
        isActive: true,
        currentPath: "/workspaces/repo-a/packages/app",
      },
    ]);
    const { provider, tmuxSessionManager } = createProvider({
      discoverSessions,
      listPanes,
      listWindows: vi.fn().mockResolvedValue([]),
    });

    const { view, messageHandler } = resolveProvider(provider);
    await flushPromises();
    vi.mocked(view.webview.postMessage).mockClear();

    await messageHandler({ action: "create" });
    await flushPromises();
    await messageHandler({ action: "createWindow", sessionId: "repo-a" });
    await flushPromises();
    await messageHandler({
      action: "splitPane",
      sessionId: "repo-a",
      direction: "h",
    });
    await flushPromises();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.createTmuxSession",
    );
    expect(vi.mocked(tmuxSessionManager.createWindow)).toHaveBeenCalledWith(
      "repo-a",
      "/workspaces/repo-a/packages/app",
    );
    expect(vi.mocked(tmuxSessionManager.splitPane)).toHaveBeenCalledWith(
      "%7",
      "h",
      {
        workingDirectory: "/workspaces/repo-a/packages/app",
      },
    );
    expect(view.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "showAiToolSelector" }),
    );
  });

  it("opens the dashboard as a webview panel and reveals existing panel", async () => {
    const { provider } = createProvider();

    provider.show();
    provider.show();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "opencodeTui.terminalDashboard",
      "Terminal Manager",
      {
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Beside,
      },
      expect.objectContaining({
        enableScripts: true,
        retainContextWhenHidden: true,
      }),
    );

    const panel = vi.mocked(vscode.window.createWebviewPanel).mock.results[0]
      ?.value as ReturnType<typeof vscode.window.createWebviewPanel>;

    expect(panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Beside, true);
  });

  it("posts workspace-filtered tmux sessions to the panel webview", async () => {
    const { provider } = createProvider({
      discoverSessions: vi.fn().mockResolvedValue([
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
      ]),
    });

    const { panel } = showProvider(provider);
    await flushPromises();

    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateTmuxSessions",
        workspace: "repo-a",
        sessions: [
          {
            id: "repo-a",
            name: "repo-a",
            workspace: "repo-a",
            isActive: true,
            paneCount: 0,
          },
        ],
      }),
    );
  });

  it("renders versioned dashboard html and replaces template placeholders", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        "{{CSP_SOURCE}}",
        "{{NONCE}}",
        "{{SCRIPT_URI}}",
        "{{CSS_URI}}",
        "{{HTML_VERSION}}",
      ].join("|"),
    );
    const { provider } = createProvider();

    const { view } = resolveProvider(provider);

    expect(view.webview.html).toContain("default-src 'none'");
    expect(view.webview.html).toContain("?v=16");
    expect(view.webview.html).toContain("16");
    expect(view.webview.html).not.toContain("{{SCRIPT_URI}}");
    expect(view.webview.html).not.toContain("{{CSS_URI}}");
    expect(view.webview.html).not.toContain("{{NONCE}}");
    expect(fs.readFileSync).toHaveBeenCalledWith(
      "/test/extension/dist/dashboard.html",
      "utf-8",
    );
  });

  it("queues failed webview updates and flushes them when the view becomes visible again", async () => {
    const discoverSessions = vi
      .fn()
      .mockResolvedValueOnce([
        { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
      ])
      .mockResolvedValueOnce([
        { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
        { id: "repo-b", name: "repo-b", workspace: "repo-b", isActive: false },
      ])
      .mockResolvedValueOnce([
        { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
        { id: "repo-b", name: "repo-b", workspace: "repo-b", isActive: false },
      ]);
    const { provider, logger } = createProvider({ discoverSessions });

    const { view, messageHandler } = resolveProvider(provider);
    await flushPromises();

    vi.mocked(view.webview.postMessage)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await messageHandler({ action: "toggleScope" });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("postMessage returned false"),
    );

    const visibilityHandler = vi.mocked(view.onDidChangeVisibility).mock
      .calls[0]?.[0] as () => void;
    view.visible = true;
    visibilityHandler();
    await flushPromises();

    expect(vi.mocked(view.webview.postMessage)).toHaveBeenCalledTimes(2);
    expect(discoverSessions).toHaveBeenCalledTimes(3);
  });

  it("falls back to an unavailable payload when session discovery fails", async () => {
    const { provider, logger } = createProvider({
      discoverSessions: vi.fn().mockRejectedValue(new Error("tmux down")),
    });

    const { view } = resolveProvider(provider);
    await flushPromises();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load tmux sessions: tmux down"),
    );
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "updateTmuxSessions",
      sessions: [],
      workspace: "Unavailable",
      panes: {},
    });
  });

  it("refreshes when pane changes are emitted by tmux", async () => {
    const { provider, discoverSessions, onPaneChangedEvent } = createProvider({
      discoverSessions: vi
        .fn()
        .mockResolvedValue([
          { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
        ]),
    });

    resolveProvider(provider);
    await flushPromises();
    expect(discoverSessions).toHaveBeenCalledTimes(1);

    onPaneChangedEvent.fire();
    await flushPromises();

    expect(discoverSessions).toHaveBeenCalledTimes(2);
  });

  it("creates, activates, filters, and kills native shells through the dashboard", async () => {
    const instanceStore = {
      getAll: vi
        .fn()
        .mockReturnValueOnce([
          {
            config: {
              id: "shell-1",
              label: "Shell 1",
              workspaceUri: "file:///workspaces/repo-a",
            },
            runtime: {},
            state: "connected",
          },
          {
            config: {
              id: "tmux-1",
              label: "tmux",
              workspaceUri: "file:///workspaces/repo-a",
            },
            runtime: { tmuxSessionId: "repo-a" },
            state: "connected",
          },
        ])
        .mockReturnValue([
          {
            config: {
              id: "shell-1",
              label: "Shell 1",
              workspaceUri: "file:///workspaces/repo-a",
            },
            runtime: {},
            state: "connected",
          },
          {
            config: {
              id: "shell-2",
              label: "Shell 2",
              workspaceUri: "file:///workspaces/repo-b",
            },
            runtime: {},
            state: "disconnected",
          },
          {
            config: {
              id: "tmux-1",
              label: "tmux",
              workspaceUri: "file:///workspaces/repo-a",
            },
            runtime: { tmuxSessionId: "repo-a" },
            state: "connected",
          },
        ]),
      getActive: vi.fn().mockReturnValue({
        config: { id: "shell-1" },
      }),
      get: vi.fn(),
      upsert: vi.fn(),
      setActive: vi.fn(),
    };
    const { provider } = createProvider({
      discoverSessions: vi
        .fn()
        .mockResolvedValue([
          { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
        ]),
      instanceStore,
    });

    const { view, messageHandler } = resolveProvider(provider);
    await flushPromises();

    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeShells: [
          {
            id: "shell-1",
            label: "Shell 1",
            state: "connected",
            isActive: true,
          },
        ],
      }),
    );

    await messageHandler({ action: "createNativeShell" });
    await messageHandler({
      action: "activateNativeShell",
      instanceId: "shell-1",
    });
    await messageHandler({ action: "killNativeShell", instanceId: "shell-1" });

    expect(instanceStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          label: expect.stringMatching(/^Shell \d+$/),
          workspaceUri: "file:///workspaces/repo-a",
        }),
        runtime: {},
        state: "disconnected",
      }),
    );
    expect(instanceStore.setActive).toHaveBeenCalledWith("shell-1");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.killNativeShell",
      "shell-1",
    );
  });

  it("silently refreshes when activating a missing native shell instance throws", async () => {
    const instanceStore = {
      getAll: vi.fn().mockReturnValue([]),
      getActive: vi.fn().mockReturnValue(undefined),
      get: vi.fn(),
      upsert: vi.fn(),
      setActive: vi.fn().mockImplementation(() => {
        throw new Error("missing");
      }),
    };
    const { provider } = createProvider({
      discoverSessions: vi.fn().mockResolvedValue([]),
      instanceStore,
    });

    const { messageHandler } = resolveProvider(provider);
    await flushPromises();
    vi.mocked(vscode.commands.executeCommand).mockClear();

    await messageHandler({
      action: "activateNativeShell",
      instanceId: "missing",
    });

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "opencodeTui.switchNativeShell",
    );
  });

  it("routes pane, window, and AI launch actions through tmux and terminal services", async () => {
    const terminalProvider = {
      showAiToolSelector: vi.fn(),
      launchAiTool: vi.fn().mockResolvedValue(undefined),
    };
    const listPanes = vi.fn().mockResolvedValue([
      {
        paneId: "%1",
        index: 0,
        title: "shell",
        isActive: true,
        currentPath: "/workspaces/repo-a",
      },
    ]);
    const { provider, tmuxSessionManager } = createProvider({
      discoverSessions: vi
        .fn()
        .mockResolvedValue([
          { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: true },
        ]),
      listPanes,
      terminalProvider,
    });

    const { messageHandler } = resolveProvider(provider);
    await flushPromises();

    await messageHandler({ action: "createWindow", sessionId: "repo-a" });
    await messageHandler({ action: "nextWindow", sessionId: "repo-a" });
    await messageHandler({ action: "prevWindow", sessionId: "repo-a" });
    await messageHandler({
      action: "killWindow",
      sessionId: "repo-a",
      windowId: "@9",
    });
    await messageHandler({
      action: "selectWindow",
      sessionId: "repo-a",
      windowId: "@2",
    });
    await messageHandler({
      action: "splitPaneWithCommand",
      sessionId: "repo-a",
      paneId: "%1",
      direction: "v",
      command: "npm test",
    });
    await messageHandler({
      action: "killPane",
      sessionId: "repo-a",
      paneId: "%2",
    });
    await messageHandler({
      action: "resizePane",
      sessionId: "repo-a",
      paneId: "%2",
      direction: "L",
      amount: 5,
    });
    await messageHandler({
      action: "swapPane",
      sessionId: "repo-a",
      sourcePaneId: "%1",
      targetPaneId: "%2",
    });
    await messageHandler({
      action: "launchAiTool",
      sessionId: "repo-a",
      tool: "claude",
      savePreference: true,
    });

    expect(vi.mocked(tmuxSessionManager.createWindow)).toHaveBeenCalledWith(
      "repo-a",
      "/workspaces/repo-a",
    );
    expect(vi.mocked(tmuxSessionManager.nextWindow)).toHaveBeenCalledWith(
      "repo-a",
    );
    expect(vi.mocked(tmuxSessionManager.prevWindow)).toHaveBeenCalledWith(
      "repo-a",
    );
    expect(vi.mocked(tmuxSessionManager.killWindow)).toHaveBeenCalledWith("@9");
    expect(vi.mocked(tmuxSessionManager.selectWindow)).toHaveBeenCalledWith(
      "@2",
    );
    expect(vi.mocked(tmuxSessionManager.splitPane)).toHaveBeenCalledWith(
      "%1",
      "v",
      {
        command: "npm test",
        workingDirectory: "/workspaces/repo-a",
      },
    );
    expect(vi.mocked(tmuxSessionManager.killPane)).toHaveBeenCalledWith("%2");
    expect(vi.mocked(tmuxSessionManager.resizePane)).toHaveBeenCalledWith(
      "%2",
      "L",
      5,
    );
    expect(vi.mocked(tmuxSessionManager.swapPanes)).toHaveBeenCalledWith(
      "%1",
      "%2",
    );
    expect(terminalProvider.launchAiTool).toHaveBeenCalledWith(
      "repo-a",
      "claude",
      true,
      undefined,
    );
  });

  it("uses the active pane target when opening the AI selector and falls back gracefully on pane lookup errors", async () => {
    const showAiToolSelector = vi.fn();
    const terminalProvider = {
      showAiToolSelector,
      launchAiTool: vi.fn(),
    };
    const listPanes = vi
      .fn()
      .mockResolvedValueOnce([
        {
          paneId: "%9",
          index: 1,
          title: "active",
          isActive: true,
          currentPath: "/workspaces/repo-a",
        },
      ])
      .mockRejectedValueOnce(new Error("no panes"));
    const { provider } = createProvider({
      discoverSessions: vi
        .fn()
        .mockResolvedValue([
          { id: "repo-a", name: "Repo A", workspace: "repo-a", isActive: true },
        ]),
      listPanes,
      terminalProvider,
    });

    const { messageHandler } = resolveProvider(provider);
    await flushPromises();

    await messageHandler({
      action: "showAiToolSelector",
      sessionId: "repo-a",
      sessionName: "Repo A",
    });
    await messageHandler({
      action: "showAiToolSelector",
      sessionId: "repo-a",
      sessionName: "Repo A",
    });

    expect(showAiToolSelector).toHaveBeenNthCalledWith(
      1,
      "repo-a",
      "Repo A",
      true,
      "%9",
    );
    expect(showAiToolSelector).toHaveBeenNthCalledWith(
      2,
      "repo-a",
      "Repo A",
      true,
      undefined,
    );
  });

  it("delegates AI selector display directly to TerminalProvider when available", async () => {
    const terminalProvider = {
      showAiToolSelector: vi.fn(),
      launchAiTool: vi.fn(),
    };
    const { provider } = createProvider({ terminalProvider });

    await provider.showAiToolSelector("repo-a", "Repo A", true, "%1");

    expect(terminalProvider.showAiToolSelector).toHaveBeenCalledWith(
      "repo-a",
      "Repo A",
      true,
      "%1",
    );
  });

  it("suppresses selector posting for saved tools and posts choices when no default exists", async () => {
    const configurationGet = vi.fn((key: string, defaultValue?: unknown) => {
      if (key === "defaultAiTool") return "claude";
      return defaultValue;
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: configurationGet,
      inspect: vi.fn(() => undefined),
      update: vi.fn(),
    } as never);
    const instanceStore = {
      getAll: vi
        .fn()
        .mockReturnValueOnce([
          {
            config: { id: "inst-1" },
            runtime: { tmuxSessionId: "repo-a" },
            state: "connected",
          },
        ])
        .mockReturnValue([]),
      getActive: vi.fn().mockReturnValue(undefined),
      get: vi.fn().mockReturnValue({ config: { selectedAiTool: "codex" } }),
      upsert: vi.fn(),
      setActive: vi.fn(),
    };
    const { provider } = createProvider({ instanceStore });

    const { view } = resolveProvider(provider);
    await flushPromises();
    vi.mocked(view.webview.postMessage).mockClear();

    await provider.showAiToolSelector("repo-a", "Repo A", false, "%7");
    await provider.showAiToolSelector("repo-b", "Repo B", false, "%8");

    expect(view.webview.postMessage).not.toHaveBeenCalled();

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "defaultAiTool") return "";
        return defaultValue;
      }),
      inspect: vi.fn(() => undefined),
      update: vi.fn(),
    } as never);
    instanceStore.getAll.mockReturnValue([]);
    instanceStore.get.mockReturnValue(undefined);

    await provider.showAiToolSelector("repo-c", "Repo C", false, "%9");

    expect(view.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "showAiToolSelector",
        sessionId: "repo-c",
        targetPaneId: "%9",
      }),
    );
  });

  it("logs AI tool launch failures without throwing", async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const terminalProvider = {
      showAiToolSelector: vi.fn(),
      launchAiTool: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const { provider } = createProvider({ logger, terminalProvider });

    const { messageHandler } = resolveProvider(provider);
    await flushPromises();

    await messageHandler({
      action: "launchAiTool",
      sessionId: "repo-a",
      tool: "claude",
      savePreference: false,
      targetPaneId: "%3",
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to launch AI tool: boom"),
    );
  });

  it("selects the next workspace session after killing the active tmux session", async () => {
    const discoverSessions = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "repo-a-1",
          name: "repo-a-1",
          workspace: "repo-a",
          isActive: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "repo-a-1",
          name: "repo-a-1",
          workspace: "repo-a",
          isActive: true,
        },
        {
          id: "repo-a-2",
          name: "repo-a-2",
          workspace: "repo-a",
          isActive: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "repo-a-2",
          name: "repo-a-2",
          workspace: "repo-a",
          isActive: true,
        },
      ])
      .mockResolvedValue([
        {
          id: "repo-a-2",
          name: "repo-a-2",
          workspace: "repo-a",
          isActive: true,
        },
      ]);
    const { provider } = createProvider({ discoverSessions });

    await (
      provider as unknown as {
        handleWebviewMessage: (message: unknown) => Promise<void>;
      }
    ).handleWebviewMessage({ action: "killSession", sessionId: "repo-a-1" });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.killTmuxSession",
      "repo-a-1",
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      2,
      "opencodeTui.switchTmuxSession",
      expect.any(String),
    );
  });

  it("handles no-op, expand, reveal, and dispose flows safely", async () => {
    vi.useFakeTimers();
    const { provider, discoverSessions } = createProvider({
      discoverSessions: vi.fn().mockResolvedValue([]),
    });

    const { panel, messageHandler } = showProvider(provider);
    await flushPromises();
    vi.mocked(panel.reveal).mockClear();

    await messageHandler(undefined);
    await messageHandler({ action: "expandPanes", sessionId: "repo-a" });

    vi.advanceTimersByTime(3000);
    await flushPromises();

    provider.reveal();
    provider.dispose();
    provider.dispose();

    expect(discoverSessions).toHaveBeenCalledTimes(3);
    expect(panel.reveal).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
