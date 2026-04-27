import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ILogger } from "../services/ILogger";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import { InstanceStore } from "../services/InstanceStore";
import type { TerminalProvider } from "./TerminalProvider";
import {
  TmuxDashboardActionMessage,
  TmuxDashboardHostMessage,
  TmuxDashboardPaneDto,
  TmuxDashboardSessionDto,
  TmuxDashboardWindowDto,
  NativeShellDto,
  AiToolConfig,
  resolveAiToolConfigs,
} from "../types";

/**
 * Terminal Managers provider. Webview-based tmux session manager with inline pane controls (split, switch, resize, swap, kill). Filters sessions to current workspace.
 */
export class TerminalDashboardProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "opencodeTui.terminalDashboard";

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private pendingMessage?: TmuxDashboardHostMessage;
  private static readonly POLL_INTERVAL_MS = 3000;
  private static readonly HTML_VERSION = 16;
  private showAllSessions = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tmuxSessionManager: TmuxSessionManager,
    private readonly logger?: ILogger,
    private readonly instanceStore?: InstanceStore,
    private readonly terminalProvider?: TerminalProvider,
  ) {}

  /**
   * Resolves the webview view and sets up message handling and visibility changes.
   * @param webviewView The webview view to resolve
   * @param _context Webview view resolve context
   * @param _token Cancellation token
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.disposeSubscriptions();
    this.view = webviewView;

    this.configureWebview(webviewView.webview);

    this.subscriptions.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.flushPendingMessage();
          void this.postSessionsToWebview();
          this.startPolling();
        } else {
          this.stopPolling();
        }
      }),
    );

    this.attachCommonSubscriptions(() => {
      this.stopPolling();
      if (this.view === webviewView) {
        this.view = undefined;
      }
    }, webviewView.onDidDispose.bind(webviewView));

    void this.postSessionsToWebview();
    this.startPolling();
  }

  public show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      TerminalDashboardProvider.viewType,
      "Terminal Manager",
      {
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Beside,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      },
    );

    this.disposeSubscriptions();
    this.view = undefined;
    this.panel = panel;
    this.configureWebview(panel.webview);

    this.attachCommonSubscriptions(() => {
      this.stopPolling();
      if (this.panel === panel) {
        this.panel = undefined;
      }
    }, panel.onDidDispose.bind(panel));

    void this.postSessionsToWebview();
    this.startPolling();
  }

  public reveal(): void {
    this.panel?.reveal();
  }

  /**
   * Discovers, filters, and posts tmux sessions and their panes to the webview.
   */
  private async postSessionsToWebview(): Promise<void> {
    const webview = this.getActiveWebview();
    if (!webview) {
      return;
    }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    try {
      const sessions = await this.tmuxSessionManager.discoverSessions();
      const workspaceName = workspacePath
        ? path.basename(workspacePath)
        : undefined;

      this.logger?.debug(
        `[TerminalDashboard] Discovered ${sessions.length} sessions, workspaceName=${workspaceName}, workspacePath=${workspacePath}`,
      );
      for (const s of sessions) {
        this.logger?.debug(
          `[TerminalDashboard]   session: id=${s.id}, workspace=${s.workspace}, isActive=${s.isActive}`,
        );
      }

      let filtered = workspaceName
        ? sessions.filter((session) => session.workspace === workspaceName)
        : sessions;

      if (this.showAllSessions) {
        filtered = sessions;
      }

      this.logger?.debug(
        `[TerminalDashboard] Filtered to ${filtered.length} sessions${this.showAllSessions ? " (global)" : ""}`,
      );

      const panesMap: Record<string, TmuxDashboardPaneDto[]> = {};
      const windowsMap: Record<string, TmuxDashboardWindowDto[]> = {};
      const config = vscode.workspace.getConfiguration("opencodeTui");
      const tools: AiToolConfig[] = resolveAiToolConfigs(
        config.get("aiTools", []),
      );
      for (const session of filtered) {
        try {
          const windows = await this.tmuxSessionManager.listWindows(session.id);
          const windowPanes = await Promise.all(
            windows.map((w) =>
              this.tmuxSessionManager.listWindowPaneGeometry(
                session.id,
                w.windowId,
                tools,
              ),
            ),
          );
          const allPanes = windowPanes.flat();
          panesMap[session.id] = allPanes;
          windowsMap[session.id] = windows.map((w, i) => ({
            windowId: w.windowId,
            index: w.index,
            name: w.name,
            isActive: w.isActive,
            panes: windowPanes[i] ?? [],
          }));
        } catch {
          panesMap[session.id] = [];
          windowsMap[session.id] = [];
        }
      }

      const payload: TmuxDashboardSessionDto[] = filtered.map((session) => ({
        id: session.id,
        name: session.name,
        workspace: session.workspace,
        isActive: session.isActive,
        paneCount: panesMap[session.id]?.length ?? 0,
      }));

      const nativeShells = this.buildNativeShellDtos(
        this.showAllSessions ? undefined : workspacePath,
      );

      const message: TmuxDashboardHostMessage = {
        type: "updateTmuxSessions",
        sessions: payload,
        nativeShells,
        workspace: workspaceName ?? "No workspace",
        panes: panesMap,
        windows: windowsMap,
        showingAll: this.showAllSessions || undefined,
        tools,
        tmuxAvailable: true,
      };

      const posted = await webview.postMessage(message);
      if (!posted) {
        this.logger?.warn(
          `[TerminalDashboard] postMessage returned false (webview not visible), queuing retry`,
        );
        this.scheduleRetryPost(message);
      }
    } catch (error) {
      this.logger?.error(
        `[TerminalDashboardProvider] Failed to load tmux sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
      const fallbackMessage: TmuxDashboardHostMessage = {
        type: "updateTmuxSessions",
        sessions: [],
        nativeShells: this.buildNativeShellDtos(
          this.showAllSessions ? undefined : workspacePath,
        ),
        workspace: "No workspace",
        panes: {},
        tmuxAvailable: false,
      };

      void webview.postMessage(fallbackMessage);
    }
  }

  /**
   * Handles incoming messages from the webview and executes corresponding commands or actions.
   * @param message The message received from the webview
   */
  private async handleWebviewMessage(
    message: TmuxDashboardActionMessage | undefined,
  ): Promise<void> {
    if (!message) {
      return;
    }

    switch (message.action) {
      case "refresh":
        await this.postSessionsToWebview();
        return;
      case "toggleScope":
        this.showAllSessions = !this.showAllSessions;
        await this.postSessionsToWebview();
        return;
      case "activate":
        await vscode.commands.executeCommand(
          "opencodeTui.switchTmuxSession",
          message.sessionId,
        );
        await this.postSessionsToWebview();
        return;
      case "create":
        await vscode.commands.executeCommand("opencodeTui.createTmuxSession");
        await this.postSessionsToWebview();
        return;
      case "switchNativeShell":
        await vscode.commands.executeCommand("opencodeTui.switchNativeShell");
        await this.postSessionsToWebview();
        return;
      case "createNativeShell":
        {
          const newId = `${Date.now()}`;
          const workspacePath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const workspaceUri = workspacePath
            ? vscode.Uri.file(workspacePath).toString()
            : undefined;

          if (this.instanceStore) {
            const shellCount = this.instanceStore
              .getAll()
              .filter((r) => !r.runtime.tmuxSessionId).length;
            this.instanceStore.upsert({
              config: {
                id: newId,
                workspaceUri,
                label: `Shell ${shellCount + 1}`,
              },
              runtime: {},
              state: "disconnected",
            });
            this.instanceStore.setActive(newId);
          }

          await vscode.commands.executeCommand("opencodeTui.switchNativeShell");
          await this.postSessionsToWebview();
        }
        return;
      case "activateNativeShell":
        if (this.instanceStore) {
          try {
            this.instanceStore.setActive(message.instanceId);
            await vscode.commands.executeCommand(
              "opencodeTui.switchNativeShell",
            );
          } catch {
            // instance may not exist, refresh silently
          }
        }
        await this.postSessionsToWebview();
        return;
      case "showAiToolSelector": {
        // Get the active pane to use as the default target for AI tool launch
        let targetPaneId: string | undefined;
        try {
          const panes = await this.tmuxSessionManager.listPanes(
            message.sessionId,
            { activeWindowOnly: true },
          );
          const activePane = panes.find((pane) => pane.isActive);
          if (activePane) {
            targetPaneId = activePane.paneId;
          }
        } catch {
          // If we can't get panes, continue without a specific target
        }
        await this.showAiToolSelector(
          message.sessionId,
          message.sessionName,
          true,
          targetPaneId,
        );
        return;
      }
      case "expandPanes":
        await this.postSessionsToWebview();
        return;
      case "createWindow":
        {
          const panes = await this.tmuxSessionManager.listPanes(
            message.sessionId,
            {
              activeWindowOnly: true,
            },
          );
          const activePane = panes.find((pane) => pane.isActive) ?? panes[0];
          const workspacePath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this.tmuxSessionManager.createWindow(
            message.sessionId,
            activePane?.currentPath ?? workspacePath,
          );
          await this.postSessionsToWebview();
        }
        return;
      case "nextWindow":
        await this.tmuxSessionManager.nextWindow(message.sessionId);
        await this.postSessionsToWebview();
        return;
      case "prevWindow":
        await this.tmuxSessionManager.prevWindow(message.sessionId);
        await this.postSessionsToWebview();
        return;
      case "killWindow":
        await this.tmuxSessionManager.killWindow(message.windowId);
        await this.postSessionsToWebview();
        return;
      case "selectWindow":
        this.logger?.debug(
          `[TerminalDashboard] selectWindow: sessionId=${message.sessionId}, windowId=${message.windowId}`,
        );
        await this.tmuxSessionManager.selectWindow(message.windowId);
        await this.postSessionsToWebview();
        return;
      case "switchPane":
        await this.tmuxSessionManager.selectPane(
          message.paneId,
          message.windowId,
        );
        await this.postSessionsToWebview();
        return;
      case "splitPane":
        {
          const panes = await this.tmuxSessionManager.listPanes(
            message.sessionId,
          );
          const activePane =
            panes.find((pane) => pane.paneId === message.paneId) ??
            panes.find((pane) => pane.isActive) ??
            panes[0];
          const targetPaneId =
            activePane?.paneId ?? message.paneId ?? message.sessionId;
          await this.tmuxSessionManager.splitPane(
            targetPaneId,
            message.direction,
            {
              workingDirectory: activePane?.currentPath,
            },
          );
          await this.postSessionsToWebview();
        }
        return;
      case "splitPaneWithCommand":
        {
          const panes = await this.tmuxSessionManager.listPanes(
            message.sessionId,
          );
          const activePane =
            panes.find((pane) => pane.paneId === message.paneId) ??
            panes.find((pane) => pane.isActive) ??
            panes[0];
          await this.tmuxSessionManager.splitPane(
            activePane?.paneId ?? message.paneId ?? message.sessionId,
            message.direction,
            {
              command: message.command,
              workingDirectory: activePane?.currentPath,
            },
          );
          await this.postSessionsToWebview();
        }
        return;
      case "killPane":
        await this.tmuxSessionManager.killPane(message.paneId);
        await this.postSessionsToWebview();
        return;
      case "resizePane":
        await this.tmuxSessionManager.resizePane(
          message.paneId,
          message.direction as "L" | "R" | "U" | "D",
          message.amount,
        );
        await this.postSessionsToWebview();
        return;
      case "swapPane":
        await this.tmuxSessionManager.swapPanes(
          message.sourcePaneId,
          message.targetPaneId,
        );
        await this.postSessionsToWebview();
        return;
      case "launchAiTool":
        await this.handleLaunchAiTool(
          message.sessionId,
          message.tool,
          message.savePreference,
        );
        await this.postSessionsToWebview();
        return;
      case "killNativeShell": {
        await vscode.commands.executeCommand(
          "opencodeTui.killNativeShell",
          message.instanceId,
        );
        await this.postSessionsToWebview();
        return;
      }
      case "killSession": {
        const sessionsBefore = await this.tmuxSessionManager.discoverSessions();
        const killedSession = sessionsBefore.find(
          (s: TmuxDashboardSessionDto) => s.id === message.sessionId,
        );
        const wasActive = killedSession?.isActive ?? false;
        const killedWorkspace = killedSession?.workspace;

        await vscode.commands.executeCommand(
          "opencodeTui.killTmuxSession",
          message.sessionId,
        );

        if (wasActive && killedWorkspace) {
          const sessionsAfter =
            await this.tmuxSessionManager.discoverSessions();
          const nextSession = sessionsAfter.find(
            (s: TmuxDashboardSessionDto) => s.workspace === killedWorkspace,
          );
          if (nextSession) {
            await vscode.commands.executeCommand(
              "opencodeTui.switchTmuxSession",
              nextSession.id,
            );
          }
        }
        await this.postSessionsToWebview();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Generates the HTML content for the webview by reading the external template.
   * @param webview The webview to generate HTML for
   * @returns The HTML string
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "dashboard.js"),
      )
      .toString();
    const versionedScript = `${scriptUri}?v=${TerminalDashboardProvider.HTML_VERSION}`;
    const cssUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "dashboard.css"),
      )
      .toString();
    const nonce = this.getNonce();

    const templatePath = path.join(
      this.context.extensionPath,
      "dist",
      "dashboard.html",
    );
    const template = fs.readFileSync(templatePath, "utf-8");

    return template
      .replace(/\{\{CSP_SOURCE\}\}/g, webview.cspSource)
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{SCRIPT_URI\}\}/g, versionedScript)
      .replace(/\{\{CSS_URI\}\}/g, cssUri)
      .replace(
        /\{\{HTML_VERSION\}\}/g,
        String(TerminalDashboardProvider.HTML_VERSION),
      );
  }

  /**
   * Shows the AI tool selector in the webview after a new tmux session is created.
   * @param sessionId The newly created session ID
   * @param sessionName Display name for the session
   */
  public async showAiToolSelector(
    sessionId: string,
    sessionName: string,
    forceShow = false,
    targetPaneId?: string,
  ): Promise<void> {
    if (this.terminalProvider) {
      this.terminalProvider.showAiToolSelector(
        sessionId,
        sessionName,
        forceShow,
        targetPaneId,
      );
      return;
    }

    const webview = this.getActiveWebview();
    if (!webview) {
      return;
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const tools: AiToolConfig[] = resolveAiToolConfigs(
      config.get("aiTools", []),
    );

    await webview.postMessage({
      type: "showAiToolSelector",
      sessionId,
      sessionName,
      defaultTool: undefined,
      tools,
      targetPaneId,
    } satisfies TmuxDashboardHostMessage);
  }

  /**
   * Handles AI tool selection from the webview.
   * Launches the selected tool in the target pane of the tmux session.
   */
  private async handleLaunchAiTool(
    sessionId: string,
    toolName: string,
    savePreference: boolean,
    targetPaneId?: string,
  ): Promise<void> {
    if (!this.terminalProvider) {
      return;
    }

    try {
      await this.terminalProvider.launchAiTool(
        sessionId,
        toolName,
        savePreference,
        targetPaneId,
      );
    } catch (error) {
      this.logger?.error(
        `[TerminalDashboardProvider] Failed to launch AI tool: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Builds native shell DTOs from InstanceStore records that have no tmux session.
   * @param workspacePath The current workspace path for filtering
   * @returns Array of native shell DTOs
   */
  private buildNativeShellDtos(workspacePath?: string): NativeShellDto[] {
    if (!this.instanceStore) {
      return [];
    }

    try {
      const activeRecord = this.instanceStore.getActive();
      const activeId = activeRecord?.config.id;

      return this.instanceStore
        .getAll()
        .filter((record) => {
          // Only include native shell instances (no tmux session)
          if (record.runtime.tmuxSessionId) {
            return false;
          }
          // Filter by workspace if available
          if (workspacePath) {
            const recordWorkspace = record.config.workspaceUri
              ? vscode.Uri.parse(record.config.workspaceUri).fsPath
              : undefined;
            if (recordWorkspace !== workspacePath) {
              return false;
            }
          }
          return true;
        })
        .map((record) => ({
          id: record.config.id,
          label: record.config.label,
          state: record.state,
          isActive: record.config.id === activeId,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Generates a random nonce for CSP.
   * @returns A random 32-character string
   */
  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Disposes of subscriptions and cleans up resources.
   */
  public dispose(): void {
    this.stopPolling();
    this.disposeSubscriptions();
    this.view = undefined;
    this.panel = undefined;
  }

  private disposeSubscriptions(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.postSessionsToWebview();
    }, TerminalDashboardProvider.POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private scheduleRetryPost(message: TmuxDashboardHostMessage): void {
    this.pendingMessage = message;
  }

  private flushPendingMessage(): void {
    const webview = this.getActiveWebview();
    if (this.pendingMessage && webview) {
      webview.postMessage(this.pendingMessage);
      this.pendingMessage = undefined;
    }
  }

  private configureWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webview.html = this.getHtmlContent(webview);
  }

  private attachCommonSubscriptions(
    onDispose: () => void,
    registerDispose: (listener: () => void) => vscode.Disposable,
  ): void {
    const webview = this.getActiveWebview();
    if (!webview) {
      return;
    }

    this.subscriptions.push(
      webview.onDidReceiveMessage((message) => {
        void this.handleWebviewMessage(message as TmuxDashboardActionMessage);
      }),
    );

    this.subscriptions.push(
      this.tmuxSessionManager.onPaneChanged(() => {
        void this.postSessionsToWebview();
      }),
    );

    this.subscriptions.push(registerDispose(onDispose));
  }

  private getActiveWebview(): vscode.Webview | undefined {
    return this.panel?.webview ?? this.view?.webview;
  }
}
