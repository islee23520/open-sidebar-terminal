import * as path from "path";
import * as vscode from "vscode";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import {
  TmuxDashboardActionMessage,
  TmuxDashboardHostMessage,
  TmuxDashboardPaneDto,
  TmuxDashboardSessionDto,
  TmuxDashboardWindowDto,
  AiTool,
  AiToolConfig,
  resolveAiToolConfigs,
  getToolLaunchCommand,
  getToolDetectionPatterns,
} from "../types";

/**
 * Terminal Managers dashboard provider. Webview-based tmux session manager with inline pane controls (split, switch, resize, swap, kill). Filters sessions to current workspace.
 */
export class TerminalManagerDashboardProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "opencodeTui.terminalManager";

  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private pollTimer?: ReturnType<typeof setInterval>;
  private pendingMessage?: TmuxDashboardHostMessage;
  private static readonly POLL_INTERVAL_MS = 3000;

  /**
   * @param context Extension context
   * @param tmuxSessionManager Tmux session manager service
   * @param outputChannel Optional output channel for logging
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tmuxSessionManager: TmuxSessionManager,
    private readonly outputChannel?: vscode.OutputChannel,
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
        `[TerminalManager] Discovered ${sessions.length} sessions, workspaceName=${workspaceName}, workspacePath=${workspacePath}`,
      );
      for (const s of sessions) {
        this.outputChannel?.appendLine(
          `[TerminalManager]   session: id=${s.id}, workspace=${s.workspace}, isActive=${s.isActive}`,
        );
      }

      let filtered = workspaceName
        ? sessions.filter((session) => session.workspace === workspaceName)
        : sessions;

      // Fallback: if workspace filter yields 0 but sessions exist, show all
      let showAllFallback = false;
      if (filtered.length === 0 && sessions.length > 0 && workspaceName) {
        filtered = sessions;
        showAllFallback = true;
        this.outputChannel?.appendLine(
          `[TerminalManager] No sessions matched workspace '${workspaceName}', showing all ${sessions.length} sessions`,
        );
      }

      this.outputChannel?.appendLine(
        `[TerminalManager] Filtered to ${filtered.length} sessions${showAllFallback ? " (fallback: all)" : ""}`,
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

      const message: TmuxDashboardHostMessage = {
        type: "updateTmuxSessions",
        sessions: payload,
        workspace: workspaceName ?? "No workspace",
        panes: panesMap,
        windows: windowsMap,
        showingAll: showAllFallback || undefined,
        tools,
      };

      const posted = this.view.webview.postMessage(message);
      if (!posted) {
        this.outputChannel?.appendLine(
          `[TerminalManager] postMessage returned false (webview not visible), queuing retry`,
        );
        this.scheduleRetryPost(message);
      }
    } catch (error) {
      this.outputChannel?.appendLine(
        `[TerminalManagerDashboardProvider] Failed to load tmux sessions: ${error instanceof Error ? error.message : String(error)}`,
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
            const config = vscode.workspace.getConfiguration("opencodeTui");
            const defaultToolName = config.get<AiTool>(
              "defaultAiTool",
              "opencode",
            );
            const tools: AiToolConfig[] = resolveAiToolConfigs(
              config.get("aiTools", []),
            );
            const defaultTool = tools.find((t) => t.name === defaultToolName);
            if (defaultTool) {
              await this.tmuxSessionManager.sendTextToPane(
                newSessionId,
                getToolLaunchCommand(defaultTool),
              );
            } else {
              await this.showAiToolSelector(newSessionId, newSessionId);
            }
          }
        }
        return;
      case "switchNativeShell":
        await vscode.commands.executeCommand("opencodeTui.switchNativeShell");
        await this.postSessionsToWebview();
        return;
      case "expandPanes":
        await this.postSessionsToWebview();
        return;
      case "createWindow":
        await this.tmuxSessionManager.createWindow(message.sessionId);
        await this.postSessionsToWebview();
        return;
      case "killWindow":
        await this.tmuxSessionManager.killWindow(message.windowId);
        await this.postSessionsToWebview();
        return;
      case "switchPane":
        await this.tmuxSessionManager.selectPane(message.paneId);
        await this.postSessionsToWebview();
        return;
      case "splitPane":
        await this.tmuxSessionManager.splitPane(
          message.paneId ?? message.sessionId,
          message.direction,
        );
        await this.postSessionsToWebview();
        return;
      case "splitPaneWithCommand":
        await this.tmuxSessionManager.splitPane(
          message.paneId ?? message.sessionId,
          message.direction,
          { command: message.command },
        );
        await this.postSessionsToWebview();
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

        await this.tmuxSessionManager.killSession(message.sessionId);

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
   * Generates the HTML content for the webview.
   * @param webview The webview to generate HTML for
   * @returns The HTML string
   */
  private static readonly HTML_VERSION = 10;

  private getHtmlContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "dashboard.js"),
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal Managers v${TerminalManagerDashboardProvider.HTML_VERSION}</title>
  <style>
    body {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      gap: 10px;
    }
    .header-main {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .workspace {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .title {
      font-size: 13px;
      font-weight: 600;
    }
    .session-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .session-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 8px;
      cursor: pointer;
    }
    .session-card.active {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .meta {
      margin-top: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .meta-grid {
      display: grid;
      gap: 2px;
      margin-top: 6px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.danger {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-input-border, transparent);
      cursor: pointer;
      padding: 1px 6px;
      font-size: 12px;
      border-radius: 3px;
    }
    button.danger:hover {
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-inputBorder);
      background: var(--vscode-inputBackground);
    }
    button[disabled] {
      cursor: default;
      opacity: 0.7;
    }
    .status {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 8px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 6px;
    }
    .return-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      margin-bottom: 10px;
      background: var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.1));
      border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
      border-radius: 6px;
      font-size: 12px;
      gap: 8px;
    }
    .return-banner span {
      color: var(--vscode-foreground);
    }
    .pane-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .pane-header:hover {
      color: var(--vscode-foreground);
    }
    .pane-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-left: 8px;
      border-left: 2px solid var(--vscode-panel-border);
      margin-left: 8px;
    }
    .window-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-left: 8px;
      border-left: 2px solid var(--vscode-panel-border);
      margin-left: 8px;
    }
    .window-card {
      border-radius: 4px;
      padding: 4px 6px;
      background: var(--vscode-editor-background);
    }
    .window-card.active {
      border-left: 2px solid var(--vscode-focusBorder);
    }
    .window-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
    }
    .window-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .window-index {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-badge-background);
      padding: 0 4px;
      border-radius: 3px;
    }
    .pane-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
    }
    .pane-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .pane-item.active {
      font-weight: 600;
    }
    .pane-item.active .pane-name::before {
      content: "\\2713 ";
      color: var(--vscode-terminal-ansiGreen, #4ec9b0);
    }
    .pane-kill-btn {
      margin-left: auto;
      flex-shrink: 0;
    }
    .pane-tool-badge {
      display: inline-block;
      width: 18px;
      height: 18px;
      line-height: 18px;
      text-align: center;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      margin-right: 6px;
      vertical-align: middle;
    }
    .pane-tool-badge.opencode { background: #4ec9b0; color: #1e1e1e; }
    .pane-tool-badge.claude { background: #d97706; color: #ffffff; }
    .pane-tool-badge.codex { background: #6366f1; color: #ffffff; }
    .pane-actions {
      display: flex;
      gap: 4px;
    }
    .pane-actions button {
      padding: 1px 6px;
      font-size: 11px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 3px;
    }
    .pane-actions button:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .pane-split-btn {
      padding: 1px 6px;
      font-size: 11px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 3px;
    }
    .pane-split-btn:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .ai-selector-backdrop {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 1000;
      align-items: flex-end;
      justify-content: center;
      padding: 12px;
    }
    .ai-selector-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 12px;
      width: 100%;
      max-width: 280px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }
    .ai-selector-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .ai-selector-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .ai-selector-options {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ai-tool-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: background-color 0.1s;
      user-select: none;
    }
    .ai-tool-option:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .ai-tool-option.focused {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      outline: 1px solid var(--vscode-focusBorder);
    }
    .ai-tool-icon {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .ai-tool-icon.opencode { background: #4ec9b0; color: #1e1e1e; }
    .ai-tool-icon.claude { background: #d97706; color: #ffffff; }
    .ai-tool-icon.codex { background: #6366f1; color: #ffffff; }
    .ai-tool-label {
      flex: 1;
    }
    .ai-tool-command {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .ai-selector-save {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      cursor: pointer;
      user-select: none;
    }
    .ai-selector-save input {
      margin: 0;
      accent-color: var(--vscode-checkbox-background, var(--vscode-focusBorder));
    }
    .ai-selector-hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 6px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-main">
      <div class="title">Terminal Managers</div>
      <div class="workspace" id="workspace">Workspace: -</div>
    </div>
    <div class="header-actions">
      <button id="create" class="primary" data-action="create" title="Create new tmux session">New tmux</button>
      <button id="native-shell" data-action="switchNativeShell" title="Switch to native terminal">Native shell</button>
      <button id="refresh" data-action="refresh" title="Refresh session list">Refresh</button>
    </div>
  </div>
  <div class="return-banner" id="return-banner" style="display:none;">
    <span>Terminal is attached to a different workspace session</span>
    <button class="primary" id="return-btn">Return to <span id="return-workspace"></span></button>
  </div>
  <div id="session-list" class="session-list"></div>

  <div id="ai-selector" class="ai-selector-backdrop">
    <div class="ai-selector-card">
      <div class="ai-selector-title">Launch AI Tool</div>
      <div class="ai-selector-subtitle" id="ai-selector-session"></div>
      <div class="ai-selector-options" id="ai-tool-options"></div>
      <label class="ai-selector-save">
        <input type="checkbox" id="ai-save-default">
        <span>Save as default</span>
      </label>
      <div class="ai-selector-hint">↑↓ Navigate · Enter Select · Esc Dismiss</div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
      if (panes.length > 0) {
        await this.tmuxSessionManager.sendTextToPane(
          panes[0].paneId,
          getToolLaunchCommand(toolInfo),
        );
      }
    } catch (error) {
      this.outputChannel?.appendLine(
        `[TerminalManagerDashboardProvider] Failed to launch AI tool: ${error instanceof Error ? error.message : String(error)}`,
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
    }, TerminalManagerDashboardProvider.POLL_INTERVAL_MS);
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
