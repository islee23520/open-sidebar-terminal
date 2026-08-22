import { execFile } from "child_process";
import * as vscode from "vscode";
import { HerdrCliClient } from "../herdr/HerdrCliClient";
import {
  HerdrAttachBusyError,
  HerdrAttachController,
  type HerdrAttachControllerOptions,
  type HerdrAttachPresenter,
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
import type {
  HerdrAgent,
  HerdrCommandRunner,
  HerdrInvocation,
  HerdrInvocationInput,
  HerdrPlatform,
} from "../herdr/types";
import { TerminalProvider } from "../providers/TerminalProvider";
import type { TerminalTransport } from "../terminals/TerminalTransport";
import { TerminalManager } from "../terminals/TerminalManager";

const TERMINAL_ID = "sidebar-shell";
const DEFAULT_DIMENSIONS = { cols: 80, rows: 24 } as const;
const TAKEOVER_DISCLOSURE =
  "Taking control replaces other direct Herdr clients and is not auto-restored";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface HerdrCli {
  versionCheck(): Promise<{ readonly version: string }>;
  listAgents(): Promise<readonly HerdrAgent[]>;
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

export interface UlwExtensionApi {
  readonly onTerminalStart: vscode.Event<number>;
  readonly onTerminalData: vscode.Event<string>;
  readonly onTerminalExit: vscode.Event<number>;
  isTerminalRunning(): boolean;
  terminalCount(): number;
  writeToTerminal(data: string): void;
  toggleEditorLocation(): void;
}

export class ExtensionLifecycle implements vscode.Disposable {
  private terminalManager: TerminalManager | undefined;
  private provider: TerminalProvider | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly options: ExtensionLifecycleOptions = {}) {}

  public activate(context: vscode.ExtensionContext): UlwExtensionApi {
    const terminalManager = new TerminalManager();
    const invocation = this.resolveHerdrInvocation();
    const client = this.createCliClient(invocation);
    let provider: TerminalProvider | undefined;
    const presenter: HerdrAttachPresenter = {
      postReset: () => provider?.postReset(),
      postOutput: (data) => provider?.postOutput(data),
      postSourceState: (state) => provider?.postSourceState(state),
    };
    const createControlTransport =
      this.options.createControlTransport ??
      ((transportOptions: HerdrControlTransportOptions) =>
        new HerdrControlTransport(transportOptions));
    const createAttachController =
      this.options.createAttachController ??
      ((controllerOptions: HerdrAttachControllerOptions) =>
        new HerdrAttachController(controllerOptions));
    const attachController = createAttachController({
      manager: terminalManager,
      terminalId: TERMINAL_ID,
      transportFactory: (target, dimensions) =>
        createControlTransport({
          invocation,
          terminalId: target.terminalId,
          cols: dimensions.cols,
          rows: dimensions.rows,
        }),
      presenter,
    });
    provider = new TerminalProvider(
      context.extensionUri,
      terminalManager,
      attachController,
    );
    this.terminalManager = terminalManager;
    this.provider = provider;

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
      attachController,
      vscode.commands.registerCommand("ulw.toggleEditorLocation", () => {
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
        await this.attachHerdrSession(client, invocation, attachController);
      }),
      vscode.commands.registerCommand("ulw.detachHerdrSession", async () => {
        if (attachController.sourceState.phase === "shell") {
          await vscode.window.showInformationMessage(
            "Not attached to a Herdr session",
          );
          return;
        }
        await attachController.detach();
      }),
    );
    context.subscriptions.push(this);
    provider.openAtConfiguredLocation();

    return {
      onTerminalStart: startEmitter.event,
      onTerminalData: dataEmitter.event,
      onTerminalExit: exitEmitter.event,
      isTerminalRunning: () => provider.isRunning(),
      terminalCount: () => provider.terminalCount(),
      writeToTerminal: (data) => provider.write(data),
      toggleEditorLocation: () => provider.toggleEditorLocation(),
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
    controller: HerdrAttachController,
    showInvocationWarnings = true,
  ): Promise<void> {
    if (
      controller.sourceState.phase === "attaching" ||
      controller.sourceState.phase === "attached"
    ) {
      await vscode.window.showInformationMessage(
        "Already attached to a Herdr session",
      );
      return;
    }

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
        await this.attachSelected(controller, selected);
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
            await this.attachHerdrSession(client, invocation, controller, false);
          }
          return;
        }
        throw error;
      }
    } catch (error) {
      await this.showHerdrFailure(error, client, invocation, controller);
    }
  }

  private async attachSelected(
    controller: HerdrAttachController,
    selected: HerdrQuickPickItem,
  ): Promise<void> {
    let attachFailure: string | undefined;
    const stateSubscription = controller.onSourceState((state) => {
      if (state.phase === "error" && state.message) {
        attachFailure = state.message;
      }
    });
    try {
      await controller.attach(
        { terminalId: selected.agent.terminalId, label: selected.label },
        DEFAULT_DIMENSIONS,
      );
    } finally {
      stateSubscription.dispose();
    }
    if (attachFailure) {
      throw new Error(attachFailure);
    }
  }

  private async showHerdrFailure(
    error: unknown,
    client: HerdrCli,
    invocation: HerdrInvocation,
    controller: HerdrAttachController,
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
        await this.attachHerdrSession(client, invocation, controller, false);
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

  private isStaleTargetError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:pane|terminal|target).*(?:not found|no longer exists)|not found.*(?:pane|terminal|target)/i.test(
      message,
    );
  }
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
