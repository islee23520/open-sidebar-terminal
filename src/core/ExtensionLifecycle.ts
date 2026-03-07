import * as vscode from "vscode";
import { CliToolType } from "../types";
import { OpenCodeTuiProvider } from "../providers/OpenCodeTuiProvider";
import { OpenCodeCodeActionProvider } from "../providers/CodeActionProvider";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { StatusBarManager } from "../services/StatusBarManager";
import { ContextManager } from "../services/ContextManager";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceDiscoveryService } from "../services/InstanceDiscoveryService";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { InstanceStore } from "../services/InstanceStore";
import { InstanceRegistry } from "../services/InstanceRegistry";
import { InstancesDashboardProvider } from "../providers/InstancesDashboardProvider";
import { InstanceQuickPick } from "../services/InstanceQuickPick";
import { InstanceController } from "../services/InstanceController";
import { PortManager } from "../services/PortManager";
import { ConnectionResolver } from "../services/ConnectionResolver";
import { ConfigMigration } from "../services/ConfigMigration";

// Module-level state for batching file sends from context menu
let fileSendAccumulator: vscode.Uri[] = [];
let fileSendTimeout: NodeJS.Timeout | undefined;

/**
 * Manages extension activation, service initialization, and cleanup.
 */
export class ExtensionLifecycle {
  private terminalManager: TerminalManager | undefined;
  private tuiProvider: OpenCodeTuiProvider | undefined;
  private captureManager: OutputCaptureManager | undefined;
  private contextSharingService: ContextSharingService | undefined;
  private statusBarManager: StatusBarManager | undefined;
  private outputChannelService: OutputChannelService | undefined;
  private contextManager: ContextManager | undefined;
  private instanceDiscoveryService: InstanceDiscoveryService | undefined;
  private codeActionProvider: OpenCodeCodeActionProvider | undefined;
  private instanceStore: InstanceStore | undefined;
  private instanceRegistry: InstanceRegistry | undefined;
  private instancesDashboardProvider: InstancesDashboardProvider | undefined;
  private instanceQuickPick: InstanceQuickPick | undefined;
  private instanceController: InstanceController | undefined;
  private portManager: PortManager | undefined;

  private static readonly TERMINAL_ID = "opencode-main";

  /** Returns the terminal ID for the active instance, falling back to the static default. */
  private getActiveTerminalId(): string {
    try {
      const active = this.instanceStore?.getActive();
      if (active?.runtime.terminalKey) {
        return active.runtime.terminalKey;
      }
      if (active) {
        return active.config.id;
      }
      return ExtensionLifecycle.TERMINAL_ID;
    } catch {
      return ExtensionLifecycle.TERMINAL_ID;
    }
  }

  async activate(context: vscode.ExtensionContext): Promise<void> {
    const logger = OutputChannelService.getInstance();
    logger.info("Initializing OpenCode Sidebar TUI...");

    try {
      await ConfigMigration.migrate();

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
      this.instanceRegistry = new InstanceRegistry(context);
      this.instanceRegistry.hydrate(this.instanceStore);

      // Initialize status bar with instance store for live updates
      this.statusBarManager = new StatusBarManager(this.instanceStore);
      this.statusBarManager.show();
      context.subscriptions.push(this.statusBarManager);
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
      this.tuiProvider = new OpenCodeTuiProvider(
        context,
        this.terminalManager,
        this.captureManager,
        this.instanceStore,
      );

      // Register webview provider
      const provider = vscode.window.registerWebviewViewProvider(
        OpenCodeTuiProvider.viewType,
        this.tuiProvider,
        {
          webviewOptions: {
            retainContextWhenHidden: true,
          },
        },
      );
      context.subscriptions.push(provider);

      // Register instances dashboard provider
      this.instancesDashboardProvider = new InstancesDashboardProvider(
        context,
        this.instanceStore,
        this.instanceController,
        logger.getChannel(),
      );
      const dashboardProvider = vscode.window.registerWebviewViewProvider(
        InstancesDashboardProvider.viewType,
        this.instancesDashboardProvider,
      );
      context.subscriptions.push(dashboardProvider);

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

  private registerCommands(context: vscode.ExtensionContext): void {
    // Start OpenCode command
    const startCommand = vscode.commands.registerCommand(
      "opencodeTui.start",
      () => {
        this.tuiProvider?.startOpenCode();
      },
    );

    // Send selected text to terminal
    const sendToTerminalCommand = vscode.commands.registerCommand(
      "opencodeTui.sendToTerminal",
      () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
          const selectedText = editor.document.getText(editor.selection);
          this.terminalManager?.writeToTerminal(
            this.getActiveTerminalId(),
            selectedText + "\n",
          );

          // Auto-focus sidebar if enabled
          const config = vscode.workspace.getConfiguration("opencodeTui");
          if (config.get<boolean>("autoFocusOnSend", true)) {
            vscode.commands.executeCommand("opencodeTui.focus");
            // Also focus the terminal inside the webview
            setTimeout(() => {
              this.tuiProvider?.focus();
            }, 100);
          }

          vscode.window.setStatusBarMessage("$(check) Sent to OpenCode", 3000);
        }
      },
    );

    // Send current file reference (@filename) or terminal CWD
    const sendAtMentionCommand = vscode.commands.registerCommand(
      "opencodeTui.sendAtMention",
      () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && this.contextSharingService) {
          const fileRef =
            this.contextSharingService.formatFileRefWithLineNumbers(editor);
          this.terminalManager?.writeToTerminal(
            this.getActiveTerminalId(),
            fileRef + " ",
          );

          // Auto-focus sidebar if enabled
          const config = vscode.workspace.getConfiguration("opencodeTui");
          if (config.get<boolean>("autoFocusOnSend", true)) {
            vscode.commands.executeCommand("opencodeTui.focus");
            // Also focus the terminal inside the webview
            setTimeout(() => {
              this.tuiProvider?.focus();
            }, 100);
          }

          vscode.window.setStatusBarMessage(`$(check) Sent ${fileRef}`, 3000);
        } else {
          this.sendTerminalCwd();
        }
      },
    );

    // Send all open file references
    const sendAllOpenFilesCommand = vscode.commands.registerCommand(
      "opencodeTui.sendAllOpenFiles",
      () => {
        const fileRefs: string[] = [];

        // Get all opened tabs across all editor groups (not just visible ones)
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
              const uri = tab.input.uri;
              // Skip untitled/unsaved documents
              if (
                !uri.scheme.startsWith("untitled") &&
                this.contextSharingService
              ) {
                fileRefs.push(this.contextSharingService.formatFileRef(uri));
              }
            }
          }
        }

        const openFiles = fileRefs.join(" ");

        if (openFiles) {
          this.terminalManager?.writeToTerminal(
            this.getActiveTerminalId(),
            openFiles + " ",
          );

          // Auto-focus sidebar if enabled
          const config = vscode.workspace.getConfiguration("opencodeTui");
          if (config.get<boolean>("autoFocusOnSend", true)) {
            vscode.commands.executeCommand("opencodeTui.focus");
            // Also focus the terminal inside the webview
            setTimeout(() => {
              this.tuiProvider?.focus();
            }, 100);
          }

          vscode.window.setStatusBarMessage(
            "$(check) Sent all open files",
            3000,
          );
        }
      },
    );

    // Send file/folder from explorer context menu
    const sendFileToTerminalCommand = vscode.commands.registerCommand(
      "opencodeTui.sendFileToTerminal",
      (...args: unknown[]) => {
        if (!this.contextSharingService) {
          return;
        }

        // VS Code explorer context menu passes (clickedUri, allSelectedUris)
        // When multiple files are selected, the last argument is a Uri[]
        let uris: vscode.Uri[];
        if (args.length > 0 && Array.isArray(args[args.length - 1])) {
          uris = args[args.length - 1] as vscode.Uri[];
        } else if (args.length > 0 && args[0] instanceof vscode.Uri) {
          uris = [args[0]];
        } else {
          return;
        }
        fileSendAccumulator.push(...uris);

        if (fileSendTimeout) {
          clearTimeout(fileSendTimeout);
        }

        fileSendTimeout = setTimeout(() => {
          if (fileSendAccumulator.length === 0) {
            return;
          }

          const uniqueUris = [
            ...new Map(
              fileSendAccumulator.map((u: vscode.Uri) => [u.fsPath, u]),
            ).values(),
          ];

          const fileRefs = uniqueUris.map((u: vscode.Uri) =>
            this.contextSharingService!.formatFileRef(u),
          );
          const allRefs = fileRefs.join(" ");

          this.terminalManager?.writeToTerminal(
            this.getActiveTerminalId(),
            allRefs + " ",
          );

          const config = vscode.workspace.getConfiguration("opencodeTui");
          if (config.get<boolean>("autoFocusOnSend", true)) {
            vscode.commands.executeCommand("opencodeTui.focus");
            setTimeout(() => {
              this.tuiProvider?.focus();
            }, 100);
          }

          const message =
            uniqueUris.length > 1
              ? `Sent ${uniqueUris.length} files`
              : `Sent ${fileRefs[0]}`;
          vscode.window.setStatusBarMessage(`$(check) ${message}`, 3000);

          fileSendAccumulator = [];
        }, 100);
      },
    );

    // Restart OpenCode command
    const restartCommand = vscode.commands.registerCommand(
      "opencodeTui.restart",
      () => {
        this.tuiProvider?.restart();
        vscode.window.showInformationMessage("OpenCode restarted");
      },
    );

    const pasteCommand = vscode.commands.registerCommand(
      "opencodeTui.paste",
      async () => {
        try {
          const text = await vscode.env.clipboard.readText();
          if (text && this.tuiProvider) {
            this.tuiProvider.pasteText(text);
          }
        } catch (error) {
          this.outputChannelService?.error(
            `[OpenCodeTui] Failed to paste: ${error instanceof Error ? error.message : String(error)}`,
          );
          vscode.window.showErrorMessage("Failed to paste from clipboard");
        }
      },
    );

    // Open in new window
    const openInNewWindowCommand = vscode.commands.registerCommand(
      "opencode.openInNewWindow",
      async () => {
        if (!this.instanceStore) {
          vscode.window.showErrorMessage("Instance store is not initialized");
          return;
        }

        try {
          const active = this.instanceStore.getActive();
          const newId = `${Date.now()}`;
          const newRecord = {
            config: {
              id: newId,
              workspaceUri: active.config.workspaceUri,
              label: `${active.config.label || "OpenCode"} (New Window)`,
            },
            runtime: {},
            state: "disconnected" as const,
          };

          this.instanceStore.upsert(newRecord);

          // Actually open the workspace in a new VS Code window
          if (newRecord.config.workspaceUri) {
            vscode.commands.executeCommand(
              "vscode.openFolder",
              vscode.Uri.parse(newRecord.config.workspaceUri),
              true,
            );
          }
          vscode.window.showInformationMessage(
            `Opened in new window: ${newRecord.config.label}`,
          );
        } catch (error) {
          this.outputChannelService?.error(
            `Failed to open in new window: ${error instanceof Error ? error.message : String(error)}`,
          );
          vscode.window.showErrorMessage(
            `Failed to open in new window: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    // Spawn for workspace
    const spawnForWorkspaceCommand = vscode.commands.registerCommand(
      "opencode.spawnForWorkspace",
      async (uri?: vscode.Uri) => {
        if (!this.instanceStore) {
          vscode.window.showErrorMessage("Instance store is not initialized");
          return;
        }

        try {
          const workspaceUri =
            uri?.toString() ||
            vscode.workspace.workspaceFolders?.[0]?.uri.toString();
          if (!workspaceUri) {
            vscode.window.showWarningMessage("No workspace folder available");
            return;
          }

          const newId = `${Date.now()}`;
          const newRecord = {
            config: {
              id: newId,
              workspaceUri,
              label: `OpenCode (${vscode.workspace.name || "Workspace"})`,
            },
            runtime: {},
            state: "disconnected" as const,
          };

          this.instanceStore.upsert(newRecord);

          // Actually spawn the OpenCode process for this instance
          await this.instanceController?.spawn(newId);
          vscode.window.showInformationMessage(
            `Spawned OpenCode for workspace: ${newRecord.config.label}`,
          );
        } catch (error) {
          this.outputChannelService?.error(
            `Failed to spawn for workspace: ${error instanceof Error ? error.message : String(error)}`,
          );
          vscode.window.showErrorMessage(
            `Failed to spawn for workspace: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );

    const selectInstanceCommand = vscode.commands.registerCommand(
      "opencodeTui.selectInstance",
      () => {
        this.instanceQuickPick?.show();
      },
    );

    const createTabCommand = vscode.commands.registerCommand(
      "opencodeTui.createTab",
      async () => {
        const tools: { label: string; id: CliToolType }[] = [
          { label: "OpenCode", id: "opencode" },
          { label: "Claude", id: "claude" },
          { label: "Codex", id: "codex" },
          { label: "Gemini", id: "gemini" },
          { label: "Aider", id: "aider" },
        ];

        const selected = await vscode.window.showQuickPick(tools, {
          placeHolder: "Select a tool to create a new tab",
        });

        if (selected) {
          await this.tuiProvider?.createTab(selected.id);
        }
      },
    );

    const createOpencodeTabCommand = vscode.commands.registerCommand(
      "opencodeTui.createTab.opencode",
      () => this.tuiProvider?.createTab("opencode"),
    );
    const createClaudeTabCommand = vscode.commands.registerCommand(
      "opencodeTui.createTab.claude",
      () => this.tuiProvider?.createTab("claude"),
    );
    const createCodexTabCommand = vscode.commands.registerCommand(
      "opencodeTui.createTab.codex",
      () => this.tuiProvider?.createTab("codex"),
    );
    const createGeminiTabCommand = vscode.commands.registerCommand(
      "opencodeTui.createTab.gemini",
      () => this.tuiProvider?.createTab("gemini"),
    );
    const createAiderTabCommand = vscode.commands.registerCommand(
      "opencodeTui.createTab.aider",
      () => this.tuiProvider?.createTab("aider"),
    );

    const closeTabCommand = vscode.commands.registerCommand(
      "opencodeTui.closeTab",
      () => {
        const activeTab = this.tuiProvider?.getActiveTab();
        if (activeTab) {
          this.tuiProvider?.closeTab(activeTab.id);
        }
      },
    );

    const nextTabCommand = vscode.commands.registerCommand(
      "opencodeTui.nextTab",
      () => this.tuiProvider?.nextTab(),
    );

    const previousTabCommand = vscode.commands.registerCommand(
      "opencodeTui.previousTab",
      () => this.tuiProvider?.previousTab(),
    );

    context.subscriptions.push(
      startCommand,
      sendToTerminalCommand,
      sendAtMentionCommand,
      sendAllOpenFilesCommand,
      sendFileToTerminalCommand,
      restartCommand,
      pasteCommand,
      openInNewWindowCommand,
      spawnForWorkspaceCommand,
      selectInstanceCommand,
      createTabCommand,
      createOpencodeTabCommand,
      createClaudeTabCommand,
      createCodexTabCommand,
      createGeminiTabCommand,
      createAiderTabCommand,
      closeTabCommand,
      nextTabCommand,
      previousTabCommand,
    );
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

    vscode.window.setStatusBarMessage(`$(check) Sent ${reference}`, 3000);
  }

  async deactivate(): Promise<void> {
    this.outputChannelService?.info("Deactivating OpenCode Sidebar TUI...");

    if (this.tuiProvider) {
      this.tuiProvider.dispose();
      this.tuiProvider = undefined;
    }

    if (this.terminalManager) {
      this.terminalManager.dispose();
      this.terminalManager = undefined;
    }

    if (this.statusBarManager) {
      this.statusBarManager.dispose();
      this.statusBarManager = undefined;
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

    if (this.instancesDashboardProvider) {
      this.instancesDashboardProvider.dispose();
      this.instancesDashboardProvider = undefined;
    }

    if (this.instanceStore) {
      this.instanceStore = undefined;
    }

    this.codeActionProvider = undefined;

    this.captureManager = undefined;
    this.contextSharingService = undefined;

    logger?.info("OpenCode Sidebar TUI deactivated");
  }
}
