import { execFile } from "child_process";
import * as vscode from "vscode";
import { HerdrCliClient } from "../herdr/HerdrCliClient";
import {
  HerdrAttachBusyError,
  HerdrAttachController,
  herdrSessionId,
  type HerdrAttachControllerOptions,
  type HerdrAttachPresenter,
  type HerdrAttachTarget,
  type SourceState,
} from "../herdr/HerdrAttachController";
import {
  HerdrNotInstalledError,
  HerdrServerDownError,
  HerdrUnsupportedVersionError,
} from "../herdr/errors";
import {
  HerdrControlTransport,
  type HerdrControlTransportOptions,
} from "../herdr/HerdrControlTransport";
import { HerdrInvocationResolver } from "../herdr/HerdrInvocationResolver";
import {
  agentAttachLabel,
  HerdrAgentsTreeProvider,
  HerdrSnapshotStore,
  HerdrSpacesTreeProvider,
  inferSpaceRoot,
  isCurrentWindowRoot,
  type HerdrAgentNode,
  type HerdrSpaceNode,
} from "../herdr/HerdrExplorer";
import type {
  HerdrAgent,
  HerdrCommandRunner,
  HerdrInvocation,
  HerdrInvocationInput,
  HerdrPlatform,
  HerdrSpace,
} from "../herdr/types";
import { TerminalProvider } from "../providers/TerminalProvider";
import type { TerminalTransport } from "../terminals/TerminalTransport";
import { TerminalManager } from "../terminals/TerminalManager";

const DEFAULT_DIMENSIONS = { cols: 80, rows: 24 } as const;
const TAKEOVER_DISCLOSURE =
  "Taking control replaces other direct Herdr clients and is not auto-restored";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface HerdrCli {
  versionCheck(): Promise<{ readonly version: string }>;
  listAgents(): Promise<readonly HerdrAgent[]>;
  listWorkspaces(): Promise<readonly HerdrSpace[]>;
}

interface ExtensionLifecycleOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: HerdrPlatform;
  readonly resolveInvocation?: (input: HerdrInvocationInput) => HerdrInvocation;
  readonly runCommand?: HerdrCommandRunner;
  readonly createCliClient?: (invocation: HerdrInvocation) => HerdrCli;
  readonly createControlTransport?: (
    options: HerdrControlTransportOptions,
  ) => TerminalTransport;
  readonly createAttachController?: (
    options: HerdrAttachControllerOptions,
  ) => HerdrAttachController;
}

interface HerdrQuickPickItem extends vscode.QuickPickItem {
  readonly agent: HerdrAgent;
}

interface HerdrControllerFactory {
  (sessionId: string, presenter: HerdrAttachPresenter): HerdrAttachController;
}

export interface UlwExtensionApi {
  readonly onTerminalStart: vscode.Event<number>;
  readonly onTerminalData: vscode.Event<string>;
  readonly onTerminalExit: vscode.Event<number>;
  readonly onSourceState: vscode.Event<SourceState>;
  isTerminalRunning(): boolean;
  terminalCount(): number;
  writeToTerminal(data: string): void;
  toggleEditorLocation(): void;
  attachToHerdr(target: HerdrAttachTarget): Promise<void>;
  detachHerdr(): Promise<void>;
  resizeTerminal(cols: number, rows: number): void;
  getSurfaceSnapshot(): {
    readonly sourceState: SourceState;
    readonly renderedText: string;
  };
  getExplorerSnapshot(): {
    readonly spaces: readonly HerdrSpace[];
    readonly agents: readonly HerdrAgent[];
  };
  refreshExplorer(): Promise<void>;
}

export class ExtensionLifecycle implements vscode.Disposable {
  private terminalManager: TerminalManager | undefined;
  private provider: TerminalProvider | undefined;
  private explorerStore: HerdrSnapshotStore | undefined;
  private readonly herdrControllers = new Map<string, HerdrAttachController>();
  private readonly sourceStateEmitter = new vscode.EventEmitter<SourceState>();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly options: ExtensionLifecycleOptions = {}) {}

  public activate(context: vscode.ExtensionContext): UlwExtensionApi {
    const terminalManager = new TerminalManager();
    const invocation = this.resolveHerdrInvocation();
    const client = this.createCliClient(invocation);
    const createControlTransport =
      this.options.createControlTransport ??
      ((transportOptions: HerdrControlTransportOptions) =>
        new HerdrControlTransport(transportOptions));
    const createAttachController =
      this.options.createAttachController ??
      ((controllerOptions: HerdrAttachControllerOptions) =>
        new HerdrAttachController(controllerOptions));
    const explorerStore = new HerdrSnapshotStore(client);
    this.explorerStore = explorerStore;
    const provider = new TerminalProvider(
      context.extensionUri,
      terminalManager,
    );
    this.terminalManager = terminalManager;
    this.provider = provider;
    const makeController = (
      sessionId: string,
      presenter: HerdrAttachPresenter,
    ): HerdrAttachController => {
      const controller = createAttachController({
        manager: terminalManager,
        terminalId: sessionId,
        transportFactory: (target, dimensions) =>
          createControlTransport({
            invocation,
            terminalId: target.terminalId,
            cols: dimensions.cols,
            rows: dimensions.rows,
          }),
        presenter,
      });
      this.herdrControllers.set(sessionId, controller);
      this.disposables.push(
        controller,
        controller.onSourceState((state) => this.sourceStateEmitter.fire(state)),
      );
      return controller;
    };

    const dataEmitter = new vscode.EventEmitter<string>();
    const exitEmitter = new vscode.EventEmitter<number>();
    const startEmitter = new vscode.EventEmitter<number>();
    this.disposables.push(
      startEmitter,
      dataEmitter,
      exitEmitter,
      terminalManager.onStart(({ pid }) => startEmitter.fire(pid)),
      terminalManager.onData(({ data }) => dataEmitter.fire(data)),
      terminalManager.onExit(({ code }) => exitEmitter.fire(code)),
      vscode.window.registerWebviewViewProvider(
        TerminalProvider.viewType,
        provider,
      ),
      terminalManager,
      provider,
      this.sourceStateEmitter,
      vscode.commands.registerCommand("ulw.toggleEditorLocation", () => {
        if (this.herdrEnabled()) {
          return;
        }
        provider.toggleEditorLocation();
      }),
      vscode.commands.registerCommand("ulw.sendSelectionToTerminal", () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          return;
        }
        const text = editor.document.getText(editor.selection);
        if (text) {
          provider.write(text);
        }
      }),
      vscode.commands.registerCommand(
        "ulw.sendFileToTerminal",
        (uri: vscode.Uri | undefined) => {
          if (uri?.fsPath) {
            provider.write(shellQuote(uri.fsPath));
          }
        },
      ),
      vscode.commands.registerCommand("ulw.attachHerdrSession", async () => {
        if (!(await this.requireHerdrEnabled())) {
          return;
        }
        await this.attachHerdrSession(client, invocation, makeController);
      }),
      vscode.commands.registerCommand("ulw.detachHerdrSession", async () => {
        if (!(await this.requireHerdrEnabled())) {
          return;
        }
        const active = this.activeHerdrController();
        if (!active || active.sourceState.phase === "shell") {
          await vscode.window.showInformationMessage(
            "Not attached to a Herdr session",
          );
          return;
        }
        await active.detach();
      }),
      vscode.window.registerTreeDataProvider(
        "ulw.herdr.spaces",
        new HerdrSpacesTreeProvider(explorerStore),
      ),
      vscode.window.registerTreeDataProvider(
        "ulw.herdr.agents",
        new HerdrAgentsTreeProvider(explorerStore),
      ),
      vscode.commands.registerCommand(
        "ulw.herdr.openAgent",
        async (node: HerdrAgentNode) => {
          if (!(await this.requireHerdrEnabled())) {
            return;
          }
          if (await this.openForeignFolderIfNeeded(node.agent.cwd)) {
            return;
          }
          await this.attachSelected(makeController, {
            label: agentAttachLabel(node.agent),
            agent: node.agent,
          });
        },
      ),
      vscode.commands.registerCommand(
        "ulw.herdr.openSpace",
        async (node: HerdrSpaceNode) => {
          if (!(await this.requireHerdrEnabled())) {
            return;
          }
          const root = inferSpaceRoot(node.space.workspaceId, explorerStore.agents());
          if (!root) {
            await vscode.window.showInformationMessage(
              `No folder is associated with ${node.space.label}`,
            );
            return;
          }
          await this.openForeignFolderIfNeeded(root);
        },
      ),
      vscode.commands.registerCommand("ulw.herdr.refreshExplorer", async () => {
        if (!(await this.requireHerdrEnabled())) {
          return;
        }
        await this.refreshExplorerStore(explorerStore);
      }),
      explorerStore,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("ulw.herdr")) {
          return;
        }
        if (this.herdrEnabled()) {
          void this.refreshExplorerStore(explorerStore);
          void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
        }
      }),
    );
    context.subscriptions.push(this);
    if (this.herdrEnabled()) {
      void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      void this.refreshExplorerStore(explorerStore);
    } else {
      provider.openAtConfiguredLocation();
    }

    return {
      onTerminalStart: startEmitter.event,
      onTerminalData: dataEmitter.event,
      onTerminalExit: exitEmitter.event,
      onSourceState: this.sourceStateEmitter.event,
      isTerminalRunning: () =>
        this.herdrEnabled()
          ? provider.herdrSessionCount() > 0
          : provider.isRunning(),
      terminalCount: () =>
        this.herdrEnabled()
          ? provider.herdrSessionCount()
          : provider.terminalCount(),
      writeToTerminal: (data) => provider.write(data),
      toggleEditorLocation: () => {
        if (this.herdrEnabled()) {
          return;
        }
        provider.toggleEditorLocation();
      },
      attachToHerdr: (target) => this.openHerdrTarget(makeController, target),
      detachHerdr: async () => {
        const active = this.activeHerdrController();
        if (active) {
          await active.detach();
        }
      },
      resizeTerminal: (cols, rows) => {
        terminalManager.resize(provider.activeSessionId(), cols, rows);
      },
      getSurfaceSnapshot: () => {
        const sessionId = provider.activeSessionId();
        const controller = this.herdrControllers.get(sessionId);
        return {
          sourceState: controller?.sourceState ?? {
            source: "shell",
            phase: "shell",
          },
          renderedText: sanitizeTerminalReplay(terminalManager.replay(sessionId)),
        };
      },
      getExplorerSnapshot: () => ({
        spaces: explorerStore.spaces(),
        agents: explorerStore.agents(),
      }),
      refreshExplorer: async () => {
        if (!this.herdrEnabled()) {
          return;
        }
        await this.refreshExplorerStore(explorerStore);
      },
    };
  }

  public toggleEditorLocation(): void {
    this.provider?.toggleEditorLocation();
  }

  public dispose(): void {
    for (const disposable of this.disposables.splice(0).reverse()) {
      disposable.dispose();
    }
    this.provider = undefined;
    this.terminalManager = undefined;
    this.explorerStore = undefined;
  }

  private herdrEnabled(): boolean {
    return vscode.workspace.getConfiguration("ulw").get<boolean>("herdr.enabled", false);
  }

  private async requireHerdrEnabled(): Promise<boolean> {
    if (this.herdrEnabled()) {
      return true;
    }
    const action = await vscode.window.showInformationMessage(
      "Turn on ULW Herdr integration to list Spaces/Agents and attach sessions.",
      "Enable",
    );
    if (action !== "Enable") {
      return false;
    }
    await vscode.workspace
      .getConfiguration("ulw")
      .update("herdr.enabled", true, vscode.ConfigurationTarget.Global);
    if (this.explorerStore) {
      await this.refreshExplorerStore(this.explorerStore);
    }
    return true;
  }

  private async refreshExplorerStore(store: HerdrSnapshotStore): Promise<void> {
    try {
      await store.refresh();
      console.info(
        `[ULW Herdr] listed ${store.spaces().length} spaces, ${store.agents().length} agents`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ULW Herdr] explorer refresh failed: ${message}`);
      await vscode.window.showWarningMessage(message);
    }
  }

  private resolveHerdrInvocation(): HerdrInvocation {
    const configuration = vscode.workspace.getConfiguration("ulw");
    const input: HerdrInvocationInput = {
      executablePath: configuration.get<string>("herdr.executablePath", "herdr"),
      socketPath: configuration.get<string>("herdr.socketPath", ""),
      session: configuration.get<string>("herdr.session", ""),
      env: this.options.env ?? process.env,
      platform: this.options.platform ?? (process.platform as HerdrPlatform),
    };
    const resolveInvocation =
      this.options.resolveInvocation ?? HerdrInvocationResolver.resolve.bind(HerdrInvocationResolver);
    return resolveInvocation(input);
  }

  private createCliClient(invocation: HerdrInvocation): HerdrCli {
    if (this.options.createCliClient) {
      return this.options.createCliClient(invocation);
    }
    return new HerdrCliClient({
      invocation,
      run: this.options.runCommand ?? runHerdrCommand,
    });
  }

  private async attachHerdrSession(
    client: HerdrCli,
    invocation: HerdrInvocation,
    makeController: HerdrControllerFactory,
    showInvocationWarnings = true,
  ): Promise<void> {
    if (showInvocationWarnings) {
      for (const warning of invocation.warnings) {
        await vscode.window.showWarningMessage(warning);
      }
    }

    try {
      await client.versionCheck();
      const agents = await client.listAgents();
      const session = this.configuredSession();
      const items = agents.map((entry) => this.quickPickItem(entry));
      const selected = await vscode.window.showQuickPick(items, {
        title: TAKEOVER_DISCLOSURE,
        placeHolder:
          items.length === 0
            ? `No running Herdr agents in session ${session}`
            : "Select a running Herdr agent",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!selected) {
        return;
      }

      try {
        await this.attachSelected(makeController, selected);
      } catch (error) {
        if (error instanceof HerdrAttachBusyError) {
          await vscode.window.showInformationMessage(
            "Already attached to a Herdr session",
          );
          return;
        }
        if (this.isStaleTargetError(error)) {
          const action = await vscode.window.showWarningMessage(
            "The selected Herdr agent is no longer running",
            "Choose Again",
          );
          if (action === "Choose Again") {
            await this.attachHerdrSession(client, invocation, makeController, false);
          }
          return;
        }
        throw error;
      }
    } catch (error) {
      await this.showHerdrFailure(error, client, invocation, makeController);
    }
  }

  private async attachSelected(
    makeController: HerdrControllerFactory,
    selected: HerdrQuickPickItem,
  ): Promise<void> {
    await this.openHerdrTarget(makeController, {
      terminalId: selected.agent.terminalId,
      label: selected.label,
    });
  }

  private async openHerdrTarget(
    makeController: HerdrControllerFactory,
    target: HerdrAttachTarget,
  ): Promise<void> {
    const provider = this.provider;
    if (!provider) {
      return;
    }
    let attachFailure: string | undefined;
    await provider.openHerdrSession(
      target,
      async (sessionTarget) => {
        const sessionId = herdrSessionId(sessionTarget.terminalId);
        const controller = this.herdrControllers.get(sessionId);
        if (!controller) {
          throw new Error("Herdr session controller was not created");
        }
        const stateSubscription = controller.onSourceState((state) => {
          if (state.phase === "error" && state.message) {
            attachFailure = state.message;
          }
        });
        try {
          await controller.attach(sessionTarget, DEFAULT_DIMENSIONS);
        } finally {
          stateSubscription.dispose();
        }
      },
      makeController,
    );
    if (attachFailure) {
      throw new Error(attachFailure);
    }
  }

  private activeHerdrController(): HerdrAttachController | undefined {
    const sessionId = this.provider?.activeSessionId();
    if (!sessionId) {
      return undefined;
    }
    return this.herdrControllers.get(sessionId);
  }

  private async showHerdrFailure(
    error: unknown,
    client: HerdrCli,
    invocation: HerdrInvocation,
    makeController: HerdrControllerFactory,
  ): Promise<void> {
    if (error instanceof HerdrNotInstalledError) {
      const action = await vscode.window.showWarningMessage(
        `Herdr executable not found: ${invocation.command}`,
        "Open Setting",
      );
      if (action === "Open Setting") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "ulw.herdr.executablePath",
        );
      }
      return;
    }
    if (error instanceof HerdrUnsupportedVersionError) {
      await vscode.window.showWarningMessage(
        `Herdr 0.8.0 or newer is required (found ${error.version})`,
      );
      return;
    }
    if (error instanceof HerdrServerDownError) {
      const action = await vscode.window.showWarningMessage(
        `Herdr session ${this.configuredSession()} is not running (${error.displayEndpoint})`,
        "Retry",
      );
      if (action === "Retry") {
        await this.attachHerdrSession(client, invocation, makeController, false);
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showWarningMessage(message);
  }

  private quickPickItem(entry: HerdrAgent): HerdrQuickPickItem {
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    return {
      label: title || `${entry.agent} · ${entry.paneId}`,
      description: `${entry.status} · ${entry.workspaceId}`,
      detail: entry.cwd,
      agent: entry,
    };
  }

  private configuredSession(): string {
    return (
      vscode.workspace
        .getConfiguration("ulw")
        .get<string>("herdr.session", "")
        .trim() || "default"
    );
  }

  private async openForeignFolderIfNeeded(root: string): Promise<boolean> {
    if (root.trim().length === 0) {
      return false;
    }
    if (isCurrentWindowRoot(root, vscode.workspace.workspaceFolders)) {
      return false;
    }
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), {
      forceNewWindow: true,
    });
    return true;
  }

  private isStaleTargetError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:pane|terminal|target).*(?:not found|no longer exists)|not found.*(?:pane|terminal|target)/i.test(
      message,
    );
  }
}

function sanitizeTerminalReplay(replay: string): string {
  return replay
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const runHerdrCommand: HerdrCommandRunner = (
  command,
  args,
  env,
  timeoutMs,
) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env: { ...env }, timeout: timeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : undefined;
          if (code !== undefined) {
            resolve({ stdout, stderr, code });
            return;
          }
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
  });
