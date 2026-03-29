import * as path from "path";
import * as vscode from "vscode";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import {
  TmuxDashboardActionMessage,
  TmuxDashboardHostMessage,
  TmuxDashboardPaneDto,
  TmuxDashboardSessionDto,
  AiTool,
  AI_TOOLS,
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

      const filtered = workspaceName
        ? sessions.filter((session) => session.workspace === workspaceName)
        : sessions;

      const panesMap: Record<string, TmuxDashboardPaneDto[]> = {};
      for (const session of filtered) {
        try {
          panesMap[session.id] = await this.listPanesForSession(session.id);
        } catch {
          panesMap[session.id] = [];
        }
      }

      const payload: TmuxDashboardSessionDto[] = filtered.map((session) => ({
        id: session.id,
        name: session.name,
        workspace: session.workspace,
        isActive: session.isActive,
        paneCount: panesMap[session.id]?.length ?? 0,
      }));

      const message: TmuxDashboardHostMessage = {
        type: "updateTmuxSessions",
        sessions: payload,
        workspace: workspaceName ?? "No workspace",
        panes: panesMap,
      };

      await this.view.webview.postMessage(message);
    } catch (error) {
      this.outputChannel?.appendLine(
        `[TerminalManagerDashboardProvider] Failed to load tmux sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
      const message: TmuxDashboardHostMessage = {
        type: "updateTmuxSessions",
        sessions: [],
        workspace: "Unavailable",
        panes: {},
      };

      await this.view.webview.postMessage(message);
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
            await this.showAiToolSelector(newSessionId, newSessionId);
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
      case "sendTextToPane":
        await this.sendTextToPane(message.paneId, message.text);
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
      case "killSession":
        await this.tmuxSessionManager.killSession(message.sessionId);
        await this.postSessionsToWebview();
        return;
      default:
        return;
    }
  }

  /**
   * Generates the HTML content for the webview.
   * @param webview The webview to generate HTML for
   * @returns The HTML string
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal Managers</title>
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
      <button id="create" class="primary" data-action="create">New tmux</button>
      <button id="native-shell" data-action="switchNativeShell">Native shell</button>
      <button id="refresh" data-action="refresh">Refresh</button>
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

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const expandedSessions = new Set();
    let lastPayload = { sessions: [], workspace: "", panes: {} };

    var aiSelectorVisible = false;
    var aiSelectorFocusedIndex = 0;
    var aiSelectorSessionId = null;
    var aiSelectorTools = [
      { id: "opencode", label: "OpenCode", command: "opencode" },
      { id: "claude", label: "Claude", command: "claude" },
      { id: "codex", label: "Codex", command: "codex" }
    ];

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function render(payload) {
      lastPayload = payload || { sessions: [], workspace: "", panes: {} };

      const workspace = document.getElementById("workspace");
      const list = document.getElementById("session-list");
      const banner = document.getElementById("return-banner");
      const returnWorkspace = document.getElementById("return-workspace");
      if (!workspace || !list) {
        return;
      }

      workspace.textContent = "Workspace: " + (payload.workspace || "-");

      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      const panes = payload.panes || {};

      const activeOther = sessions.find(
        (s) => s.isActive && s.workspace !== payload.workspace,
      );

      if (banner && returnWorkspace) {
        if (activeOther) {
          banner.style.display = "flex";
          returnWorkspace.textContent = payload.workspace || "current workspace";
        } else {
          banner.style.display = "none";
        }
      }

      if (sessions.length === 0) {
        list.innerHTML = '<div class="empty">No tmux sessions for this workspace.</div>';
        return;
      }

      list.innerHTML = sessions
        .map((s) => {
          const activeClass = s.isActive ? " active" : "";
          const statusText = s.isActive ? "Current" : "Available";
          const buttonLabel = s.isActive ? "Current" : "Switch";
          const disabled = s.isActive ? " disabled" : "";
          const sessionPanes = panes[s.id] || [];
          const paneCount = sessionPanes.length;
          const isExpanded = expandedSessions.has(s.id);

          return [
            '<div class="session-card' + activeClass + '">',
            '<div class="row">',
            '<div>',
            '<strong>' + escapeHtml(s.name) + '</strong>',
            '<div class="status">' + statusText + '</div>',
            '</div>',
            '<button class="primary" data-session-id="' + escapeHtml(s.id) + '"' + disabled + '>' + buttonLabel + '</button>',
            '<button class="danger" data-action="killSession" data-session-id="' + escapeHtml(s.id) + '" title="Kill Session">✕</button>',
            '</div>',
            '<div class="meta-grid">',
            '<div class="meta">tmux session: ' + escapeHtml(s.id) + '</div>',
            '<div class="meta">workspace: ' + escapeHtml(s.workspace) + '</div>',
            '</div>',
            '<div class="pane-header" data-session-id="' + escapeHtml(s.id) + '">',
            '<span>' + (isExpanded ? "▼" : "▶") + ' Panes (' + paneCount + ")</span>",
            "<div>",
            '<button class="pane-split-btn" data-action="splitH" data-session-id="' + escapeHtml(s.id) + '" title="Split Horizontal">↕</button>',
            '<button class="pane-split-btn" data-action="splitV" data-session-id="' + escapeHtml(s.id) + '" title="Split Vertical">↔</button>',
            "</div>",
            "</div>",
            isExpanded
              ? '<div class="pane-list">' +
                sessionPanes
                  .map((p) => {
                    const activePaneClass = p.isActive ? " active" : "";
                    return (
                      '<div class="pane-item' +
                      activePaneClass +
                      '" data-session-id="' +
                      escapeHtml(s.id) +
                      '" data-pane-id="' +
                      escapeHtml(p.paneId) +
                      '">' +
                      '<span class="pane-name">Pane ' +
                      p.index +
                      (p.title ? ": " + escapeHtml(p.title) : "") +
                      "</span>" +
                      '<div class="pane-actions">' +
                      '<button class="pane-action-switch" title="Switch">⇥</button>' +
                      '<button class="pane-action-send" title="Send Text">⌨</button>' +
                      '<button class="pane-action-kill" title="Kill Pane">✕</button>' +
                      "</div></div>"
                    );
                  })
                  .join("") +
                "</div>"
              : "",
            '</div>'
          ].join("");
        })
        .join("");
    }

    function showAiToolSelector(sessionId, sessionName, defaultTool) {
      aiSelectorSessionId = sessionId;
      aiSelectorVisible = true;
      aiSelectorFocusedIndex = defaultTool
        ? aiSelectorTools.findIndex(function(t) { return t.id === defaultTool; })
        : 0;
      if (aiSelectorFocusedIndex < 0) { aiSelectorFocusedIndex = 0; }

      var optionsContainer = document.getElementById("ai-tool-options");
      var subtitleEl = document.getElementById("ai-selector-session");
      if (subtitleEl) { subtitleEl.textContent = "Session: " + sessionName; }

      if (optionsContainer) {
        optionsContainer.innerHTML = aiSelectorTools.map(function(tool, idx) {
          var focusedClass = idx === aiSelectorFocusedIndex ? " focused" : "";
          return '<div class="ai-tool-option' + focusedClass + '" data-tool-id="' + escapeHtml(tool.id) + '" data-tool-command="' + escapeHtml(tool.command) + '">'
            + '<div class="ai-tool-icon ' + escapeHtml(tool.id) + '">' + escapeHtml(tool.label.charAt(0)) + '</div>'
            + '<span class="ai-tool-label">' + escapeHtml(tool.label) + '</span>'
            + '<span class="ai-tool-command">' + escapeHtml(tool.command) + '</span>'
            + '</div>';
        }).join("");
      }

      var saveCheckbox = document.getElementById("ai-save-default");
      if (saveCheckbox) { saveCheckbox.checked = false; }

      var backdrop = document.getElementById("ai-selector");
      if (backdrop) { backdrop.style.display = "flex"; }
    }

    function hideAiToolSelector() {
      aiSelectorVisible = false;
      aiSelectorSessionId = null;
      var backdrop = document.getElementById("ai-selector");
      if (backdrop) { backdrop.style.display = "none"; }
    }

    function updateAiSelectorFocus() {
      var options = document.querySelectorAll(".ai-tool-option");
      options.forEach(function(el, idx) {
        if (idx === aiSelectorFocusedIndex) {
          el.classList.add("focused");
          el.scrollIntoView({ block: "nearest" });
        } else {
          el.classList.remove("focused");
        }
      });
    }

    function selectAiTool(toolId) {
      var saveCheckbox = document.getElementById("ai-save-default");
      var savePref = saveCheckbox ? saveCheckbox.checked : false;
      vscode.postMessage({
        action: "launchAiTool",
        sessionId: aiSelectorSessionId,
        tool: toolId,
        savePreference: savePref
      });
      hideAiToolSelector();
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const sessions = Array.isArray(lastPayload.sessions)
        ? lastPayload.sessions
        : [];

      if (target.id === "return-btn" || target.closest("#return-btn")) {
        const matching = sessions.find((s) => s.workspace === lastPayload.workspace);
        if (matching) {
          vscode.postMessage({ action: "activate", sessionId: matching.id });
        } else {
          vscode.postMessage({ action: "create" });
        }
        return;
      }

      if (target.classList.contains("pane-split-btn")) {
        const button = target;
        if (!(button instanceof HTMLButtonElement)) {
          return;
        }
        const sessionId = button.dataset.sessionId;
        const direction = button.dataset.action === "splitH" ? "h" : "v";
        vscode.postMessage({ action: "splitPane", sessionId, direction });
        return;
      }

      const paneHeader = target.closest(".pane-header");
      if (paneHeader instanceof HTMLElement) {
        const sessionId = paneHeader.dataset.sessionId;
        if (sessionId) {
          if (expandedSessions.has(sessionId)) {
            expandedSessions.delete(sessionId);
          } else {
            expandedSessions.add(sessionId);
          }
          render(lastPayload);
        }
        return;
      }

      if (target.closest(".pane-action-switch")) {
        const item = target.closest(".pane-item");
        if (item instanceof HTMLElement) {
          vscode.postMessage({
            action: "switchPane",
            sessionId: item.dataset.sessionId,
            paneId: item.dataset.paneId,
          });
        }
        return;
      }

      if (target.closest(".pane-action-send")) {
        const item = target.closest(".pane-item");
        if (item instanceof HTMLElement) {
          const text = window.prompt("Send to pane:", "");
          if (text !== null && text !== "") {
            vscode.postMessage({
              action: "sendTextToPane",
              sessionId: item.dataset.sessionId,
              paneId: item.dataset.paneId,
              text,
            });
          }
        }
        return;
      }

      if (target.closest(".pane-action-kill")) {
        const item = target.closest(".pane-item");
        if (item instanceof HTMLElement) {
          const sessionId = item.dataset.sessionId;
          const paneId = item.dataset.paneId;
          const payloadPanes =
            (lastPayload.panes && sessionId ? lastPayload.panes[sessionId] : []) ||
            [];
          if (payloadPanes.length <= 1) {
            window.alert("Cannot kill the last pane — use 'Kill Session' instead.");
            return;
          }
          if (paneId && window.confirm("Kill pane " + paneId + "?")) {
            vscode.postMessage({
              action: "killPane",
              sessionId,
              paneId,
            });
          }
        }
        return;
      }

      if (target.closest(".ai-tool-option")) {
        var toolOption = target.closest(".ai-tool-option");
        if (toolOption instanceof HTMLElement) {
          selectAiTool(toolOption.dataset.toolId);
        }
        return;
      }

      if (target.id === "ai-selector" && !target.closest(".ai-selector-card")) {
        hideAiToolSelector();
        return;
      }

      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      const action = target.dataset.action;
      if (action === "refresh" || action === "create" || action === "switchNativeShell") {
        vscode.postMessage({ action });
        return;
      }

      if (action === "killSession") {
        const sessionId = target.dataset.sessionId;
        if (sessionId && window.confirm("Kill tmux session " + sessionId + "?")) {
          vscode.postMessage({ action: "killSession", sessionId });
        }
        return;
      }

      const sessionId = target.dataset.sessionId;
      if (sessionId) {
        vscode.postMessage({ action: "activate", sessionId });
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "updateTmuxSessions") {
        render(message);
      }
      if (message && message.type === "showAiToolSelector") {
        showAiToolSelector(message.sessionId, message.sessionName, message.defaultTool);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (!aiSelectorVisible) { return; }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        aiSelectorFocusedIndex = (aiSelectorFocusedIndex + 1) % aiSelectorTools.length;
        updateAiSelectorFocus();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        aiSelectorFocusedIndex = (aiSelectorFocusedIndex - 1 + aiSelectorTools.length) % aiSelectorTools.length;
        updateAiSelectorFocus();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        var tool = aiSelectorTools[aiSelectorFocusedIndex];
        if (tool) { selectAiTool(tool.id); }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideAiToolSelector();
        return;
      }
    });

    vscode.postMessage({ action: "refresh" });
  </script>
</body>
</html>`;
  }

  /**
   * Sends text to a specific tmux pane.
   * @param paneId The pane ID to send text to
   * @param text The text to send
   */
  private async sendTextToPane(paneId: string, text: string): Promise<void> {
    await this.tmuxSessionManager.sendTextToPane(paneId, text);
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
    const defaultTool = config.get<AiTool>("defaultAiTool");

    const message: TmuxDashboardHostMessage = {
      type: "showAiToolSelector",
      sessionId,
      sessionName,
      defaultTool,
    };

    await this.view.webview.postMessage(message);
  }

  /**
   * Handles AI tool selection from the webview.
   * Launches the selected tool in the first pane of the target tmux session.
   */
  private async handleLaunchAiTool(
    sessionId: string,
    tool: AiTool,
    savePreference: boolean,
  ): Promise<void> {
    if (savePreference) {
      const config = vscode.workspace.getConfiguration("opencodeTui");
      await config.update(
        "defaultAiTool",
        tool,
        vscode.ConfigurationTarget.Global,
      );
    }

    const toolInfo = AI_TOOLS.find((t) => t.id === tool);
    if (!toolInfo) {
      return;
    }

    try {
      const panes = await this.tmuxSessionManager.listPanes(sessionId);
      if (panes.length > 0) {
        await this.tmuxSessionManager.sendTextToPane(
          panes[0].paneId,
          toolInfo.command,
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
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.view = undefined;
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
}
