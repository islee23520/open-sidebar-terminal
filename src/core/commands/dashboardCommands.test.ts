import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import type * as vscodeTypes from "../../test/mocks/vscode";
import type { DashboardCommandDependencies } from "./dashboardCommands";
import { registerDashboardCommands } from "./dashboardCommands";
import * as typesModule from "../../types";
import ts from "typescript";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import type { TmuxSessionManager } from "../../services/TmuxSessionManager";
import type { OutputChannelService } from "../../services/OutputChannelService";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../../test/mocks/vscode");
  return actual;
});

type CommandCallback = (...args: unknown[]) => unknown;

type ProviderMock = Pick<
  TerminalProvider,
  "toggleDashboard" | "toggleTmuxCommandToolbar"
>;

type TmuxManagerMock = Pick<TmuxSessionManager, "discoverSessions">;

type OutputChannelMock = Pick<OutputChannelService, "error">;

type WebviewLike = {
  postMessage: (message: unknown) => Promise<boolean>;
};

type DashboardInternals = typeof import("./dashboardCommands") & {
  openDashboardInEditor: (deps: DashboardCommandDependencies) => Promise<void>;
  updateDashboardWebview: (
    webview: WebviewLike,
    deps: DashboardCommandDependencies,
  ) => Promise<void>;
  getDashboardHtml: () => string;
  getNonce: () => string;
};

function loadDashboardInternals(): DashboardInternals {
  const sourcePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "./dashboardCommands.ts",
  );
  const virtualPath = `${sourcePath}.internal-test.ts`;
  const source =
    readFileSync(sourcePath, "utf8") +
    "\nexport { openDashboardInEditor, updateDashboardWebview, getDashboardHtml, getNonce };\n";

  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: virtualPath,
  });

  const runtimeModule: { exports: Record<string, unknown> } = { exports: {} };
  const sourceDir = dirname(sourcePath);
  const wrapper = new Script(
    `(function (require, module, exports, __filename, __dirname) {${outputText}\n})`,
    { filename: virtualPath },
  ).runInThisContext() as (
    require: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
    __filename: string,
    __dirname: string,
  ) => void;

  wrapper(
    (specifier: string) => {
      if (specifier === "vscode") {
        return vscode;
      }

      if (specifier === "../../types") {
        return typesModule;
      }

      throw new Error(`Unexpected dashboardCommands dependency: ${specifier}`);
    },
    runtimeModule,
    runtimeModule.exports,
    virtualPath,
    sourceDir,
  );

  return runtimeModule.exports as DashboardInternals;
}

const dashboardInternals = loadDashboardInternals();

function createProviderMock(): ProviderMock {
  return {
    toggleDashboard: vi.fn(),
    toggleTmuxCommandToolbar: vi.fn(),
  };
}

function createTmuxManagerMock(): TmuxManagerMock {
  return {
    discoverSessions: vi.fn(),
  };
}

function createOutputChannelMock(): OutputChannelMock {
  return {
    error: vi.fn(),
  };
}

function createDependencies(
  overrides: Partial<DashboardCommandDependencies> = {},
): DashboardCommandDependencies {
  return {
    provider: createProviderMock() as TerminalProvider,
    tmuxManager: createTmuxManagerMock() as TmuxSessionManager,
    instanceStore: undefined,
    outputChannel: createOutputChannelMock() as OutputChannelService,
    ...overrides,
  };
}

function getRegisteredCommand(id: string): CommandCallback {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([commandId]) => commandId === id);

  if (!call) {
    throw new Error(`Missing registered command: ${id}`);
  }

  return call[1] as CommandCallback;
}

function createPanelHarness() {
  let onDidReceiveMessage:
    | ((message: { type: string; sessionId?: string }) => Promise<void>)
    | undefined;
  let onDidChangeViewState: (() => void) | undefined;

  const webview = {
    options: {},
    html: "",
    postMessage: vi.fn(async () => true),
    onDidReceiveMessage: vi.fn(
      (
        listener: (message: {
          type: string;
          sessionId?: string;
        }) => Promise<void>,
      ) => {
        onDidReceiveMessage = listener;
        return { dispose: vi.fn() };
      },
    ),
    asWebviewUri: vi.fn((uri: unknown) => uri),
    cspSource: "",
  };

  const panel = {
    webview,
    visible: true,
    onDidChangeViewState: vi.fn((listener: () => void) => {
      onDidChangeViewState = listener;
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      void listener;
      return { dispose: vi.fn() };
    }),
    reveal: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    panel,
    webview,
    dispatchMessage: async (message: { type: string; sessionId?: string }) => {
      await onDidReceiveMessage?.(message);
    },
    fireViewStateChange: () => {
      onDidChangeViewState?.();
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("dashboardCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscode.workspace.workspaceFolders = undefined;
  });

  it("registers dashboard commands and safely handles provider presence", async () => {
    const deps = createDependencies();

    const disposables = registerDashboardCommands(deps);

    expect(disposables).toHaveLength(3);
    expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(3);

    getRegisteredCommand("opencodeTui.toggleDashboard")();
    expect(deps.provider?.toggleDashboard).toHaveBeenCalledTimes(1);

    getRegisteredCommand("opencodeTui.toggleTmuxCommandToolbar")();
    expect(deps.provider?.toggleTmuxCommandToolbar).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const harness = createPanelHarness();
    const noProviderDeps = createDependencies({ provider: undefined });
    vi.mocked(noProviderDeps.tmuxManager!.discoverSessions).mockResolvedValue(
      [],
    );
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
      harness.panel as never,
    );
    registerDashboardCommands(noProviderDeps);

    expect(() =>
      getRegisteredCommand("opencodeTui.toggleDashboard")(),
    ).not.toThrow();

    getRegisteredCommand("opencodeTui.openDashboardInEditor")();
    await flushAsyncWork();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it("shows an error when opening the dashboard editor without a tmux manager", async () => {
    registerDashboardCommands(createDependencies({ tmuxManager: undefined }));

    getRegisteredCommand("opencodeTui.openDashboardInEditor")();
    await flushAsyncWork();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Tmux session manager not available",
    );
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();

    vi.clearAllMocks();

    await dashboardInternals.openDashboardInEditor(
      createDependencies({ tmuxManager: undefined }),
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Tmux session manager not available",
    );
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("updates the dashboard webview with a workspace-derived session payload", async () => {
    const deps = createDependencies();
    vi.mocked(deps.tmuxManager!.discoverSessions).mockResolvedValue([
      {
        id: "tmux-1",
        name: "Alpha",
        workspace: "/workspace/demo",
        isActive: true,
      },
      {
        id: "tmux-2",
        name: "Beta",
        workspace: "/workspace/other",
        isActive: false,
      },
    ]);
    vscode.workspace.workspaceFolders = [
      {
        uri: { fsPath: "/Users/ilseoblee/workspace/tool/opencode-sidebar-tui" },
        name: "opencode-sidebar-tui",
        index: 0,
      },
    ] as typeof vscode.workspace.workspaceFolders;

    const webview = {
      postMessage: vi.fn(async () => true),
    } as WebviewLike;

    await dashboardInternals.updateDashboardWebview(webview, deps);

    expect(deps.tmuxManager?.discoverSessions).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "updateDashboard",
      workspace: "opencode-sidebar-tui",
      sessions: [
        {
          id: "tmux-1",
          name: "Alpha",
          workspace: "/workspace/demo",
          isActive: true,
        },
        {
          id: "tmux-2",
          name: "Beta",
          workspace: "/workspace/other",
          isActive: false,
        },
      ],
    });
  });

  it("handles missing tmux manager and update failures gracefully", async () => {
    const webview = {
      postMessage: vi.fn(async () => true),
    } as WebviewLike;

    await dashboardInternals.updateDashboardWebview(
      webview,
      createDependencies({ tmuxManager: undefined }),
    );
    expect(webview.postMessage).not.toHaveBeenCalled();

    const deps = createDependencies();
    vi.mocked(deps.tmuxManager!.discoverSessions).mockRejectedValue(
      new Error("cannot discover"),
    );

    await dashboardInternals.updateDashboardWebview(webview, deps);

    expect(deps.outputChannel?.error).toHaveBeenCalledWith(
      "[Dashboard] Failed to update: cannot discover",
    );

    vi.clearAllMocks();

    const harness = createPanelHarness();
    const actualDeps = createDependencies();
    vi.mocked(actualDeps.tmuxManager!.discoverSessions).mockRejectedValue(
      new Error("cannot discover"),
    );
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
      harness.panel as never,
    );

    registerDashboardCommands(actualDeps);
    getRegisteredCommand("opencodeTui.openDashboardInEditor")();
    await flushAsyncWork();

    expect(actualDeps.outputChannel?.error).toHaveBeenCalledWith(
      "[Dashboard] Failed to update: cannot discover",
    );
  });

  it("creates a dashboard editor webview and handles dashboard actions", async () => {
    const harness = createPanelHarness();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
      harness.panel as never,
    );

    const deps = createDependencies();
    vi.mocked(deps.tmuxManager!.discoverSessions).mockResolvedValue([
      {
        id: "s-1",
        name: "Primary",
        workspace: "/workspace/demo",
        isActive: true,
      },
    ]);

    registerDashboardCommands(deps);
    getRegisteredCommand("opencodeTui.openDashboardInEditor")();
    await flushAsyncWork();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "opencodeTui.dashboardEditor",
      "Terminal Managers",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    expect(harness.webview.html).toContain("Terminal Dashboard");
    expect(harness.webview.html).toContain("Workspace: -");
    expect(harness.webview.postMessage).toHaveBeenCalledWith({
      type: "updateDashboard",
      sessions: [
        {
          id: "s-1",
          name: "Primary",
          workspace: "/workspace/demo",
          isActive: true,
        },
      ],
      workspace: "No workspace",
    });

    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

    await harness.dispatchMessage({ type: "refresh" });
    await harness.dispatchMessage({ type: "activate", sessionId: "s-1" });
    await harness.dispatchMessage({ type: "activate" });
    await harness.dispatchMessage({ type: "killSession", sessionId: "s-1" });
    await harness.dispatchMessage({ type: "killSession" });
    await harness.dispatchMessage({ type: "create" });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.switchTmuxSession",
      "s-1",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.killTmuxSession",
      "s-1",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.createTmuxSession",
    );

    const postMessageCountAfterActions = vi.mocked(harness.webview.postMessage)
      .mock.calls.length;

    harness.panel.visible = false;
    harness.fireViewStateChange();
    await flushAsyncWork();
    expect(harness.webview.postMessage).toHaveBeenCalledTimes(
      postMessageCountAfterActions,
    );

    harness.panel.visible = true;
    harness.fireViewStateChange();
    await flushAsyncWork();
    expect(harness.webview.postMessage).toHaveBeenCalledTimes(
      postMessageCountAfterActions + 1,
    );
  });

  it("builds dashboard html with a nonce-backed CSP and generates valid nonces", () => {
    const nonce = dashboardInternals.getNonce();

    expect(nonce).toMatch(/^[A-Za-z0-9]{32}$/);

    const html = dashboardInternals.getDashboardHtml();
    const nonceMatches = Array.from(
      html.matchAll(
        /nonce-([A-Za-z0-9]{32})|<script nonce="([A-Za-z0-9]{32})">/g,
      ),
    );

    expect(html).toContain("default-src 'none'");
    expect(html).toContain('id="create"');
    expect(html).toContain('id="refresh"');
    expect(html).toContain('vscode.postMessage({ type: "refresh" });');
    expect(nonceMatches).toHaveLength(2);

    const extractedNonces = nonceMatches.map((match) => match[1] ?? match[2]);
    expect(extractedNonces[0]).toBeDefined();
    expect(extractedNonces[0]).toBe(extractedNonces[1]);
  });
});
