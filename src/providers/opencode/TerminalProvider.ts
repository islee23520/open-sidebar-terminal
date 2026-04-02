import * as vscode from "vscode";
import { TerminalManager } from "../../terminals/TerminalManager";
import { OutputCaptureManager } from "../../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../../services/OpenCodeApiClient";
import { PortManager } from "../../services/PortManager";
import { ContextSharingService } from "../../services/ContextSharingService";
import { OutputChannelService } from "../../services/OutputChannelService";
import { InstanceId, InstanceStore } from "../../services/InstanceStore";
import { TmuxSessionManager } from "../../services/TmuxSessionManager";
import {
  OpenCodeMessageRouter,
  OpenCodeMessageRouterProviderBridge,
} from "./OpenCodeMessageRouter";
import { OpenCodeSessionRuntime } from "./OpenCodeSessionRuntime";

export class TerminalProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeTui";

  private _view?: vscode.WebviewView;
  private readonly contextSharingService: ContextSharingService;
  private readonly logger = OutputChannelService.getInstance();
  private readonly sessionRuntime: OpenCodeSessionRuntime;
  private readonly messageRouter: OpenCodeMessageRouter;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly captureManager: OutputCaptureManager,
    private readonly portManager: PortManager,
    private readonly instanceStore?: InstanceStore,
    private readonly tmuxSessionManager?: TmuxSessionManager,
  ) {
    this.contextSharingService = new ContextSharingService();

    this.sessionRuntime = new OpenCodeSessionRuntime(
      this.terminalManager,
      this.captureManager,
      undefined,
      this.portManager,
      this.tmuxSessionManager,
      this.instanceStore,
      this.logger,
      this.contextSharingService,
      {
        postMessage: (message) => this.postWebviewMessage(message),
        onActiveInstanceChanged: (instanceId) => {
          void this.switchToInstance(instanceId);
        },
        requestStartOpenCode: () => this.startOpenCode(),
      },
    );

    const routerBridge: OpenCodeMessageRouterProviderBridge = {
      startOpenCode: () => this.startOpenCode(),
      switchToTmuxSession: (sessionId) => this.switchToTmuxSession(sessionId),
      killTmuxSession: (sessionId) => this.killTmuxSession(sessionId),
      createTmuxSession: () => this.createTmuxSession(),
      switchToNativeShell: () => this.switchToNativeShell(),
      pasteText: (text) => this.pasteText(text),
      getActiveInstanceId: () => this.getActiveInstanceId(),
      setLastKnownTerminalSize: (cols, rows) =>
        this.setLastKnownTerminalSize(cols, rows),
      getLastKnownTerminalSize: () => this.getLastKnownTerminalSize(),
      isStarted: () => this.isStarted(),
      resizeActiveTerminal: (cols, rows) =>
        this.resizeActiveTerminal(cols, rows),
      postWebviewMessage: (message) => this.postWebviewMessage(message),
    };

    this.messageRouter = new OpenCodeMessageRouter(
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
    this.postWebviewMessage({ type: "focusTerminal" });
  }

  public pasteText(text: string): void {
    this.postWebviewMessage({
      type: "clipboardContent",
      text,
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

  public async switchToNativeShell(): Promise<void> {
    await this.sessionRuntime.switchToNativeShell();
  }

  public async createTmuxSession(): Promise<string | undefined> {
    return this.sessionRuntime.createTmuxSession();
  }

  public async killTmuxSession(sessionId: string): Promise<void> {
    await this.sessionRuntime.killTmuxSession(sessionId);
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

    this.terminalManager.writeToTerminal(this.activeInstanceId, prompt);
  }

  private handleMessage(message: unknown): void {
    this.messageRouter.handleMessage(message);
  }

  private resizeActiveTerminal(cols: number, rows: number): void {
    this.terminalManager.resizeTerminal(this.activeInstanceId, cols, rows);
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
    this._view?.webview.postMessage(message);
  }

  private postTerminalConfig(): void {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    this.postWebviewMessage({
      type: "terminalConfig",
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
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );

    const nonce = this.getNonce();

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const fontSize = config.get<number>("fontSize", 14);
    const fontFamily = config.get<string>("fontFamily", "monospace");
    const cursorBlink = config.get<boolean>("cursorBlink", true);
    const cursorStyle = config.get<string>("cursorStyle", "block");
    const scrollback = config.get<number>("scrollback", 10000);

    const escapedFontFamily = fontFamily.replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode TUI</title>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
      background-color: #1e1e1e;
      display: flex;
      flex-direction: column;
    }
    #terminal-container {
      flex: 1;
      height: 100%;
      min-width: 0;
      position: relative;
      overflow: hidden;
      touch-action: none;
    }
    .session-indicator {
      position: absolute;
      top: 4px;
      right: 8px;
      font-size: 11px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 1px 6px;
      z-index: 10;
      pointer-events: none;
      opacity: 0.8;
      transition: opacity 0.3s ease;
    }
    .session-indicator.hidden {
      display: none;
    }
    .font-preload {
      position: absolute;
      left: -9999px;
      visibility: hidden;
      font-family: ${escapedFontFamily};
    }
  </style>
</head>
<body>
  <span class="font-preload" aria-hidden="true">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;':\",./<>?\`~</span>
  <div id="session-indicator" class="session-indicator hidden"></div>
  <div id="terminal-container"
    data-font-size="${fontSize}"
    data-font-family="${escapedFontFamily}"
    data-cursor-blink="${cursorBlink}"
    data-cursor-style="${cursorStyle}"
    data-scrollback="${scrollback}">
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

  public dispose(): void {
    this.sessionRuntime.dispose();
  }
}
