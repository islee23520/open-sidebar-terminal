import * as vscode from "vscode";
import { TerminalProvider } from "../providers/TerminalProvider";
import { OpenCodeCodeActionProvider } from "../providers/CodeActionProvider";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { ContextManager } from "../services/ContextManager";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceDiscoveryService } from "../services/InstanceDiscoveryService";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { InstanceStore } from "../services/InstanceStore";
import { InstanceRegistry } from "../services/InstanceRegistry";
import { InstanceQuickPick } from "../services/InstanceQuickPick";
import { InstanceController } from "../services/InstanceController";
import { PortManager } from "../services/PortManager";
import { ConnectionResolver } from "../services/ConnectionResolver";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import { TerminalDashboardProvider } from "../providers/TerminalDashboardProvider";
import {
  registerCommands as registerAllCommands,
  type RegisterCommandDependencies,
} from "./commands";

/**
 * Manages extension activation, service initialization, and cleanup.
 */
export class ExtensionLifecycle {
  private terminalManager: TerminalManager | undefined;
  private tuiProvider: TerminalProvider | undefined;
  private captureManager: OutputCaptureManager | undefined;
  private contextSharingService: ContextSharingService | undefined;
  private outputChannelService: OutputChannelService | undefined;
  private contextManager: ContextManager | undefined;
  private instanceDiscoveryService: InstanceDiscoveryService | undefined;
  private codeActionProvider: OpenCodeCodeActionProvider | undefined;
  private instanceStore: InstanceStore | undefined;
  private instanceRegistry: InstanceRegistry | undefined;
  private instanceQuickPick: InstanceQuickPick | undefined;
  private instanceController: InstanceController | undefined;
  private portManager: PortManager | undefined;
  private tmuxSessionManager: TmuxSessionManager | undefined;
  private terminalDashboardProvider: TerminalDashboardProvider | undefined;

  private static readonly TERMINAL_ID = "opencode-main";

  /** Returns the terminal ID for the active instance, falling back to the static default. */
  private getActiveTerminalId(): string {
    try {
      const active = this.instanceStore?.getActive();
      if (active?.runtime.terminalKey) {
        this.outputChannelService?.info(
          `[DIAG:getActiveTerminalId] resolved terminalKey="${active.runtime.terminalKey}" for instance="${active.config.id}" tmuxSession="${active.runtime.tmuxSessionId}"`,
        );
        return active.runtime.terminalKey;
      }
      if (active) {
        this.outputChannelService?.warn(
          `[DIAG:getActiveTerminalId] NO terminalKey for instance="${active.config.id}", falling back to config.id="${active.config.id}"`,
        );
        return active.config.id;
      }
      this.outputChannelService?.warn(
        `[DIAG:getActiveTerminalId] NO active instance, falling back to TERMINAL_ID="${ExtensionLifecycle.TERMINAL_ID}"`,
      );
      return ExtensionLifecycle.TERMINAL_ID;
    } catch (err) {
      this.outputChannelService?.error(
        `[DIAG:getActiveTerminalId] ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
      return ExtensionLifecycle.TERMINAL_ID;
    }
  }

  private resolveActiveTmuxSessionId(): string | undefined {
    try {
      return this.instanceStore?.getActive()?.runtime.tmuxSessionId;
    } catch {
      return undefined;
    }
  }

  async activate(context: vscode.ExtensionContext): Promise<void> {
    const logger = OutputChannelService.getInstance();
    logger.info("Initializing OpenCode Sidebar TUI...");

    try {
      // Initialize terminal manager
      this.terminalManager = new TerminalManager();

      // Initialize services
      this.captureManager = new OutputCaptureManager();
      this.contextSharingService = new ContextSharingService();
      this.outputChannelService = logger;
      this.contextManager = new ContextManager(this.outputChannelService);
      this.instanceDiscoveryService = new InstanceDiscoveryService();

      // Initialize multi-instance support
      this.instanceStore = new InstanceStore();
      this.portManager = new PortManager(this.instanceStore);
      const tmuxSessionManager = new TmuxSessionManager();
      if (await tmuxSessionManager.isAvailable()) {
        this.tmuxSessionManager = tmuxSessionManager;
      } else {
        logger.info(
          "[ExtensionLifecycle] tmux not detected; using native terminal shell behavior",
        );
      }
      this.instanceRegistry = new InstanceRegistry(context);
      this.instanceRegistry.hydrate(this.instanceStore);

      context.subscriptions.push(this.contextManager);
      context.subscriptions.push(this.instanceDiscoveryService);

      this.instanceQuickPick = new InstanceQuickPick(
        this.instanceStore,
        this.instanceDiscoveryService,
      );

      // Initialize instance controller for spawn/connect/kill
      const connectionResolver = new ConnectionResolver(
        this.instanceStore,
        this.instanceDiscoveryService,
      );
      this.instanceController = new InstanceController(
        this.terminalManager,
        this.instanceStore,
        this.portManager,
        logger.getChannel(),
        connectionResolver,
      );

      // Handle terminal closure for cleanup
      context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
          this.captureManager?.cleanup(terminal);
        }),
      );

      // Initialize TUI provider
      this.tuiProvider = new TerminalProvider(
        context,
        this.terminalManager,
        this.captureManager,
        this.portManager,
        this.instanceStore,
        this.tmuxSessionManager,
      );

      // Register webview provider
      const provider = vscode.window.registerWebviewViewProvider(
        TerminalProvider.viewType,
        this.tuiProvider,
        {
          webviewOptions: {
            retainContextWhenHidden: true,
          },
        },
      );
      context.subscriptions.push(provider);

      if (this.tmuxSessionManager) {
        this.terminalDashboardProvider = new TerminalDashboardProvider(
          context,
          this.tmuxSessionManager,
          logger.getChannel(),
          this.instanceStore,
          this.tuiProvider,
        );
        const tmuxDashboardProvider = vscode.window.registerWebviewViewProvider(
          TerminalDashboardProvider.viewType,
          this.terminalDashboardProvider,
          {
            webviewOptions: {
              retainContextWhenHidden: true,
            },
          },
        );
        context.subscriptions.push(tmuxDashboardProvider);
      }

      // Register commands
      this.registerCommands(context);

      this.codeActionProvider = new OpenCodeCodeActionProvider(
        this.contextManager,
        (prompt) => this.sendPromptToOpenCode(prompt),
      );

      const codeActionRegistration =
        vscode.languages.registerCodeActionsProvider(
          "*",
          this.codeActionProvider,
          {
            providedCodeActionKinds:
              OpenCodeCodeActionProvider.providedCodeActionKinds,
          },
        );
      const explainAndFixCommand = this.codeActionProvider.registerCommand();
      context.subscriptions.push(codeActionRegistration, explainAndFixCommand);

      logger.info("OpenCode Sidebar TUI activated successfully");
    } catch (error) {
      logger.error(
        `Failed to activate OpenCode Sidebar TUI: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.showErrorMessage(
        `Failed to activate OpenCode Sidebar TUI: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getCommandDependencies(): RegisterCommandDependencies {
    const self = this;
    return {
      get provider() {
        return self.tuiProvider;
      },
      get tmuxManager() {
        return self.tmuxSessionManager;
      },
      get terminalManager() {
        return self.terminalManager;
      },
      get contextSharingService() {
        return self.contextSharingService;
      },
      get contextManager() {
        return self.contextManager;
      },
      get instanceStore() {
        return self.instanceStore;
      },
      get instanceController() {
        return self.instanceController;
      },
      get instanceQuickPick() {
        return self.instanceQuickPick;
      },
      get outputChannel() {
        return self.outputChannelService;
      },
      getActiveTerminalId: () => this.getActiveTerminalId(),
      sendTerminalCwd: () => this.sendTerminalCwd(),
      sendPrompt: (prompt: string) =>
        this.tuiProvider?.sendPrompt(prompt) ?? Promise.resolve(),
      resolveActiveTmuxSessionId: () => this.resolveActiveTmuxSessionId(),
    };
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    registerAllCommands(context, this.getCommandDependencies());
  }

  private async sendPromptToOpenCode(prompt: string): Promise<void> {
    if (!this.tuiProvider || !this.terminalManager) {
      throw new Error("OpenCode provider is not initialized");
    }

    if (!this.terminalManager.getTerminal(this.getActiveTerminalId())) {
      const sentByDiscovery =
        await this.trySendPromptViaDiscoveredInstance(prompt);
      if (sentByDiscovery) {
        return;
      }

      await this.tuiProvider.startOpenCode();
    }

    const apiClient = this.tuiProvider.getApiClient();
    if (apiClient && this.tuiProvider.isHttpAvailable()) {
      try {
        await apiClient.appendPrompt(prompt);
      } catch (error) {
        this.outputChannelService?.warn(
          `Failed to send prompt via HTTP API, falling back to terminal input: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.terminalManager.writeToTerminal(
          this.getActiveTerminalId(),
          `${prompt}\n`,
        );
      }
    } else {
      this.terminalManager.writeToTerminal(
        this.getActiveTerminalId(),
        `${prompt}\n`,
      );
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    if (config.get<boolean>("autoFocusOnSend", true)) {
      vscode.commands.executeCommand("opencodeTui.focus");
      setTimeout(() => {
        this.tuiProvider?.focus();
      }, 100);
    }
  }

  private async trySendPromptViaDiscoveredInstance(
    prompt: string,
  ): Promise<boolean> {
    if (!this.instanceDiscoveryService) {
      return false;
    }

    try {
      const discovered =
        await this.instanceDiscoveryService.discoverInstances();
      const primary = discovered[0];
      if (!primary) {
        return false;
      }

      const client = new OpenCodeApiClient(primary.port, 3, 200, 3000);
      await client.appendPrompt(prompt);
      this.outputChannelService?.info(
        `Sent prompt via discovered OpenCode instance on port ${primary.port}`,
      );
      return true;
    } catch (error) {
      this.outputChannelService?.warn(
        `Failed to send prompt via discovered instance: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private sendTerminalCwd(): void {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
      vscode.window.showWarningMessage("No active terminal");
      return;
    }

    const cwd = activeTerminal.shellIntegration?.cwd?.fsPath;
    if (!cwd) {
      vscode.window.showWarningMessage(
        "Could not determine terminal working directory. Make sure shell integration is enabled.",
      );
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const reference =
      workspaceFolders && workspaceFolders.length > 0
        ? `@${vscode.workspace.asRelativePath(cwd, false)}`
        : `@${cwd}`;

    this.terminalManager?.writeToTerminal(
      this.getActiveTerminalId(),
      reference + " ",
    );

    const config = vscode.workspace.getConfiguration("opencodeTui");
    if (config.get<boolean>("autoFocusOnSend", true)) {
      vscode.commands.executeCommand("opencodeTui.focus");
      setTimeout(() => {
        this.tuiProvider?.focus();
      }, 100);
    }
  }

  private async promptKillTmuxSessions(): Promise<void> {
    if (!this.tmuxSessionManager) {
      return;
    }

    const allSessions = await this.tmuxSessionManager.discoverSessions();

    if (allSessions.length === 0) {
      return;
    }

    const count = allSessions.length;
    const answer = await vscode.window.showWarningMessage(
      `${count} tmux ${count === 1 ? "session is" : "sessions are"} running. Kill ${count === 1 ? "it" : "them"} when closing VS Code?`,
      { modal: true },
      "Kill Sessions",
      "Keep Running",
    );

    if (answer === "Kill Sessions") {
      const instanceSessionIds = new Set(
        this.instanceStore
          ?.getAll()
          .map((r) => r.runtime.tmuxSessionId)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ) ?? [],
      );

      await Promise.allSettled(
        allSessions.map((session) => {
          if (instanceSessionIds.has(session.id)) {
            return (
              this.tuiProvider?.killTmuxSession(session.id) ?? Promise.resolve()
            );
          }
          return this.tmuxSessionManager!.killSession(session.id);
        }),
      );
    }
  }

  async deactivate(): Promise<void> {
    this.outputChannelService?.info("Deactivating OpenCode Sidebar TUI...");

    await this.promptKillTmuxSessions();

    if (this.tuiProvider) {
      this.tuiProvider.dispose();
      this.tuiProvider = undefined;
    }

    if (this.terminalManager) {
      this.terminalManager.dispose();
      this.terminalManager = undefined;
    }

    const logger = this.outputChannelService;

    if (this.outputChannelService) {
      this.outputChannelService.dispose();
      this.outputChannelService = undefined;
      OutputChannelService.resetInstance();
    }

    if (this.contextManager) {
      this.contextManager.dispose();
      this.contextManager = undefined;
    }

    if (this.instanceDiscoveryService) {
      this.instanceDiscoveryService.dispose();
      this.instanceDiscoveryService = undefined;
    }

    if (this.instanceRegistry) {
      this.instanceRegistry.dispose();
      this.instanceRegistry = undefined;
    }

    if (this.instanceStore) {
      this.instanceStore = undefined;
    }

    if (this.terminalDashboardProvider) {
      this.terminalDashboardProvider.dispose();
      this.terminalDashboardProvider = undefined;
    }

    this.codeActionProvider = undefined;

    this.captureManager = undefined;
    this.contextSharingService = undefined;

    logger?.info("OpenCode Sidebar TUI deactivated");
  }
}
