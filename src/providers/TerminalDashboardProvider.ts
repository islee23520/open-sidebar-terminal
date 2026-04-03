import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import { InstanceStore } from "../services/InstanceStore";
import {
  TmuxDashboardActionMessage,
  TmuxDashboardHostMessage,
  TmuxDashboardPaneDto,
  TmuxDashboardSessionDto,
  TmuxDashboardWindowDto,
  NativeShellDto,
  AiTool,
  AiToolConfig,
  resolveAiToolConfigs,
  getToolLaunchCommand,
  getToolDetectionPatterns,
} from "../types";

/**
 * Terminal Dashboard provider. Webview-based tmux session manager with inline pane controls (split, switch, resize, swap, kill). Filters sessions to current workspace.
 */
export class TerminalDashboardProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "opencodeTui.terminalDashboard";

  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private pendingMessage?: TmuxDashboardHostMessage;
  private static readonly POLL_INTERVAL_MS = 3000;
  private static readonly HTML_VERSION = 16;
  private showAllSessions = false;

  /**
   * @param context Extension context
   * @param tmuxSessionManager Tmux session manager service
   * @param outputChannel Optional output channel for logging
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tmuxSessionManager: TmuxSessionManager,
    private readonly outputChannel?: vscode.OutputChannel,
    private readonly instanceStore?: InstanceStore,
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

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    this.subscriptions.push(
      webviewView.webview.onDidReceiveMessage((message) => {
        void this.handleWebviewMessage(message as TmuxDashboardActionMessage);
      }),
    );

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

    this.subscriptions.push(
      this.tmuxSessionManager.onPaneChanged(() => {
        void this.postSessionsToWebview();
      }),
    );

    this.subscriptions.push(
      webviewView.onDidDispose(() => {
        this.stopPolling();
        if (this.view === webviewView) {
          this.view = undefined;
        }
      }),
    );

    void this.postSessionsToWebview();
    this.startPolling();
  }

  /**
   * Discovers, filters, and posts tmux sessions and their panes to the webview.
   */
  private async postSessionsToWebview(): Promise<void> {
    if (!this.view) {
      return;
    }

    try {
      const sessions = await this.tmuxSessionManager.discoverSessions();
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const workspaceName = workspacePath
        ? path.basename(workspacePath)
        : undefined;

      this.outputChannel?.appendLine(
        `[TerminalDashboard] Discovered ${sessions.length} sessions, workspaceName=${workspaceName}, workspacePath=${workspacePath}`,
      );
      for (const s of sessions) {
        this.outputChannel?.appendLine(
          `[TerminalDashboard]   session: id=${s.id}, workspace=${s.workspace}, isActive=${s.isActive}`,
        );
      }

      let filtered = workspaceName
        ? sessions.filter((session) => session.workspace === workspaceName)
        : sessions;

      if (this.showAllSessions) {
        filtered = sessions;
      }

      this.outputChannel?.appendLine(
        `[TerminalDashboard] Filtered to ${filtered.length} sessions${this.showAllSessions ? " (global)" : ""}`,
      );

      const panesMap: Record<string, TmuxDashboardPaneDto[]> = {};
      const windowsMap: Record<string, TmuxDashboardWindowDto[]> = {};
      for (const session of filtered) {
        try {
          const [panes, windows] = await Promise.all([
            this.listPanesForSession(session.id),
            this.tmuxSessionManager.listWindows(session.id),
          ]);
          panesMap[session.id] = panes;
          windowsMap[session.id] = windows.map((w) => ({
            windowId: w.windowId,
            index: w.index,
            name: w.name,
            isActive: w.isActive,
            panes: panes.filter((p) => p.windowId === w.windowId),
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

      const config = vscode.workspace.getConfiguration("opencodeTui");
      const tools: AiToolConfig[] = resolveAiToolConfigs(
        config.get("aiTools", []),
      );

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
      };

      const posted = await this.view.webview.postMessage(message);
      if (!posted) {
        this.outputChannel?.appendLine(
          `[TerminalDashboard] postMessage returned false (webview not visible), queuing retry`,
        );
        this.scheduleRetryPost(message);
      }
    } catch (error) {
      this.outputChannel?.appendLine(
        `[TerminalDashboardProvider] Failed to load tmux sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
      const fallbackMessage: TmuxDashboardHostMessage = {
        type: "updateTmuxSessions",
        sessions: [],
        workspace: "Unavailable",
        panes: {},
      };

      if (this.view) {
        this.view.webview.postMessage(fallbackMessage);
      }
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
        {
          const newSessionId = (await vscode.commands.executeCommand(
            "opencodeTui.createTmuxSession",
          )) as string | undefined;
          await this.postSessionsToWebview();
          if (newSessionId) {
            await this.showAiToolSelector(newSessionId, newSessionId);
          }
        }
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
      case "expandPanes":
        await this.postSessionsToWebview();
        return;
      case "createWindow":
        {
          const workspacePath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this.tmuxSessionManager.createWindow(
            message.sessionId,
            workspacePath,
          );
          await this.postSessionsToWebview();
          await this.showAiToolSelector(message.sessionId, message.sessionId);
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
        this.outputChannel?.appendLine(
          `[TerminalDashboard] selectWindow: sessionId=${message.sessionId}, windowId=${message.windowId}`,
        );
        await this.tmuxSessionManager.selectWindow(message.windowId);
        await this.postSessionsToWebview();
        return;
      case "switchPane":
        await this.tmuxSessionManager.selectPane(message.paneId);
        await this.postSessionsToWebview();
        return;
      case "splitPane":
        {
          const workspacePath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this.tmuxSessionManager.splitPane(
            message.paneId ?? message.sessionId,
            message.direction,
            { workingDirectory: workspacePath },
          );
          await this.postSessionsToWebview();
          await this.showAiToolSelector(message.sessionId, message.sessionId);
        }
        return;
      case "splitPaneWithCommand":
        {
          const workspacePath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          await this.tmuxSessionManager.splitPane(
            message.paneId ?? message.sessionId,
            message.direction,
            { command: message.command, workingDirectory: workspacePath },
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
  ): Promise<void> {
    if (!this.view) {
      return;
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const defaultToolName = config.get<AiTool>("defaultAiTool", "opencode");
    const tools: AiToolConfig[] = resolveAiToolConfigs(
      config.get("aiTools", []),
    );

    const message: TmuxDashboardHostMessage = {
      type: "showAiToolSelector",
      sessionId,
      sessionName,
      defaultTool: defaultToolName,
      tools,
    };

    await this.view.webview.postMessage(message);
  }

  /**
   * Handles AI tool selection from the webview.
   * Launches the selected tool in the first pane of the target tmux session.
   */
  private async handleLaunchAiTool(
    sessionId: string,
    toolName: string,
    savePreference: boolean,
  ): Promise<void> {
    if (savePreference) {
      const config = vscode.workspace.getConfiguration("opencodeTui");
      await config.update(
        "defaultAiTool",
        toolName,
        vscode.ConfigurationTarget.Global,
      );
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const tools: AiToolConfig[] = resolveAiToolConfigs(
      config.get("aiTools", []),
    );
    const toolInfo = tools.find(
      (t) =>
        t.name === toolName ||
        getToolDetectionPatterns(t).some((pattern) => pattern === toolName),
    );
    if (!toolInfo) {
      return;
    }

    try {
      const panes = await this.tmuxSessionManager.listPanes(sessionId);
      const targetPane = panes.find((p) => p.isActive) ?? panes[0];
      if (targetPane) {
        await this.tmuxSessionManager.sendTextToPane(
          targetPane.paneId,
          getToolLaunchCommand(toolInfo),
        );
      }
    } catch (error) {
      this.outputChannel?.appendLine(
        `[TerminalDashboardProvider] Failed to launch AI tool: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Lists panes for a specific tmux session.
   * @param sessionId The session ID to list panes for
   * @returns Array of pane DTOs
   */
  private async listPanesForSession(
    sessionId: string,
  ): Promise<TmuxDashboardPaneDto[]> {
    return this.tmuxSessionManager.listPaneDtos(sessionId);
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
    if (this.pendingMessage && this.view) {
      this.view.webview.postMessage(this.pendingMessage);
      this.pendingMessage = undefined;
    }
  }
}
