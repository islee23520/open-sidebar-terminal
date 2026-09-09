import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "../test/mocks/vscode";
import {
  HerdrNotInstalledError,
  HerdrServerDownError,
  HerdrUnsupportedVersionError,
} from "../herdr/errors";
import { HerdrAttachBusyError } from "../herdr/HerdrAttachController";
import { HerdrInvocationResolver } from "../herdr/HerdrInvocationResolver";
import type { HerdrAgent, HerdrInvocation } from "../herdr/types";
import type { TerminalTransport } from "../terminals/TerminalTransport";
import { TerminalManager } from "../terminals/TerminalManager";
import { ExtensionLifecycle } from "./ExtensionLifecycle";
import { readFileSync } from "node:fs";

vi.mock("node-pty", async () => vi.importActual("../test/mocks/node-pty"));

// Herdr listeners fire explorer refreshes without awaiting them; drain the
// resulting microtasks (and their logging) before the next test or teardown.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function createContext() {
  return {
    extensionUri: vscode.Uri.file("/extension"),
    subscriptions: [] as vscode.Disposable[],
  };
}

function commandHandler<T extends (...args: never[]) => unknown>(id: string): T {
  const handlers = vscode.commands.registerCommand.mock.calls as readonly [
    string,
    (...args: never[]) => unknown,
  ][];
  const handler = handlers.find(([commandId]) => commandId === id)?.[1];
  expect(handler).toBeDefined();
  return handler as T;
}

function agent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    paneId: "pane-1",
    terminalId: "terminal-1",
    agent: "claude",
    status: "running",
    title: "Agent one",
    cwd: "/workspace/one",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function createHerdrHarness(options: {
  agents?: readonly HerdrAgent[];
  workspaces?: readonly {
    readonly workspaceId: string;
    readonly label: string;
    readonly status: string;
    readonly paneCount: number;
  }[];
  versionError?: Error;
  listError?: Error;
  attachError?: Error;
  herdrEnabled?: boolean;
  phase?: "shell" | "attaching" | "attached" | "detaching" | "error";
  explorerPollMs?: number;
} = {}) {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace/one") }];
  vscode.setConfiguration({
    "ulw.herdr.enabled": options.herdrEnabled ?? true,
  });
  const sourceStateEmitter = new vscode.EventEmitter<never>();
  const createdControllers: Array<{
    sourceState: { source: string; phase: string };
    onSourceState: typeof sourceStateEmitter.event;
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const controller = {
    get sourceState() {
      const latest = createdControllers[createdControllers.length - 1];
      return latest?.sourceState ?? {
        source: options.phase === "shell" || options.phase === undefined ? "shell" : "herdr",
        phase: options.phase ?? "shell",
      };
    },
    onSourceState: sourceStateEmitter.event,
    attach: vi.fn(async (_target?: unknown, _dimensions?: unknown) => {
      if (options.attachError) {
        throw options.attachError;
      }
    }),
    detach: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const client = {
    versionCheck: vi.fn(async () => {
      if (options.versionError) {
        throw options.versionError;
      }
      return { version: "0.8.2" };
    }),
    listAgents: vi.fn(async () => {
      if (options.listError) {
        throw options.listError;
      }
      return options.agents ?? [];
    }),
    listWorkspaces: vi.fn(async () => options.workspaces ?? []),
  };
  const lifecycle = new ExtensionLifecycle({
    explorerPollMs: options.explorerPollMs ?? 0,
    createCliClient: () => client,
    createAttachController: () => {
      const next = {
        sourceState: {
          source: options.phase === "shell" || options.phase === undefined ? "shell" : "herdr",
          phase: options.phase ?? "shell",
        },
        onSourceState: sourceStateEmitter.event,
        attach: vi.fn(async (target: unknown, dimensions: unknown) => {
          await controller.attach(target, dimensions);
        }),
        detach: vi.fn(async () => {
          await controller.detach();
        }),
        dispose: vi.fn(() => {
          controller.dispose();
        }),
      };
      createdControllers.push(next);
      return next as never;
    },
    createControlTransport: () => ({}) as TerminalTransport,
  });
  return { lifecycle, client, controller };
}

describe("ExtensionLifecycle", () => {
  it("Open DAG enables a disabled sidebar and reveals the container", async () => {
    vscode.resetMocks();
    const { lifecycle } = createHerdrHarness();
    vscode.setConfiguration({ "ulw.sidebar.enabled": false });
    const api = lifecycle.activate(createContext() as never);
    await api.refreshExplorer();
    vscode.commands.executeCommand.mockClear();
    await commandHandler<() => Promise<void>>("ulw.herdr.openDag")();
    expect(vscode.workspace.getConfiguration("ulw").get("sidebar.enabled")).toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.view.extension.ulwContainer");
    lifecycle.dispose();
  });

  it("keeps management actions available without agents and detaches only the active controller", async () => {
    vscode.resetMocks();
    const { lifecycle, controller } = createHerdrHarness({ phase: "attached" });
    const api = lifecycle.activate(createContext() as never);
    await api.refreshExplorer();
    await api.attachToHerdr({ terminalId: "qa-agent" });
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Detach Active Agent", action: "detach" });
    await commandHandler<() => Promise<void>>("ulw.herdr.showMenu")();
    expect(controller.detach).toHaveBeenCalledOnce();
    expect(vscode.window.showQuickPick.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "attach" }), expect.objectContaining({ action: "refresh" }), expect.objectContaining({ action: "dag" }),
    ]));
    lifecycle.dispose();
  });

  it("shows and disposes the Herdr status entry only while enabled", async () => {
    vscode.resetMocks();
    const { lifecycle } = createHerdrHarness({ herdrEnabled: false });
    lifecycle.activate(createContext() as never);
    const item = vscode.window.createStatusBarItem.mock.results[0]?.value;
    expect(item).toBeDefined();
    expect(item?.show).not.toHaveBeenCalled();
    vscode.setConfiguration({ "ulw.herdr.enabled": true });
    vscode.fireConfigurationChange("ulw.herdr.enabled");
    expect(item?.show).toHaveBeenCalled();
    expect(item?.command).toBe("ulw.herdr.showMenu");
    vscode.setConfiguration({ "ulw.herdr.enabled": false });
    vscode.fireConfigurationChange("ulw.herdr.enabled");
    expect(item?.hide).toHaveBeenCalled();
    lifecycle.dispose();
    expect(item?.dispose).toHaveBeenCalledOnce();
  });

  it("selects agents from management into separate editor tabs and refreshes", async () => {
    vscode.resetMocks();
    const first = agent();
    const second = agent({ terminalId: "terminal-2", title: "Agent two" });
    const { lifecycle, client, controller } = createHerdrHarness({ agents: [first, second] });
    const api = lifecycle.activate(createContext() as never);
    await api.refreshExplorer();
    const menu = commandHandler<() => Promise<void>>("ulw.herdr.showMenu");
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: first.title, agent: first });
    await menu();
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: second.title, agent: second });
    await menu();
    expect(controller.attach).toHaveBeenCalledWith(expect.objectContaining({ terminalId: "terminal-2" }), expect.anything());
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
    const before = client.listWorkspaces.mock.calls.length;
    vscode.window.showQuickPick.mockResolvedValueOnce({ label: "Refresh", action: "refresh" });
    await menu();
    expect(client.listWorkspaces.mock.calls.length).toBeGreaterThan(before);
    lifecycle.dispose();
  });

  it("ignores a management selection after Herdr is disabled", async () => {
    vscode.resetMocks();
    const { lifecycle, controller } = createHerdrHarness({ agents: [agent()] });
    const api = lifecycle.activate(createContext() as never);
    await api.refreshExplorer();
    vscode.window.showQuickPick.mockImplementationOnce(async () => {
      vscode.setConfiguration({ "ulw.herdr.enabled": false });
      vscode.fireConfigurationChange("ulw.herdr.enabled");
      return { label: "Agent one", agent: agent() };
    });
    await commandHandler<() => Promise<void>>("ulw.herdr.showMenu")();
    expect(controller.attach).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("keeps the existing secondary sidebar visible for DAG mode", async () => {
    vscode.resetMocks();
    const { lifecycle } = createHerdrHarness();
    const api = lifecycle.activate(createContext() as never);
    await api.refreshExplorer();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.closeAuxiliaryBar");
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.contributes.viewsContainers.secondarySidebar[0].when).toBe("config.ulw.sidebar.enabled");
    expect(manifest.contributes.views.ulwContainer[0].when).toBe("config.ulw.sidebar.enabled");
    lifecycle.dispose();
  });

  it("registers exactly one secondary-sidebar provider", () => {
    vscode.resetMocks();
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();

    lifecycle.activate(context as never);

    expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledOnce();
    expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
      "ulw",
      expect.anything(),
    );
    expect(context.subscriptions).toEqual([lifecycle]);
  });

  it("exposes terminal events and delegates API operations", () => {
    vscode.resetMocks();
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();
    const api = lifecycle.activate(context as never);
    const manager = lifecycle["terminalManager"] as TerminalManager;
    const start = vi.fn();
    const data = vi.fn();
    const exit = vi.fn();
    api.onTerminalStart(start);
    api.onTerminalData(data);
    api.onTerminalExit(exit);
    const write = vi.spyOn(manager, "write");

    manager["startEmitter"].fire({ id: "sidebar-shell", pid: 42 });
    manager["dataEmitter"].fire({ id: "sidebar-shell", data: "hello", replay: "append" });
    manager["exitEmitter"].fire({ id: "sidebar-shell", code: 3, reason: "process-exit" });
    api.writeToTerminal("pwd\r");

    expect(start).toHaveBeenCalledWith(42);
    expect(data).toHaveBeenCalledWith("hello");
    expect(exit).toHaveBeenCalledWith(3);
    expect(write).toHaveBeenCalledWith("sidebar-shell", "pwd\r");
    expect(api.isTerminalRunning()).toBe(false);
    expect(api.terminalCount()).toBe(0);

    lifecycle.dispose();
    expect(lifecycle["terminalManager"]).toBeUndefined();
    expect(lifecycle["provider"]).toBeUndefined();
  });

  it("opens the terminal in the editor group when toggled", () => {
    vscode.resetMocks();
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();
    lifecycle.activate(context as never);

    lifecycle.toggleEditorLocation();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "ulw.terminalEditor",
      "ULW Terminal",
      expect.anything(),
      expect.objectContaining({ enableScripts: true }),
    );
  });

  it("registers the editor location toggle command", () => {
    vscode.resetMocks();
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();
    lifecycle.activate(context as never);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "ulw.toggleEditorLocation",
      expect.any(Function),
    );
  });

  it("opens the editor group when ulw.defaultLocation is editor", () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.defaultLocation": "editor" });
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();

    lifecycle.activate(context as never);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "ulw.terminalEditor",
      "ULW Terminal",
      expect.anything(),
      expect.objectContaining({ enableScripts: true }),
    );
  });

  it("opens the editor group by default when ulw.defaultLocation is unset", () => {
    vscode.resetMocks();
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();

    lifecycle.activate(context as never);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "ulw.terminalEditor",
      "ULW Terminal",
      expect.anything(),
      expect.objectContaining({ enableScripts: true }),
    );
  });

  it("stays on the sidebar when ulw.defaultLocation is sidebar", () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.defaultLocation": "sidebar" });
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();

    lifecycle.activate(context as never);

    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("shell-escapes paths sent via sendFileToTerminal", () => {
    vscode.resetMocks();
    const context = createContext();
    const lifecycle = new ExtensionLifecycle();
    lifecycle.activate(context as never);
    const provider = lifecycle["provider"];
    const writeSpy = vi.spyOn(provider!, "write");
    const sendFile = commandHandler<(uri?: { fsPath?: string }) => void>(
      "ulw.sendFileToTerminal",
    );

    sendFile({ fsPath: "/safe/path" });
    expect(writeSpy).toHaveBeenLastCalledWith("'/safe/path'");

    sendFile({ fsPath: "name'$(whoami)'" });
    expect(writeSpy).toHaveBeenLastCalledWith("'name'\\''$(whoami)'\\'''");
  });

  it("lists agents and attaches the selected QuickPick target", async () => {
    vscode.resetMocks();
    const fallback = agent({ paneId: "pane-2", terminalId: "terminal-2", title: "" });
    const malformedTitle = { ...agent({ paneId: "pane-3", terminalId: "terminal-3" }), title: undefined } as unknown as HerdrAgent;
    const { lifecycle, controller } = createHerdrHarness({
      agents: [agent(), fallback, malformedTitle],
    });
    lifecycle.activate(createContext() as never);
    vscode.window.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[1]);

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "Agent one",
          description: "running · workspace-1",
          detail: "/workspace/one",
        }),
        expect.objectContaining({ label: "claude · pane-2" }),
        expect.objectContaining({ label: "claude · pane-3" }),
      ],
      expect.objectContaining({
        title: "Taking control replaces other direct Herdr clients and is not auto-restored",
      }),
    );
    expect(controller.attach).toHaveBeenCalledWith(
      { terminalId: "terminal-2", label: "claude · pane-2" },
      { cols: 80, rows: 24 },
    );
  });

  it("opens the executable setting when Herdr is not installed", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.herdr.executablePath": "/opt/herdr" });
    const { lifecycle } = createHerdrHarness({
      versionError: new HerdrNotInstalledError("herdr default", "/opt/herdr"),
    });
    lifecycle.activate(createContext() as never);
    vscode.window.showWarningMessage.mockResolvedValueOnce("Open Setting");

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Herdr executable not found: /opt/herdr",
      "Open Setting",
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "ulw.herdr.executablePath",
    );
  });

  it("shows the required version when Herdr is unsupported", async () => {
    vscode.resetMocks();
    const { lifecycle } = createHerdrHarness({
      versionError: new HerdrUnsupportedVersionError("herdr default", "0.7.9"),
    });
    lifecycle.activate(createContext() as never);

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Herdr 0.8.0 or newer is required (found 0.7.9)",
    );
  });

  it("retries discovery when the configured Herdr server is down", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.herdr.socketPath": "/tmp/herdr.sock" });
    const serverDown = new HerdrServerDownError(
      "socket /tmp/herdr.sock",
      "offline",
    );
    const freshAgent = agent({
      paneId: "pane-retry",
      terminalId: "terminal-retry",
      title: "Retry target",
    });
    const { lifecycle, client, controller } = createHerdrHarness();
    lifecycle.activate(createContext() as never);
    client.versionCheck.mockResolvedValue({ version: "0.8.2" });
    client.listAgents.mockReset();
    client.listAgents
      .mockRejectedValueOnce(serverDown)
      .mockResolvedValue([freshAgent]);
    vscode.window.showWarningMessage.mockResolvedValueOnce("Retry");
    vscode.window.showQuickPick.mockImplementation(
      async (items: readonly unknown[]) => items[0],
    );

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Herdr session default is not running (socket /tmp/herdr.sock)",
      "Retry",
    );
    expect(client.versionCheck).toHaveBeenCalled();
    expect(client.listAgents).toHaveBeenCalled();
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "Retry target",
          description: "running · workspace-1",
          detail: "/workspace/one",
        }),
      ],
      expect.objectContaining({ placeHolder: "Select a running Herdr agent" }),
    );
    expect(controller.attach).toHaveBeenCalledWith(
      { terminalId: "terminal-retry", label: "Retry target" },
      { cols: 80, rows: 24 },
    );
  });

  it("shows an empty picker when no agents are running", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.herdr.session": "team" });
    const { lifecycle } = createHerdrHarness();
    lifecycle.activate(createContext() as never);

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        placeHolder: "No running Herdr agents in session team",
      }),
    );
  });

  it("reopens the picker for a stale selected target without detaching the shell", async () => {
    vscode.resetMocks();
    const stale = new Error("terminal target pane-1 not found");
    const { lifecycle, client, controller } = createHerdrHarness({
      agents: [agent()],
      attachError: stale,
    });
    lifecycle.activate(createContext() as never);
    vscode.window.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[0]);
    vscode.window.showWarningMessage.mockResolvedValueOnce("Choose Again");

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "The selected Herdr agent is no longer running",
      "Choose Again",
    );
    expect(client.listAgents.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(controller.detach).not.toHaveBeenCalled();
  });

  it("reports busy attach attempts for the selected agent", async () => {
    vscode.resetMocks();
    const busy = createHerdrHarness({
      agents: [agent()],
      attachError: new HerdrAttachBusyError(),
    });
    busy.lifecycle.activate(createContext() as never);
    vscode.window.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[0]);
    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Already attached to a Herdr session",
    );
  });

  it("maps every herdr attach failure to its exact UI response", async () => {
    const rows: readonly {
      readonly name: string;
      readonly run: () => Promise<void>;
    }[] = [
      {
        name: "HerdrNotInstalledError",
        run: async () => {
          vscode.setConfiguration({ "ulw.herdr.executablePath": "/opt/herdr" });
          const { lifecycle, controller } = createHerdrHarness({
            versionError: new HerdrNotInstalledError(
              "herdr default",
              "/opt/herdr",
            ),
          });
          lifecycle.activate(createContext() as never);
          vscode.window.showWarningMessage.mockResolvedValueOnce("Open Setting");

          await commandHandler<() => Promise<void>>(
            "ulw.attachHerdrSession",
          )();

          expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            "Herdr executable not found: /opt/herdr",
            "Open Setting",
          );
          expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            "workbench.action.openSettings",
            "ulw.herdr.executablePath",
          );
          expect(controller.detach).not.toHaveBeenCalled();
        },
      },
      {
        name: "HerdrUnsupportedVersionError",
        run: async () => {
          const { lifecycle, controller } = createHerdrHarness({
            versionError: new HerdrUnsupportedVersionError(
              "herdr default",
              "0.7.9",
            ),
          });
          lifecycle.activate(createContext() as never);

          await commandHandler<() => Promise<void>>(
            "ulw.attachHerdrSession",
          )();

          expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            "Herdr 0.8.0 or newer is required (found 0.7.9)",
          );
          expect(controller.detach).not.toHaveBeenCalled();
        },
      },
      {
        name: "HerdrServerDownError",
        run: async () => {
          vscode.setConfiguration({
            "ulw.herdr.session": "team",
            "ulw.herdr.socketPath": "",
          });
          const { lifecycle, controller } = createHerdrHarness({
            versionError: new HerdrServerDownError("session team", "offline"),
          });
          lifecycle.activate(createContext() as never);

          await commandHandler<() => Promise<void>>(
            "ulw.attachHerdrSession",
          )();

          expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            "Herdr session team is not running (session team)",
            "Retry",
          );
          expect(controller.detach).not.toHaveBeenCalled();
        },
      },
      {
        name: "no agents",
        run: async () => {
          vscode.setConfiguration({ "ulw.herdr.session": "team" });
          const { lifecycle, controller } = createHerdrHarness();
          lifecycle.activate(createContext() as never);

          await commandHandler<() => Promise<void>>(
            "ulw.attachHerdrSession",
          )();

          expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
            [],
            expect.objectContaining({
              placeHolder: "No running Herdr agents in session team",
            }),
          );
          expect(controller.attach).not.toHaveBeenCalled();
          expect(controller.detach).not.toHaveBeenCalled();
        },
      },
      {
        name: "stale target",
        run: async () => {
          const { lifecycle, controller } = createHerdrHarness({
            agents: [agent()],
            attachError: new Error("terminal target pane-1 not found"),
          });
          lifecycle.activate(createContext() as never);
          vscode.window.showQuickPick.mockImplementation(
            async (items: readonly unknown[]) => items[0],
          );

          await commandHandler<() => Promise<void>>(
            "ulw.attachHerdrSession",
          )();

          expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            "The selected Herdr agent is no longer running",
            "Choose Again",
          );
          expect(controller.detach).not.toHaveBeenCalled();
        },
      },
      {
        name: "busy",
        run: async () => {
          const { lifecycle, controller } = createHerdrHarness({
            agents: [agent()],
            attachError: new HerdrAttachBusyError(),
          });
          lifecycle.activate(createContext() as never);
          vscode.window.showQuickPick.mockImplementation(
            async (items: readonly unknown[]) => items[0],
          );

          await commandHandler<() => Promise<void>>(
            "ulw.attachHerdrSession",
          )();

          expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            "Already attached to a Herdr session",
          );
          expect(controller.attach).toHaveBeenCalledOnce();
        },
      },
    ];

    for (const row of rows) {
      vscode.resetMocks();
      await row.run();
    }
  });

  it("warns once when a named session overrides a configured socket", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({
      "ulw.herdr.session": "team",
      "ulw.herdr.socketPath": "/tmp/ignored.sock",
    });
    const { lifecycle } = createHerdrHarness();
    lifecycle.activate(createContext() as never);

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Herdr session "team" is configured; socketPath "/tmp/ignored.sock" is ignored.',
    );
  });

  it("manages the ssh forward only on remote windows with a configured target", async () => {
    const makeHarness = () => {
      const resolveInvocation = vi.fn(
        (input: Parameters<typeof HerdrInvocationResolver.resolve>[0]) =>
          HerdrInvocationResolver.resolve(input),
      );
      const createCliClient = vi.fn(() => ({
        versionCheck: async () => ({ version: "0.8.2" }),
        listAgents: async () => [],
        listWorkspaces: async () => [],
      }));
      const forwards: Array<{
        start: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
      }> = [];
      const createSocketForward = vi.fn((options: { target: string }) => {
        const index = forwards.length;
        const forward = {
          options,
          start: vi.fn(async () => ({
            apiSocketPath: `/tmp/f-${index}.sock`,
            clientSocketPath: `/tmp/f-${index}-client.sock`,
          })),
          dispose: vi.fn(),
        };
        forwards.push(forward);
        return forward;
      });
      const lifecycle = new ExtensionLifecycle({
        env: { PATH: undefined },
        platform: "darwin",
        resolveInvocation,
        createCliClient,
        createSocketForward,
      });
      return { resolveInvocation, createCliClient, createSocketForward, forwards, lifecycle };
    };
    const setConfig = (target: string) => {
      vscode.setConfiguration({
        "ulw.herdr.enabled": true,
        "ulw.herdr.executablePath": "herdr",
        "ulw.herdr.remoteTarget": target,
      });
    };

    vscode.resetMocks();
    setConfig("u@h");
    vscode.env.remoteName = "ssh-remote+203.0.113.7";
    const remote = makeHarness();
    try {
      remote.lifecycle.activate(createContext() as never);
      await vi.waitFor(() => {
        expect(remote.resolveInvocation).toHaveBeenCalled();
      });
      expect(remote.createSocketForward).toHaveBeenCalledWith(
        expect.objectContaining({ target: "u@h" }),
      );
      await vi.waitFor(() => {
        expect(
          remote.resolveInvocation.mock.lastCall?.[0].forwardSockets,
        ).toEqual({
          apiSocketPath: "/tmp/f-0.sock",
          clientSocketPath: "/tmp/f-0-client.sock",
        });
      });
      expect(remote.resolveInvocation.mock.lastCall?.[0].remoteTarget).toBe("u@h");

      setConfig("other@h");
      vscode.fireConfigurationChange("ulw.herdr");
      await vi.waitFor(() => {
        expect(remote.forwards.length).toBe(2);
        expect(remote.forwards[0]?.dispose).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(
          remote.resolveInvocation.mock.lastCall?.[0].forwardSockets,
        ).toEqual({
          apiSocketPath: "/tmp/f-1.sock",
          clientSocketPath: "/tmp/f-1-client.sock",
        });
      });

      setConfig("");
      vscode.fireConfigurationChange("ulw.herdr");
      await vi.waitFor(() => {
        expect(remote.forwards[1]?.dispose).toHaveBeenCalled();
        expect(
          remote.resolveInvocation.mock.lastCall?.[0].forwardSockets,
        ).toBeUndefined();
      });
    } finally {
      remote.lifecycle.dispose();
    }
    expect(remote.forwards[1]?.dispose).toHaveBeenCalledTimes(1);

    vscode.resetMocks();
    setConfig("u@h");
    const local = makeHarness();
    try {
      local.lifecycle.activate(createContext() as never);
      await vi.waitFor(() => {
        expect(local.resolveInvocation).toHaveBeenCalled();
      });
      expect(local.createSocketForward).not.toHaveBeenCalled();
      for (const [input] of local.resolveInvocation.mock.calls) {
        expect(input.forwardSockets).toBeUndefined();
        expect(input.remoteTarget).toBeUndefined();
      }
    } finally {
      local.lifecycle.dispose();
    }
  });

  it("re-resolves the Herdr invocation and client when Herdr settings change at runtime", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({
      "ulw.herdr.enabled": true,
      "ulw.herdr.executablePath": "herdr",
      "ulw.herdr.remoteTarget": "",
    });
    const clients: Array<{
      versionCheck: ReturnType<typeof vi.fn>;
      listAgents: ReturnType<typeof vi.fn>;
      listWorkspaces: ReturnType<typeof vi.fn>;
    }> = [];
    const resolveInvocation = vi.fn(
      (input: Parameters<typeof HerdrInvocationResolver.resolve>[0]) =>
        HerdrInvocationResolver.resolve(input),
    );
    const createCliClient = vi.fn(() => {
      const client = {
        versionCheck: vi.fn(async () => ({ version: "0.8.2" })),
        listAgents: vi.fn(async () => [] as HerdrAgent[]),
        listWorkspaces: vi.fn(async () => []),
      };
      clients.push(client);
      return client;
    });
    const lifecycle = new ExtensionLifecycle({
      env: { PATH: undefined },
      platform: "darwin",
      explorerPollMs: 0,
      resolveInvocation,
      createCliClient,
    });
    try {
      lifecycle.activate(createContext() as never);
      await vi.waitFor(() => {
        expect(clients[1]?.listAgents).toHaveBeenCalled();
      });

      vscode.setConfiguration({
        "ulw.herdr.enabled": true,
        "ulw.herdr.executablePath": "herdr",
        "ulw.herdr.remoteTarget": "ops@box",
      });
      vscode.fireConfigurationChange("ulw.herdr");
      await vi.waitFor(() => {
        expect(createCliClient).toHaveBeenCalledTimes(3);
      });
      await vi.waitFor(() => {
        expect(clients[2]?.listAgents).toHaveBeenCalled();
      });

      vscode.setConfiguration({
        "ulw.herdr.enabled": true,
        "ulw.herdr.executablePath": "herdr",
        "ulw.herdr.remoteTarget": "",
      });
      vscode.fireConfigurationChange("ulw.herdr");
      await vi.waitFor(() => {
        expect(createCliClient).toHaveBeenCalledTimes(4);
      });
      expect(resolveInvocation.mock.lastCall?.[0].remoteTarget).toBeUndefined();
      // Drain the fire-and-forget refresh the listener started so its logging
      // cannot race worker teardown after dispose.
      const agentResults = clients[3]?.listAgents.mock.results ?? [];
      const workspaceResults = clients[3]?.listWorkspaces.mock.results ?? [];
      await agentResults[agentResults.length - 1]?.value;
      await workspaceResults[workspaceResults.length - 1]?.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      lifecycle.dispose();
    }
  });

  it("does not continue the herdr bootstrap after lifecycle disposal", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({
      "ulw.herdr.enabled": true,
      "ulw.herdr.executablePath": "herdr",
      "ulw.herdr.remoteTarget": "u@h",
    });
    vscode.env.remoteName = "ssh-remote+203.0.113.7";
    const resolveInvocation = vi.fn(
      (input: Parameters<typeof HerdrInvocationResolver.resolve>[0]) =>
        HerdrInvocationResolver.resolve(input),
    );
    const createCliClient = vi.fn(() => ({
      versionCheck: async () => ({ version: "0.8.2" }),
      listAgents: async () => [],
      listWorkspaces: async () => [],
    }));
    let releaseStart: (sockets: {
      apiSocketPath: string;
      clientSocketPath: string;
    }) => void = () => undefined;
    const start = vi.fn(
      () =>
        new Promise<{ apiSocketPath: string; clientSocketPath: string }>(
          (resolve) => {
            releaseStart = resolve;
          },
        ),
    );
    const dispose = vi.fn();
    const lifecycle = new ExtensionLifecycle({
      env: { PATH: undefined },
      platform: "darwin",
      explorerPollMs: 0,
      resolveInvocation,
      createCliClient,
      createSocketForward: vi.fn(() => ({ start, dispose })),
    });

    lifecycle.activate(createContext() as never);
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalled();
    });
    const clientsBeforeDispose = createCliClient.mock.calls.length;
    const resolvesBeforeDispose = resolveInvocation.mock.calls.length;
    lifecycle.dispose();
    releaseStart({
      apiSocketPath: "/tmp/f-late.sock",
      clientSocketPath: "/tmp/f-late-client.sock",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createCliClient).toHaveBeenCalledTimes(clientsBeforeDispose);
    expect(resolveInvocation).toHaveBeenCalledTimes(resolvesBeforeDispose);
    expect(dispose).toHaveBeenCalled();
  });

  it("passes explicit settings through the resolver with a stripped environment and shares invocation with the bridge", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({
      "ulw.herdr.enabled": true,
      "ulw.herdr.executablePath": "/Applications/Herdr/bin/herdr",
      "ulw.herdr.socketPath": "/private/tmp/herdr.sock",
      "ulw.herdr.session": "",
    });
    const resolveInvocation = vi.fn(
      (input: Parameters<typeof HerdrInvocationResolver.resolve>[0]) =>
        HerdrInvocationResolver.resolve(input),
    );
    let discoveryInvocation: HerdrInvocation | undefined;
    let bridgeInvocation: HerdrInvocation | undefined;
    const createControlTransport = vi.fn((options: { invocation: HerdrInvocation }) => {
      bridgeInvocation = options.invocation;
      return {} as TerminalTransport;
    });
    const sourceStateEmitter = new vscode.EventEmitter<never>();
    const lifecycle = new ExtensionLifecycle({
      env: { PATH: undefined, HERDR_SOCKET_PATH: undefined },
      platform: "darwin",
      resolveInvocation,
      createCliClient: (invocation) => {
        discoveryInvocation = invocation;
        return {
          versionCheck: async () => ({ version: "0.8.2" }),
          listAgents: async () => [agent({ terminalId: "terminal-explicit" })],
          listWorkspaces: async () => [],
        };
      },
      createControlTransport,
      createAttachController: (options) => {
        return {
          sourceState: { source: "shell", phase: "shell" },
          onSourceState: sourceStateEmitter.event,
          attach: vi.fn(async (target: { terminalId: string }) => {
            options.transportFactory(target, { cols: 80, rows: 24 });
          }),
          detach: vi.fn(),
          dispose: vi.fn(),
        } as never;
      },
    });

    lifecycle.activate(createContext() as never);
    vscode.window.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[0]);
    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(resolveInvocation).toHaveBeenCalledWith({
      executablePath: "/Applications/Herdr/bin/herdr",
      session: "",
      socketPath: "/private/tmp/herdr.sock",
      env: { PATH: undefined, HERDR_SOCKET_PATH: undefined },
      platform: "darwin",
    });
    expect(discoveryInvocation).toEqual(
      expect.objectContaining({
        command: "/Applications/Herdr/bin/herdr",
        argsPrefix: [],
        env: { HERDR_SOCKET_PATH: "/private/tmp/herdr.sock" },
      }),
    );
    expect(bridgeInvocation).toBe(discoveryInvocation);
  });

  it("places a named session in both discovery and bridge invocation", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({
      "ulw.herdr.enabled": true,
      "ulw.herdr.session": "team",
    });
    let discoveryInvocation: HerdrInvocation | undefined;
    let bridgeInvocation: HerdrInvocation | undefined;
    const sourceStateEmitter = new vscode.EventEmitter<never>();
    const lifecycle = new ExtensionLifecycle({
      createCliClient: (invocation) => {
        discoveryInvocation = invocation;
        return {
          versionCheck: async () => ({ version: "0.8.2" }),
          listAgents: async () => [agent()],
          listWorkspaces: async () => [],
        };
      },
      createControlTransport: (options) => {
        bridgeInvocation = options.invocation;
        return {} as TerminalTransport;
      },
      createAttachController: (options) => {
        return {
          sourceState: { source: "shell", phase: "shell" },
          onSourceState: sourceStateEmitter.event,
          attach: vi.fn(async (target: { terminalId: string }) => {
            options.transportFactory(target, { cols: 80, rows: 24 });
          }),
          detach: vi.fn(),
          dispose: vi.fn(),
        } as never;
      },
    });

    lifecycle.activate(createContext() as never);
    vscode.window.showQuickPick.mockImplementation(async (items: readonly unknown[]) => items[0]);
    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(discoveryInvocation?.argsPrefix).toEqual(["--session", "team"]);
    expect(bridgeInvocation?.argsPrefix).toEqual(["--session", "team"]);
  });

  it("detaches only when a Herdr source is active", async () => {
    vscode.resetMocks();
    const shell = createHerdrHarness();
    shell.lifecycle.activate(createContext() as never);
    await commandHandler<() => Promise<void>>("ulw.detachHerdrSession")();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Not attached to a Herdr session",
    );
    expect(shell.controller.detach).not.toHaveBeenCalled();

    vscode.resetMocks();
    const attached = createHerdrHarness({ phase: "attached" });
    attached.lifecycle.activate(createContext() as never);
    await commandHandler<(node: { kind: "agent"; agent: HerdrAgent }) => Promise<void>>(
      "ulw.herdr.openAgent",
    )({ kind: "agent", agent: agent() });
    await commandHandler<() => Promise<void>>("ulw.detachHerdrSession")();
    expect(attached.controller.detach).toHaveBeenCalledOnce();
  });

  it("does not load Herdr agents until the user enables Herdr", async () => {
    vscode.resetMocks();
    const { client, lifecycle } = createHerdrHarness({
      agents: [agent()],
      herdrEnabled: false,
    });
    lifecycle.activate(createContext() as never);
    await Promise.resolve();
    expect(client.listAgents).not.toHaveBeenCalled();
    expect(client.listWorkspaces).not.toHaveBeenCalled();
  });

  it("loads Spaces and Agents when Herdr is enabled", async () => {
    vscode.resetMocks();
    const { client, lifecycle } = createHerdrHarness({ agents: [agent()] });
    lifecycle.activate(createContext() as never);
    await vi.waitFor(() => {
      expect(client.listWorkspaces).toHaveBeenCalledOnce();
      expect(client.listAgents).toHaveBeenCalledOnce();
    });
  });

  it("polls Spaces and Agents while Herdr stays enabled", async () => {
    vscode.resetMocks();
    vi.useFakeTimers();
    const { client, lifecycle } = createHerdrHarness({
      agents: [agent()],
      explorerPollMs: 2_000,
    });
    try {
      lifecycle.activate(createContext() as never);
      await vi.waitFor(() => {
        expect(client.listAgents).toHaveBeenCalledOnce();
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.listAgents).toHaveBeenCalledTimes(2);
      expect(client.listWorkspaces).toHaveBeenCalledTimes(2);
      lifecycle.dispose();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(client.listAgents).toHaveBeenCalledTimes(2);
    } finally {
      lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("loads Spaces and Agents after the user enables Herdr at runtime", async () => {
    vscode.resetMocks();
    const { client, lifecycle } = createHerdrHarness({
      agents: [agent()],
      herdrEnabled: false,
    });
    lifecycle.activate(createContext() as never);
    await Promise.resolve();
    expect(client.listAgents).not.toHaveBeenCalled();

    vscode.setConfiguration({ "ulw.herdr.enabled": true });
    vscode.fireConfigurationChange("ulw.herdr.enabled");
    await vi.waitFor(() => {
      expect(client.listWorkspaces).toHaveBeenCalledOnce();
      expect(client.listAgents).toHaveBeenCalledOnce();
    });
  });

  it("registers Spaces and Agents trees and attaches from an agent node", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.herdr.enabled": true });
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace/one") }];
    const target = agent();
    const { lifecycle, controller } = createHerdrHarness({
      agents: [target],
      workspaces: [
        {
          workspaceId: "workspace-1",
          label: "one",
          status: "working",
          paneCount: 1,
        },
      ],
    });
    lifecycle.activate(createContext() as never);

    expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
      "ulw.herdr.spaces",
      expect.anything(),
    );
    expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
      "ulw.herdr.agents",
      expect.anything(),
    );
    await commandHandler<() => Promise<void>>("ulw.herdr.refreshExplorer")();

    await commandHandler<(node: {
      kind: "agent";
      agent: HerdrAgent;
    }) => Promise<void>>("ulw.herdr.openAgent")({
      kind: "agent",
      agent: target,
    });
    expect(controller.attach).toHaveBeenCalledWith(
      { terminalId: "terminal-1", label: "Agent one" },
      { cols: 80, rows: 24 },
    );
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "ulw.terminalEditor",
      "Agent one",
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true }),
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();

    await commandHandler<(node: {
      kind: "space";
      space: {
        readonly workspaceId: string;
        readonly label: string;
        readonly status: string;
        readonly paneCount: number;
      };
    }) => Promise<void>>("ulw.herdr.openSpace")({
      kind: "space",
      space: {
        workspaceId: "workspace-1",
        label: "one",
        status: "working",
        paneCount: 1,
      },
    });
    expect(controller.attach).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.anything(),
      expect.anything(),
    );
  });

  it("opens another space folder in a new window instead of attaching", async () => {
    vscode.resetMocks();
    const foreign = agent({
      cwd: "/tmp/other-space",
      workspaceId: "workspace-2",
      terminalId: "terminal-2",
    });
    const { lifecycle, controller } = createHerdrHarness({
      agents: [foreign],
      workspaces: [
        {
          workspaceId: "workspace-2",
          label: "other",
          status: "idle",
          paneCount: 1,
        },
      ],
    });
    lifecycle.activate(createContext() as never);
    await commandHandler<() => Promise<void>>("ulw.herdr.refreshExplorer")();

    await commandHandler<(node: {
      kind: "space";
      space: {
        readonly workspaceId: string;
        readonly label: string;
        readonly status: string;
        readonly paneCount: number;
      };
    }) => Promise<void>>("ulw.herdr.openSpace")({
      kind: "space",
      space: {
        workspaceId: "workspace-2",
        label: "other",
        status: "idle",
        paneCount: 1,
      },
    });
    expect(controller.attach).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.objectContaining({ fsPath: expect.stringContaining("other-space") }),
      { forceNewWindow: true },
    );

    await commandHandler<(node: {
      kind: "agent";
      agent: HerdrAgent;
    }) => Promise<void>>("ulw.herdr.openAgent")({
      kind: "agent",
      agent: foreign,
    });
    expect(controller.attach).not.toHaveBeenCalled();
    const folderOpens = vscode.commands.executeCommand.mock.calls.filter(
      (call) => call[0] === "vscode.openFolder",
    );
    expect(folderOpens).toHaveLength(2);
  });

  it("opens each same-space agent in its own editor tab and skips the sidebar shell", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.herdr.enabled": true });
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file("/workspace/one") }];
    const first = agent();
    const second = agent({
      paneId: "pane-2",
      terminalId: "terminal-2",
      title: "Agent two",
    });
    const { lifecycle } = createHerdrHarness({
      agents: [first, second],
    });
    lifecycle.activate(createContext() as never);

    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.view.extension.ulwContainer",
    );

    const open = commandHandler<(node: {
      kind: "agent";
      agent: HerdrAgent;
    }) => Promise<void>>("ulw.herdr.openAgent");
    await open({ kind: "agent", agent: first });
    await open({ kind: "agent", agent: second });
    await open({ kind: "agent", agent: first });

    const titles = vscode.window.createWebviewPanel.mock.calls.map((call) => call[1]);
    expect(titles).toEqual(["Agent one", "Agent two"]);
    const firstPanel = vscode.window.createWebviewPanel.mock.results[0]?.value as {
      reveal: ReturnType<typeof vi.fn>;
    };
    expect(firstPanel.reveal).toHaveBeenCalled();
  });
});
