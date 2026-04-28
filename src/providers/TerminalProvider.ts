import * as vscode from "vscode";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { PortManager } from "../services/PortManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import { AiToolFileReference } from "../services/aiTools/AiToolOperator";
import {
  AiToolConfig,
  HostMessage,
  TMUX_RAW_ALLOWED_SUBCOMMANDS,
  resolveAiToolConfigs,
} from "../types";
import type { TmuxRawSubcommand } from "../types";
import { AiToolOperatorRegistry } from "../services/aiTools/AiToolOperatorRegistry";
import { MessageRouter, MessageRouterProviderBridge } from "./MessageRouter";
import { SessionRuntime } from "./SessionRuntime";
import { renderTerminalHtml } from "../webview/terminal/html";

export class TerminalProvider
  implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer
{
  public static readonly viewType = "opencodeTui";
  public static readonly panelViewType = "opencodeTui.terminalEditor";

  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private readonly contextSharingService: ContextSharingService;
  private readonly logger = OutputChannelService.getInstance();
  private readonly aiToolRegistry: AiToolOperatorRegistry;
  private readonly sessionRuntime: SessionRuntime;
  private readonly messageRouter: MessageRouter;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly captureManager: OutputCaptureManager,
    private readonly portManager: PortManager,
    private readonly instanceStore?: InstanceStore,
    private readonly tmuxSessionManager?: TmuxSessionManager,
  ) {
    this.contextSharingService = new ContextSharingService();
    this.aiToolRegistry = new AiToolOperatorRegistry();

    this.sessionRuntime = new SessionRuntime(
      this.terminalManager,
      this.captureManager,
      undefined,
      this.portManager,
      this.tmuxSessionManager,
      this.instanceStore,
      this.logger,
      this.contextSharingService,
      this.aiToolRegistry,
      {
        postMessage: (message) => this.postWebviewMessage(message),
        onActiveInstanceChanged: (instanceId) => {
          void this.switchToInstance(instanceId);
        },
        requestStartOpenCode: () => this.startOpenCode(),
        showAiToolSelector: (sessionId, sessionName, forceShow) =>
          this.showAiToolSelector(sessionId, sessionName, forceShow),
      },
    );

    const routerBridge: MessageRouterProviderBridge = {
      startOpenCode: () => this.startOpenCode(),
      switchToTmuxSession: (sessionId) => this.switchToTmuxSession(sessionId),
      killTmuxSession: (sessionId) => this.killTmuxSession(sessionId),
      createTmuxSession: () => this.createTmuxSession(),
      toggleDashboard: () => this.toggleDashboard(),
      toggleEditorAttachment: () => this.toggleEditorAttachment(),
      restart: () => this.restart(),
      switchToNativeShell: () => this.switchToNativeShell(),
      pasteText: (text) => this.pasteText(text),
      getActiveInstanceId: () => this.getActiveInstanceId(),
      setLastKnownTerminalSize: (cols, rows) =>
        this.setLastKnownTerminalSize(cols, rows),
      getLastKnownTerminalSize: () => this.getLastKnownTerminalSize(),
      isStarted: () => this.isStarted(),
      resizeActiveTerminal: (cols, rows) =>
        this.resizeActiveTerminal(cols, rows),
      getActiveTerminalId: () => this.activeTerminalId,
      postWebviewMessage: (message) => this.postWebviewMessage(message),
      routeDroppedTextToTmuxPane: (text, dropCell) =>
        this.sessionRuntime.routeDroppedTextToTmuxPane(text, dropCell),
      formatDroppedFiles: (paths, useAtSyntax) =>
        this.sessionRuntime.formatDroppedFiles(paths, { useAtSyntax }),
      formatPastedImage: (tempPath) =>
        this.sessionRuntime.formatPastedImage(tempPath),
      launchAiTool: (sessionId, toolName, savePreference, targetPaneId) =>
        this.launchAiTool(sessionId, toolName, savePreference, targetPaneId),
      showAiToolSelector: (sessionId, sessionName, forceShow, targetPaneId) =>
        Promise.resolve(
          this.showAiToolSelector(
            sessionId,
            sessionName,
            forceShow,
            targetPaneId,
          ),
        ),
      executeRawTmuxCommand: (subcommand, args) =>
        this.executeRawTmuxCommand(subcommand, args),
      zoomTmuxPane: () => this.zoomTmuxPane(),
      getSelectedTmuxSessionId: () => this.getSelectedTmuxSessionId(),
      isTmuxAvailable: () => !!this.tmuxSessionManager,
    };

    this.messageRouter = new MessageRouter(
      routerBridge,
      this.context,
      this.terminalManager,
      this.captureManager,
      this.getApiClient(),
      this.contextSharingService,
      this.logger,
      this.instanceStore,
    );
  }

  private get activeInstanceId(): InstanceId {
    return this.sessionRuntime.getActiveInstanceId();
  }

  private get activeTerminalId(): string {
    return this.sessionRuntime.getActiveTerminalId();
  }

  public get lastKnownCols(): number {
    return this.sessionRuntime.getLastKnownTerminalSize().cols;
  }

  public set lastKnownCols(cols: number) {
    const size = this.sessionRuntime.getLastKnownTerminalSize();
    this.sessionRuntime.setLastKnownTerminalSize(cols, size.rows);
  }

  public get lastKnownRows(): number {
    return this.sessionRuntime.getLastKnownTerminalSize().rows;
  }

  public set lastKnownRows(rows: number) {
    const size = this.sessionRuntime.getLastKnownTerminalSize();
    this.sessionRuntime.setLastKnownTerminalSize(size.cols, rows);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    const processAlive = this.sessionRuntime.hasLiveTerminalProcess();
    if (this.sessionRuntime.isStartedFlag() && !processAlive) {
      this.sessionRuntime.resetState();
    }

    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });

    if (processAlive) {
      this.sessionRuntime.reconnectListeners();
    }

    this.postTerminalConfig();
    this.postCurrentSessionState(webviewView.webview);

    const config = vscode.workspace.getConfiguration("opencodeTui");
    if (config.get<boolean>("autoStartOnOpen", true)) {
      if (webviewView.visible) {
        if (!this.isStarted()) {
          void this.startOpenCode();
        }
      } else {
        const visibilityListener = webviewView.onDidChangeVisibility(() => {
          if (webviewView.visible) {
            this.postWebviewMessage({ type: "webviewVisible" });
            this.postTerminalConfig();
            if (!this.isStarted()) {
              void this.startOpenCode();
              visibilityListener.dispose();
            }
          }
        });

        webviewView.onDidDispose(() => visibilityListener.dispose());
      }
    }
  }

  public focus(): void {
    this._panel?.reveal(vscode.ViewColumn.Active);
    this.postWebviewMessage({ type: "focusTerminal" });
  }

  public async toggleEditorAttachment(): Promise<void> {
    const currentPanel = this._panel;
    if (currentPanel) {
      this._panel = undefined;
      currentPanel.dispose();
      this.postTerminalConfig();
      await this.revealSidebarView();
      return;
    }

    this.openInEditorTab();
  }

  public async openInEditorTab(): Promise<void> {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Active);
      this.focus();
      return;
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");

    if (config.get<boolean>("collapseSecondaryBarOnEditorOpen", true)) {
      await vscode.commands.executeCommand(
        "workbench.action.closeAuxiliaryBar",
      );
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
    }

    const panel = vscode.window.createWebviewPanel(
      TerminalProvider.panelViewType,
      "Open Sidebar Terminal",
      vscode.ViewColumn.Beside,
      this.getEditorPanelOptions(),
    );

    this.initializeEditorPanel(panel);

    await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
  }

  public async deserializeWebviewPanel(
    webviewPanel: vscode.WebviewPanel,
    _state: unknown,
  ): Promise<void> {
    this.initializeEditorPanel(webviewPanel);
  }

  public formatFileReference(reference: AiToolFileReference): string {
    return this.sessionRuntime.formatFileReference(reference);
  }

  public formatUriReference(uri: vscode.Uri): string {
    return this.formatFileReference({
      path: vscode.workspace.asRelativePath(uri, false),
    });
  }

  public formatEditorReference(editor: vscode.TextEditor): string {
    const relativePath = vscode.workspace.asRelativePath(
      editor.document.uri,
      false,
    );
    const selection = editor.selection;
    return this.formatFileReference({
      path: relativePath,
      selectionStart: selection.isEmpty ? undefined : selection.start.line + 1,
      selectionEnd: selection.isEmpty ? undefined : selection.end.line + 1,
    });
  }

  public pasteText(text: string): void {
    this.postWebviewMessage({
      type: "clipboardContent",
      text,
    });
  }

  public requestPaste(): void {
    this.postWebviewMessage({
      type: "requestPaste",
    });
  }

  public getApiClient(): OpenCodeApiClient | undefined {
    return this.sessionRuntime.getApiClient();
  }

  public isHttpAvailable(): boolean {
    return this.sessionRuntime.isHttpAvailable();
  }

  public async startOpenCode(): Promise<void> {
    await this.sessionRuntime.startOpenCode();
  }

  public restart(): void {
    this.sessionRuntime.restart();
  }

  public async switchToInstance(
    instanceId: InstanceId,
    options?: { forceRestart?: boolean },
  ): Promise<void> {
    await this.sessionRuntime.switchToInstance(instanceId, options);
  }

  public async switchToTmuxSession(sessionId: string): Promise<void> {
    await this.sessionRuntime.switchToTmuxSession(sessionId);
  }

  public resolveInstanceIdFromSessionId(sessionId: string): InstanceId {
    return this.sessionRuntime.resolveInstanceIdFromSessionId(sessionId);
  }

  public async switchToNativeShell(): Promise<void> {
    await this.sessionRuntime.switchToNativeShell();
  }

  public async createTmuxSession(): Promise<string | undefined> {
    return this.sessionRuntime.createTmuxSession();
  }

  public async killTmuxSession(sessionId: string): Promise<void> {
    await this.sessionRuntime.killTmuxSession(sessionId);
  }

  public async executeRawTmuxCommand(
    subcommand: string,
    args: string[] = [],
  ): Promise<string> {
    if (!this.tmuxSessionManager) {
      throw new Error("tmux session manager unavailable");
    }

    if (!this.isTmuxRawSubcommand(subcommand)) {
      throw new Error(`Unsupported tmux subcommand: ${subcommand}`);
    }

    const sessionId = this.instanceStore?.getActive()?.runtime.tmuxSessionId;
    if (!sessionId) {
      throw new Error("No active tmux session available");
    }

    const resolvedArgs = await this.resolveRawTmuxCommandArgs(subcommand, args);
    return await this.tmuxSessionManager.executeRawCommand(
      sessionId,
      subcommand,
      resolvedArgs,
    );
  }

  public getSelectedTmuxSessionId(): string | undefined {
    return this.sessionRuntime.getSelectedTmuxSessionId();
  }

  public async zoomTmuxPane(): Promise<void> {
    await this.sessionRuntime.zoomTmuxPane();
  }

  public async sendPrompt(prompt: string): Promise<void> {
    const apiClient = this.sessionRuntime.getApiClient();
    if (apiClient && this.sessionRuntime.isHttpAvailable()) {
      try {
        await apiClient.appendPrompt(prompt);
        return;
      } catch (error) {
        this.logger.warn(
          `HTTP API send failed, falling back to terminal write: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.terminalManager.writeToTerminal(this.activeTerminalId, prompt);
  }

  public async launchAiTool(
    sessionId: string,
    toolName: string,
    savePreference: boolean,
    targetPaneId?: string,
  ): Promise<void> {
    if (savePreference) {
      const config = vscode.workspace.getConfiguration("opencodeTui");
      await config.update(
        "defaultAiTool",
        toolName,
        vscode.ConfigurationTarget.Global,
      );
    }

    if (!this.tmuxSessionManager) {
      return;
    }

    const tool = this.sessionRuntime.resolveToolByName(toolName);
    if (!tool) {
      return;
    }

    const instanceId =
      this.sessionRuntime.resolveInstanceIdFromSessionId(sessionId);
    this.sessionRuntime.rememberSelectedTool(tool.name, instanceId);

    const effectiveSessionId =
      this.sessionRuntime.resolveTmuxSessionIdForInstance(instanceId) ??
      sessionId;

    try {
      let paneIdToUse: string | undefined = targetPaneId;
      if (!paneIdToUse) {
        const panes = await this.tmuxSessionManager.listPanes(
          effectiveSessionId,
          { activeWindowOnly: true },
        );
        const targetPane = panes.find((p) => p.isActive) ?? panes[0];
        paneIdToUse = targetPane?.paneId;
      }
      if (paneIdToUse) {
        const operator = this.aiToolRegistry.getForConfig(tool);
        await this.tmuxSessionManager.sendTextToPane(
          paneIdToUse,
          operator.getLaunchCommand(tool),
        );
      } else {
        this.logger.warn(
          `[TerminalProvider] launchAiTool skipped: no target pane for session ${effectiveSessionId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[TerminalProvider] Failed to launch AI tool: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleMessage(message: unknown): void {
    this.messageRouter.handleMessage(message);
  }

  private isTmuxRawSubcommand(value: string): value is TmuxRawSubcommand {
    return TMUX_RAW_ALLOWED_SUBCOMMANDS.some((command) => command === value);
  }

  private async resolveRawTmuxCommandArgs(
    subcommand: TmuxRawSubcommand,
    args: string[],
  ): Promise<string[]> {
    switch (subcommand) {
      case "rename-session":
        return await this.promptForTmuxValue(
          "Rename tmux session",
          "Enter the new tmux session name",
          args[0],
        );
      case "rename-window":
        return await this.promptForTmuxValue(
          "Rename tmux window",
          "Enter the new tmux window name",
          args[0],
        );
      case "select-layout":
        return await this.promptForTmuxValue(
          "Select tmux layout",
          "Enter a tmux layout name (e.g. even-horizontal, tiled, main-vertical)",
          args[0],
        );
      default:
        return args;
    }
  }

  private async promptForTmuxValue(
    title: string,
    prompt: string,
    value?: string,
  ): Promise<string[]> {
    const input = await vscode.window.showInputBox({
      title,
      prompt,
      value,
      ignoreFocusOut: true,
      validateInput: (currentValue) =>
        currentValue.trim().length === 0 ? "A value is required" : undefined,
    });

    if (input === undefined) {
      throw new Error("tmux command cancelled");
    }

    return [input.trim()];
  }

  public showAiToolSelector(
    sessionId: string,
    sessionName: string,
    forceShow = false,
    targetPaneId?: string,
  ): void {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    const instanceId =
      this.sessionRuntime.resolveInstanceIdFromSessionId(sessionId);
    const effectiveSessionId =
      this.sessionRuntime.resolveTmuxSessionIdForInstance(instanceId) ??
      sessionId;
    const savedTool =
      this.instanceStore?.get(instanceId)?.config.selectedAiTool ??
      config.get<string>("defaultAiTool", "");
    const tools: AiToolConfig[] = resolveAiToolConfigs(
      config.get("aiTools", []),
    );
    if (!forceShow && savedTool) {
      void this.launchAiTool(
        effectiveSessionId,
        savedTool,
        false,
        targetPaneId,
      );
      return;
    }
    this.postWebviewMessage({
      type: "showAiToolSelector",
      sessionId: effectiveSessionId,
      sessionName,
      defaultTool: undefined,
      tools,
      targetPaneId,
    });
  }

  private resizeActiveTerminal(cols: number, rows: number): void {
    this.terminalManager.resizeTerminal(this.activeTerminalId, cols, rows);
  }

  private getActiveInstanceId(): InstanceId {
    return this.activeInstanceId;
  }

  private setLastKnownTerminalSize(cols: number, rows: number): void {
    this.sessionRuntime.setLastKnownTerminalSize(cols, rows);
  }

  private getLastKnownTerminalSize(): { cols: number; rows: number } {
    return this.sessionRuntime.getLastKnownTerminalSize();
  }

  private isStarted(): boolean {
    return this.sessionRuntime.isStartedFlag();
  }

  private postWebviewMessage(message: unknown): void {
    const webview = this._panel?.webview ?? this._view?.webview;
    webview?.postMessage(message);
  }

  private postCurrentSessionState(webview: vscode.Webview): void {
    const selectedSessionId = this.sessionRuntime.getSelectedTmuxSessionId();
    const resolvedSessionId =
      this.sessionRuntime.resolveTmuxSessionIdForInstance(
        this.getActiveInstanceId(),
      );
    const sessionId = selectedSessionId ?? resolvedSessionId;

    if (sessionId) {
      webview.postMessage({
        type: "activeSession",
        sessionName: sessionId,
        sessionId,
      });
      return;
    }

    webview.postMessage({ type: "activeSession" });
  }

  private getEditorPanelOptions(): vscode.WebviewOptions &
    vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.context.extensionUri],
    };
  }

  private initializeEditorPanel(panel: vscode.WebviewPanel): void {
    this._panel = panel;
    panel.webview.options = this.getEditorPanelOptions();
    panel.webview.html = this.getHtmlForWebview(panel.webview);

    const processAlive = this.sessionRuntime.hasLiveTerminalProcess();
    if (this.sessionRuntime.isStartedFlag() && !processAlive) {
      this.sessionRuntime.resetState();
    }

    panel.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });

    if (processAlive) {
      this.sessionRuntime.reconnectListeners();
    }

    this.postTerminalConfig();
    this.postCurrentSessionState(panel.webview);

    panel.onDidDispose(() => {
      if (this._panel === panel) {
        this._panel = undefined;
        if (this._view) {
          this.postTerminalConfig();
          this.postWebviewMessage({ type: "webviewVisible" });
        }
      }
    });
  }

  private async revealSidebarView(): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        "workbench.view.extension.opencodeTuiContainer",
      );
    } catch {
      // Best-effort reveal; fall through to showing the specific view when available.
    }

    this._view?.show?.(true);
    this.postWebviewMessage({ type: "focusTerminal" });
  }

  private postTerminalConfig(): void {
    const terminalConfig = this.getTerminalConfig();
    this.postWebviewMessage({
      type: "terminalConfig",
      ...terminalConfig,
    });
  }

  private getTerminalConfig(): Omit<
    Extract<HostMessage, { type: "terminalConfig" }>,
    "type"
  > {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    return {
      fontSize: config.get<number>("fontSize", 14),
      fontFamily: config.get<string>(
        "fontFamily",
        "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CascadiaCode NF', Menlo, monospace",
      ),
      cursorBlink: config.get<boolean>("cursorBlink", true),
      cursorStyle: config.get<"block" | "underline" | "bar">(
        "cursorStyle",
        "block",
      ),
      scrollback: config.get<number>("scrollback", 10000),
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
      )
      .toString();
    const cssUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "terminal.css"),
      )
      .toString();
    const nonce = this.getNonce();

    const terminalConfig = this.getTerminalConfig();

    return renderTerminalHtml({
      cspSource: webview.cspSource,
      nonce,
      cssUri,
      scriptUri,
      fontSize: String(terminalConfig.fontSize),
      fontFamily: terminalConfig.fontFamily,
      cursorBlink: String(terminalConfig.cursorBlink),
      cursorStyle: terminalConfig.cursorStyle,
      scrollback: String(terminalConfig.scrollback),
    });
  }

  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  public toggleDashboard(): void {
    void vscode.commands.executeCommand("opencodeTui.openTerminalManager");
  }

  public toggleTmuxCommandToolbar(): void {
    const selectedSessionId = this.sessionRuntime.getSelectedTmuxSessionId();
    const resolvedSessionId =
      this.sessionRuntime.resolveTmuxSessionIdForInstance(
        this.getActiveInstanceId(),
      );
    const tmuxSessionId = selectedSessionId ?? resolvedSessionId;

    this.logger.info(
      `[DIAG:toggleTmuxCommandToolbar] selected=${selectedSessionId ?? "none"} resolved=${resolvedSessionId ?? "none"} effective=${tmuxSessionId ?? "none"} view=${!!this._view} panel=${!!this._panel}`,
    );

    if (!tmuxSessionId) {
      this.logger.warn(
        `[DIAG:toggleTmuxCommandToolbar] BLOCKED — no tmux session id`,
      );
      return;
    }

    this.postWebviewMessage({ type: "toggleTmuxCommandToolbar" });
    this.logger.info(
      `[DIAG:toggleTmuxCommandToolbar] message posted to webview`,
    );
  }

  public dispose(): void {
    this.sessionRuntime.dispose();
  }
}
