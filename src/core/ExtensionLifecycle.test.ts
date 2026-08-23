import { describe, expect, it, vi } from "vitest";
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

vi.mock("node-pty", async () => vi.importActual("../test/mocks/node-pty"));

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
} = {}) {
  vscode.setConfiguration({
    "ulw.herdr.enabled": options.herdrEnabled ?? true,
  });
  const sourceStateEmitter = new vscode.EventEmitter<never>();
  const controller = {
    sourceState: {
      source: options.phase === "shell" || options.phase === undefined ? "shell" : "herdr",
      phase: options.phase ?? "shell",
    },
    onSourceState: sourceStateEmitter.event,
    attach: vi.fn(async () => {
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
    createCliClient: () => client,
    createAttachController: () => controller as never,
    createControlTransport: () => ({}) as TerminalTransport,
  });
  return { lifecycle, client, controller };
}

describe("ExtensionLifecycle", () => {
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

  it("reports busy attach attempts before discovery", async () => {
    vscode.resetMocks();
    const { lifecycle, client } = createHerdrHarness({ phase: "attached" });
    lifecycle.activate(createContext() as never);

    await commandHandler<() => Promise<void>>("ulw.attachHerdrSession")();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Already attached to a Herdr session",
    );
    expect(client.versionCheck).not.toHaveBeenCalled();

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
          const { lifecycle, client, controller } = createHerdrHarness({
            phase: "attached",
          });
          lifecycle.activate(createContext() as never);

          await commandHandler<() => Promise<void>>(
            "ulw.attachHerdrSession",
          )();

          expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            "Already attached to a Herdr session",
          );
          expect(client.versionCheck).not.toHaveBeenCalled();
          expect(controller.detach).not.toHaveBeenCalled();
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

  it("passes explicit settings through the resolver with a stripped environment and shares invocation with the bridge", async () => {
    vscode.resetMocks();
    vscode.setConfiguration({
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
          listAgents: async () => [],
          listWorkspaces: async () => [],
        };
      },
      createControlTransport,
      createAttachController: (options) => {
        options.transportFactory(
          { terminalId: "terminal-explicit" },
          { cols: 80, rows: 24 },
        );
        return {
          sourceState: { source: "shell", phase: "shell" },
          onSourceState: sourceStateEmitter.event,
          attach: vi.fn(),
          detach: vi.fn(),
          dispose: vi.fn(),
        } as never;
      },
    });

    lifecycle.activate(createContext() as never);

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

  it("places a named session in both discovery and bridge invocation", () => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.herdr.session": "team" });
    let discoveryInvocation: HerdrInvocation | undefined;
    let bridgeInvocation: HerdrInvocation | undefined;
    const sourceStateEmitter = new vscode.EventEmitter<never>();
    const lifecycle = new ExtensionLifecycle({
      createCliClient: (invocation) => {
        discoveryInvocation = invocation;
        return {
          versionCheck: async () => ({ version: "0.8.2" }),
          listAgents: async () => [],
          listWorkspaces: async () => [],
        };
      },
      createControlTransport: (options) => {
        bridgeInvocation = options.invocation;
        return {} as TerminalTransport;
      },
      createAttachController: (options) => {
        options.transportFactory({ terminalId: "terminal-1" }, { cols: 80, rows: 24 });
        return {
          sourceState: { source: "shell", phase: "shell" },
          onSourceState: sourceStateEmitter.event,
          attach: vi.fn(),
          detach: vi.fn(),
          dispose: vi.fn(),
        } as never;
      },
    });

    lifecycle.activate(createContext() as never);

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
});
