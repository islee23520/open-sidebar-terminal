import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { PortManager } from "../services/PortManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import {
  TmuxSessionManager,
  TmuxUnavailableError,
} from "../services/TmuxSessionManager";
import { TreeSnapshot } from "../webview/sidebar/types";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE } from "../types";

interface StartupWorkspaceResolution {
  workspacePath: string;
  isWorkspaceScoped: boolean;
}

export class OpenCodeTuiProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeTui";
  private static readonly LEGACY_TERMINAL_ID: InstanceId = "opencode-main";
  private _view?: vscode.WebviewView;
  private activeInstanceId: InstanceId = "default";
  private isStarted = false;
  private apiClient?: OpenCodeApiClient;
  private readonly portManager: PortManager;
  private readonly contextSharingService: ContextSharingService;
  private readonly logger = OutputChannelService.getInstance();
  private httpAvailable = false;
  private autoContextSent = false;
  private dataListener?: vscode.Disposable;
  private exitListener?: vscode.Disposable;
  private activeInstanceSubscription?: vscode.Disposable;
  private lastKnownCols: number = 0;
  private lastKnownRows: number = 0;
  private isStarting = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly captureManager: OutputCaptureManager,
    private readonly instanceStore?: InstanceStore,
    private readonly tmuxSessionManager?: TmuxSessionManager,
  ) {
    this.portManager = new PortManager();
    this.contextSharingService = new ContextSharingService();

    if (this.instanceStore) {
      this.subscribeToActiveInstanceChanges();
    } else {
      this.activeInstanceId = OpenCodeTuiProvider.LEGACY_TERMINAL_ID;
    }
  }

  private subscribeToActiveInstanceChanges(): void {
    if (!this.instanceStore) {
      return;
    }

    try {
      this.activeInstanceId = this.instanceStore.getActive().config.id;
    } catch {}

    this.activeInstanceSubscription = this.instanceStore.onDidSetActive(
      (id) => {
        void this.switchToInstance(id);
      },
    );
  }

  /**
   * Switches the provider to the given instance and rebinds terminal streams.
   */
  public async switchToInstance(instanceId: InstanceId): Promise<void> {
    if (instanceId === this.activeInstanceId) {
      return;
    }

    this.disposeListeners();
    this.resetState(false);
    this.activeInstanceId = instanceId;

    this._view?.webview.postMessage({ type: "clearTerminal" });
    void this.emitTreeSnapshot();

    const existingTerminal =
      this.terminalManager.getByInstance(instanceId) ||
      this.terminalManager.getTerminal(instanceId);

    if (existingTerminal) {
      this.isStarted = true;
      this.reconnectListeners();

      const config = vscode.workspace.getConfiguration("opencodeTui");
      const enableHttpApi = config.get<boolean>("enableHttpApi", true);
      if (enableHttpApi && existingTerminal.port) {
        const httpTimeout = config.get<number>("httpTimeout", 5000);
        this.apiClient = new OpenCodeApiClient(
          existingTerminal.port,
          10,
          200,
          httpTimeout,
        );
        await this.pollForHttpReadiness();
      }

      if (this.lastKnownCols && this.lastKnownRows) {
        this.terminalManager.resizeTerminal(
          this.activeInstanceId,
          this.lastKnownCols,
          this.lastKnownRows,
        );
      }
      return;
    }

    await this.startOpenCode();
  }

  resolveWebviewView(
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

    const processAlive =
      this.isStarted &&
      this.terminalManager.getTerminal(this.activeInstanceId) !== undefined;

    if (this.isStarted && !processAlive) {
      this.resetState();
    }

    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });

    void this.emitTreeSnapshot();

    if (processAlive) {
      this.reconnectListeners();
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    if (config.get<boolean>("autoStartOnOpen", true)) {
      // Only start if sidebar is currently visible
      if (webviewView.visible) {
        if (!this.isStarted) {
          this.startOpenCode();
        }
      } else {
        // Wait until sidebar becomes visible
        const visibilityListener = webviewView.onDidChangeVisibility(() => {
          if (webviewView.visible) {
            // Notify webview that it's now visible so it can refit the terminal
            this._view?.webview.postMessage({ type: "webviewVisible" });
            if (!this.isStarted) {
              this.startOpenCode();
              visibilityListener.dispose(); // Only trigger once
            }
          }
        });

        // Clean up listener when view is disposed
        webviewView.onDidDispose(() => visibilityListener.dispose());
      }
    }
  }

  /**
   * Reconnect data/exit listeners when the webview is re-created.
   */
  private reconnectListeners(): void {
    this.disposeListeners();

    this.dataListener = this.terminalManager.onData((event) => {
      if (event.id === this.activeInstanceId) {
        this._view?.webview.postMessage({
          type: "terminalOutput",
          data: event.data,
        });
      }
    });

    this.exitListener = this.terminalManager.onExit((id) => {
      if (id === this.activeInstanceId) {
        this.resetState();
        this._view?.webview.postMessage({
          type: "terminalExited",
        });
      }
    });
  }

  public focus(): void {
    if (this._view && this._view.webview) {
      this._view.webview.postMessage({ type: "focusTerminal" });
    }
  }

  public pasteText(text: string): void {
    this._view?.webview.postMessage({
      type: "clipboardContent",
      text: text,
    });
  }

  public getApiClient(): OpenCodeApiClient | undefined {
    return this.apiClient;
  }

  public isHttpAvailable(): boolean {
    return this.httpAvailable;
  }

  async startOpenCode(): Promise<void> {
    if (this.isStarted || this.isStarting) {
      return;
    }

    this.isStarting = true;

    try {
      this.disposeListeners();

      const config = vscode.workspace.getConfiguration("opencodeTui");
      const enableHttpApi = config.get<boolean>("enableHttpApi", true);
      const httpTimeout = config.get<number>("httpTimeout", 5000);
      const command = config.get<string>("command", "opencode -c");
      let tmuxSessionId = this.resolveTmuxSessionIdForInstance(
        this.activeInstanceId,
      );

      let port: number | undefined;
      const { workspacePath, isWorkspaceScoped } =
        this.resolveStartupWorkspacePath();

      if (isWorkspaceScoped) {
        const ensuredSessionId =
          await this.ensureWorkspaceSession(workspacePath);
        if (ensuredSessionId) {
          tmuxSessionId = ensuredSessionId;
        }
      } else if (!tmuxSessionId) {
        tmuxSessionId = await this.resolveFallbackTmuxSessionId();
      }

      const terminalCommand = this.resolveTerminalStartupCommand(
        command,
        tmuxSessionId,
      );

      if (enableHttpApi) {
        try {
          port = this.portManager.assignPortToTerminal(this.activeInstanceId);
          this.logger.info(
            `[OpenCodeTuiProvider] Assigned port ${port} to terminal ${this.activeInstanceId}`,
          );
        } catch (error) {
          this.logger.error(
            `[OpenCodeTuiProvider] Failed to assign port: ${error instanceof Error ? error.message : String(error)}`,
          );
          vscode.window.showWarningMessage(
            "Failed to assign port for OpenCode HTTP API. Running without HTTP features.",
          );
        }
      }

      this.terminalManager.createTerminal(
        this.activeInstanceId,
        terminalCommand,
        port
          ? {
              _EXTENSION_OPENCODE_PORT: port.toString(),
              OPENCODE_CALLER: "vscode",
            }
          : {},
        port,
        this.lastKnownCols || undefined,
        this.lastKnownRows || undefined,
        this.activeInstanceId,
        workspacePath,
      );

      // Ensure the instance store record has the terminal key so that
      // ExtensionLifecycle.getActiveTerminalId() can resolve it correctly.
      // Without this, the store may be empty (fresh install) or the record
      // may lack a terminalKey, causing all send commands to target a
      // non-existent terminal ID.
      if (this.instanceStore) {
        try {
          const existing = this.instanceStore.get(this.activeInstanceId);
          if (existing) {
            this.instanceStore.upsert({
              ...existing,
              runtime: {
                ...existing.runtime,
                terminalKey: this.activeInstanceId,
                tmuxSessionId,
                port: port ?? existing.runtime.port,
              },
            });
          } else {
            // Fresh install: no record exists yet — create one so getActive() works
            this.instanceStore.upsert({
              config: { id: this.activeInstanceId },
              runtime: {
                terminalKey: this.activeInstanceId,
                tmuxSessionId,
                port,
              },
              state: "connected",
            });
          }
        } catch (err) {
          this.logger.warn(
            `[OpenCodeTuiProvider] Failed to update instance store with terminal key: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.dataListener = this.terminalManager.onData((event) => {
        if (event.id === this.activeInstanceId) {
          this._view?.webview.postMessage({
            type: "terminalOutput",
            data: event.data,
          });
        }
      });

      this.exitListener = this.terminalManager.onExit((id) => {
        if (id === this.activeInstanceId) {
          this.resetState();
          this._view?.webview.postMessage({
            type: "terminalExited",
          });
        }
      });

      this.isStarted = true;

      if (enableHttpApi && port) {
        this.apiClient = new OpenCodeApiClient(port, 10, 200, httpTimeout);
        await this.pollForHttpReadiness();
      } else {
        this.logger.info(
          "[OpenCodeTuiProvider] HTTP API disabled or unavailable, using message passing fallback",
        );
        this.httpAvailable = false;
      }
    } finally {
      this.isStarting = false;
      void this.emitTreeSnapshot();
    }
  }

  private resolveSnapshotActiveSessionId(): string | null {
    const activeTmuxSessionId = this.resolveTmuxSessionIdForInstance(
      this.activeInstanceId,
    );
    return activeTmuxSessionId ?? this.activeInstanceId ?? null;
  }

  private hasWorkspaceContext(): boolean {
    if (this.resolveWorkspacePathFromActiveInstance()) {
      return true;
    }

    return Boolean(vscode.workspace.workspaceFolders?.length);
  }

  private withWorkspaceEmptyState(snapshot: TreeSnapshot): TreeSnapshot {
    if (
      !this.hasWorkspaceContext() &&
      snapshot.sessions.length === 0 &&
      snapshot.emptyState !== "no-tmux"
    ) {
      return {
        ...snapshot,
        emptyState: "no-workspace",
      };
    }

    return snapshot;
  }

  private async emitTreeSnapshot(): Promise<void> {
    if (!this._view || !this.tmuxSessionManager) {
      return;
    }

    try {
      const snapshot = await this.tmuxSessionManager.createTreeSnapshot(
        this.resolveSnapshotActiveSessionId(),
      );
      const filteredSnapshot = this.filterSnapshotToCurrentWorkspace(snapshot);
      this._view.webview.postMessage(
        this.withWorkspaceEmptyState(filteredSnapshot),
      );
    } catch (error) {
      this.logger.warn(
        `[OpenCodeTuiProvider] Failed to emit tree snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private filterSnapshotToCurrentWorkspace(
    snapshot: TreeSnapshot,
  ): TreeSnapshot {
    const workspacePath = this.resolveWorkspacePathFromActiveInstance();
    const fallbackWorkspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const currentWorkspacePath = workspacePath || fallbackWorkspacePath;

    if (!currentWorkspacePath) {
      return snapshot;
    }

    const workspaceName = path.basename(currentWorkspacePath);
    const sessions = snapshot.sessions.filter(
      (session) => session.workspace === workspaceName,
    );

    const activeSessionId = sessions.some(
      (session) => session.id === snapshot.activeSessionId,
    )
      ? snapshot.activeSessionId
      : null;

    return {
      ...snapshot,
      sessions,
      activeSessionId,
      emptyState: sessions.length === 0 ? "no-sessions" : undefined,
    };
  }

  private async pollForHttpReadiness(): Promise<void> {
    if (!this.apiClient) {
      return;
    }

    const maxRetries = 10;
    const delayMs = 200;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const isHealthy = await this.apiClient.healthCheck();
        if (isHealthy) {
          this.httpAvailable = true;
          this.logger.info("[OpenCodeTuiProvider] HTTP API is ready");
          await this.sendAutoContext();
          return;
        }
      } catch {
        this.logger.info(
          `[OpenCodeTuiProvider] Health check attempt ${attempt}/${maxRetries} failed`,
        );
      }

      if (attempt < maxRetries) {
        await this.sleep(delayMs);
      }
    }

    this.logger.info(
      "[OpenCodeTuiProvider] HTTP API not available after retries, using message passing fallback",
    );
    this.httpAvailable = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resolveStartupWorkspacePath(): StartupWorkspaceResolution {
    const instanceWorkspacePath = this.resolveWorkspacePathFromActiveInstance();
    if (instanceWorkspacePath) {
      return { workspacePath: instanceWorkspacePath, isWorkspaceScoped: true };
    }

    const workspaceFolderPath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolderPath) {
      return { workspacePath: workspaceFolderPath, isWorkspaceScoped: true };
    }

    return { workspacePath: os.homedir(), isWorkspaceScoped: false };
  }

  private resolveWorkspacePathFromActiveInstance(): string | undefined {
    if (!this.instanceStore) {
      return undefined;
    }

    const record = this.instanceStore.get(this.activeInstanceId);
    const workspaceUri = record?.config.workspaceUri;
    if (!workspaceUri) {
      return undefined;
    }

    try {
      const parsed = vscode.Uri.parse(workspaceUri);
      return parsed.fsPath || undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureWorkspaceSession(
    workspacePath: string,
  ): Promise<string | undefined> {
    if (!this.tmuxSessionManager) {
      return undefined;
    }

    const sessionName = path.basename(workspacePath) || this.activeInstanceId;

    try {
      const result = await this.tmuxSessionManager.ensureSession(
        sessionName,
        workspacePath,
      );
      this.logger.info(
        `[OpenCodeTuiProvider] tmux session ${result.action}: ${result.session.id}`,
      );
      return result.session.id;
    } catch (error) {
      if (error instanceof TmuxUnavailableError) {
        this.logger.info(
          "[OpenCodeTuiProvider] tmux unavailable, continuing with default startup",
        );
        return undefined;
      }

      this.logger.warn(
        `[OpenCodeTuiProvider] Failed to ensure tmux session: ${error instanceof Error ? error.message : String(error)}. Continuing with default startup.`,
      );
      return undefined;
    }
  }

  private resolveTerminalStartupCommand(
    defaultCommand: string,
    tmuxSessionId?: string,
  ): string {
    if (!tmuxSessionId) {
      return defaultCommand;
    }

    return `tmux attach-session -t ${tmuxSessionId}`;
  }

  private resolveTmuxSessionIdForInstance(
    instanceId: InstanceId,
  ): string | undefined {
    if (!this.instanceStore) {
      return undefined;
    }

    return this.instanceStore.get(instanceId)?.runtime.tmuxSessionId;
  }

  private async resolveFallbackTmuxSessionId(): Promise<string | undefined> {
    if (!this.tmuxSessionManager) {
      return undefined;
    }

    try {
      const sessions = await this.tmuxSessionManager.discoverSessions();
      if (sessions.length === 0) {
        return undefined;
      }

      const preferredSession =
        sessions.find((session) => session.isActive) ?? sessions[0];
      return preferredSession?.id;
    } catch (error) {
      this.logger.warn(
        `[OpenCodeTuiProvider] Failed to resolve fallback tmux session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private resolveInstanceIdFromSessionId(sessionId: string): InstanceId {
    if (!this.instanceStore) {
      return sessionId;
    }

    if (this.instanceStore.get(sessionId)) {
      return sessionId;
    }

    const records = this.instanceStore.getAll();

    const tmuxMapped = records.find(
      (record) => record.runtime.tmuxSessionId === sessionId,
    );
    if (tmuxMapped) {
      return tmuxMapped.config.id;
    }

    const workspaceMapped = records.find((record) => {
      const workspaceUri = record.config.workspaceUri;
      if (!workspaceUri) {
        return false;
      }

      try {
        const workspacePath = vscode.Uri.parse(workspaceUri).fsPath;
        return path.basename(workspacePath) === sessionId;
      } catch {
        return false;
      }
    });

    return workspaceMapped?.config.id ?? sessionId;
  }

  public async switchToTmuxSession(sessionId: string): Promise<void> {
    await this.switchToInstance(this.resolveInstanceIdFromSessionId(sessionId));
  }

  /**
   * Sends auto-context to OpenCode when the terminal starts and HTTP is ready.
   * Respects the autoShareContext configuration setting.
   */
  private async sendAutoContext(): Promise<void> {
    // Only send once per terminal session
    if (this.autoContextSent) {
      return;
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const enableHttpApi = config.get<boolean>("enableHttpApi", true);
    const autoShareContext = config.get<boolean>("autoShareContext", true);

    if (!enableHttpApi) {
      this.logger.info(
        "[OpenCodeTuiProvider] HTTP API disabled, skipping auto-context",
      );
      return;
    }

    if (!autoShareContext) {
      this.logger.info(
        "[OpenCodeTuiProvider] Auto-context sharing disabled by user",
      );
      return;
    }

    if (!this.httpAvailable || !this.apiClient) {
      this.logger.info(
        "[OpenCodeTuiProvider] HTTP not available, skipping auto-context",
      );
      return;
    }

    const context = this.contextSharingService.getCurrentContext();
    if (!context) {
      this.logger.info(
        "[OpenCodeTuiProvider] No active editor, skipping auto-context",
      );
      return;
    }

    const fileRef = this.contextSharingService.formatContext(context);
    this.logger.info(`[OpenCodeTuiProvider] Sending auto-context: ${fileRef}`);

    try {
      await this.apiClient.appendPrompt(fileRef);
      this.autoContextSent = true;
      this.logger.info(
        "[OpenCodeTuiProvider] Auto-context sent successfully via HTTP",
      );
    } catch (error) {
      this.logger.error(
        `[OpenCodeTuiProvider] Failed to send auto-context: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  restart(): void {
    this.disposeListeners();
    this.terminalManager.killTerminal(this.activeInstanceId);
    this.resetState();

    this._view?.webview.postMessage({ type: "clearTerminal" });

    this.startOpenCode();
  }

  private resetState(releasePorts: boolean = true): void {
    this.isStarted = false;
    this.isStarting = false;
    this.httpAvailable = false;
    this.apiClient = undefined;
    this.autoContextSent = false;
    if (releasePorts) {
      this.portManager.releaseTerminalPorts(this.activeInstanceId);
    }
  }

  private disposeListeners(): void {
    if (this.dataListener) {
      this.dataListener.dispose();
      this.dataListener = undefined;
    }
    if (this.exitListener) {
      this.exitListener.dispose();
      this.exitListener = undefined;
    }
  }

  private handleMessage(message: any): void {
    switch (message.type) {
      case "terminalInput":
        this.terminalManager.writeToTerminal(
          this.activeInstanceId,
          message.data,
        );
        break;
      case "terminalResize":
        this.lastKnownCols = message.cols;
        this.lastKnownRows = message.rows;
        this.terminalManager.resizeTerminal(
          this.activeInstanceId,
          message.cols,
          message.rows,
        );
        break;
      case "ready":
        if (message.cols && message.rows) {
          this.lastKnownCols = message.cols;
          this.lastKnownRows = message.rows;
        }
        if (!this.isStarted) {
          this.startOpenCode();
        } else {
          if (this.lastKnownCols && this.lastKnownRows) {
            this.terminalManager.resizeTerminal(
              this.activeInstanceId,
              this.lastKnownCols,
              this.lastKnownRows,
            );
          }
        }
        // Send platform info to webview for Windows-specific handling
        this._view?.webview.postMessage({
          type: "platformInfo",
          platform: process.platform,
        });
        break;
      case "filesDropped":
        this.handleFilesDropped(message.files, message.shiftKey);
        break;
      case "openUrl":
        vscode.env.openExternal(vscode.Uri.parse(message.url));
        break;
      case "openFile":
        this.handleOpenFile(
          message.path,
          message.line,
          message.endLine,
          message.column,
        );
        break;
      case "listTerminals":
        this.handleListTerminals();
        break;
      case "terminalAction":
        this.handleTerminalAction(
          message.action,
          message.terminalName,
          message.command,
        );
        break;

      case "getClipboard":
        this.handleGetClipboard();
        break;
      case "setClipboard":
        this.handleSetClipboard(message.text);
        break;
      case "triggerPaste":
        this.handlePaste();
        break;
      case "imagePasted":
        this.handleImagePasted(message.data);
        break;
      case "switchSession":
        if (message.sessionId) {
          void this.switchToInstance(
            this.resolveInstanceIdFromSessionId(message.sessionId),
          );
        }
        break;
    }
  }

  private async handleSetClipboard(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
    } catch (error) {
      this.logger.error(
        `[OpenCodeTuiProvider] Failed to write clipboard: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handlePaste(): Promise<void> {
    try {
      const text = await vscode.env.clipboard.readText();
      if (text) {
        this.pasteText(text);
      }
    } catch (error) {
      this.logger.error(
        `[OpenCodeTuiProvider] Failed to paste: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleImagePasted(data: string): Promise<void> {
    try {
      const base64Match = data.match(
        /^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!base64Match) {
        this.logger.error(
          "[OpenCodeTuiProvider] Invalid image data URL format",
        );
        return;
      }
      const mimeType = base64Match[1];
      if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
        this.logger.error(
          `[OpenCodeTuiProvider] Unsupported image type: ${mimeType}`,
        );
        return;
      }
      const buffer = Buffer.from(base64Match[2], "base64");
      if (buffer.length > MAX_IMAGE_SIZE) {
        this.logger.error(
          "[OpenCodeTuiProvider] Image exceeds 10MB size limit",
        );
        return;
      }
      const extension = mimeType.split("/")[1];
      const tmpPath = path.join(
        os.tmpdir(),
        `opencode-clipboard-${randomUUID()}.${extension}`,
      );
      await fs.promises.writeFile(tmpPath, buffer, {
        flag: "wx",
        mode: 0o600,
      });
      this.pasteText(tmpPath);
      setTimeout(
        async () => {
          try {
            await fs.promises.unlink(tmpPath);
            this.logger.debug(
              `[OpenCodeTuiProvider] Cleaned up temp file: ${tmpPath}`,
            );
          } catch (err) {
            this.logger.warn(
              `[OpenCodeTuiProvider] Failed to cleanup temp file: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        5 * 60 * 1000,
      );
    } catch (error) {
      this.logger.error(
        `[OpenCodeTuiProvider] Failed to handle pasted image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleGetClipboard(): Promise<void> {
    try {
      const text = await vscode.env.clipboard.readText();
      this._view?.webview.postMessage({
        type: "clipboardContent",
        text: text,
      });
    } catch (error) {
      this.logger.error(
        `[OpenCodeTuiProvider] Failed to read clipboard: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleListTerminals(): Promise<void> {
    const terminals = await this.getTerminalEntries();
    this._view?.webview.postMessage({
      type: "terminalList",
      terminals,
    });
  }

  private async handleTerminalAction(
    action: "focus" | "sendCommand" | "capture",
    terminalName: string,
    command?: string,
  ): Promise<void> {
    const targetTerminal = vscode.window.terminals.find(
      (terminal) => terminal.name === terminalName,
    );

    if (!targetTerminal) {
      this.logger.warn(`Terminal not found: ${terminalName}`);
      return;
    }

    switch (action) {
      case "focus":
        targetTerminal.show();
        break;
      case "sendCommand":
        if (command) {
          await this.sendCommandToTerminal(targetTerminal, command);
        }
        break;
      case "capture":
        this.startTerminalCapture(targetTerminal, terminalName);
        break;
    }
  }

  private async getTerminalEntries(): Promise<
    Array<{ name: string; cwd: string }>
  > {
    const entries: Array<{ name: string; cwd: string }> = [];

    for (const terminal of vscode.window.terminals) {
      if (terminal.name === "OpenCode TUI") {
        continue;
      }

      let cwd = "";
      try {
        cwd = terminal.shellIntegration?.cwd?.fsPath ?? "";
      } catch {
        cwd = "";
      }

      entries.push({
        name: terminal.name,
        cwd,
      });
    }

    return entries;
  }

  private async sendCommandToTerminal(
    terminal: vscode.Terminal,
    command: string,
  ): Promise<void> {
    const configKey = "opencodeTui.allowTerminalCommands";
    const allowed = this.context.globalState.get<boolean>(configKey);

    if (allowed) {
      terminal.sendText(command);
      return;
    }

    const result = await vscode.window.showInformationMessage(
      "Allow OpenCode to send commands to external terminals?",
      "Yes",
      "Yes, don't ask again",
      "No",
    );

    if (result === "Yes") {
      terminal.sendText(command);
      return;
    }

    if (result === "Yes, don't ask again") {
      await this.context.globalState.update(configKey, true);
      terminal.sendText(command);
    }
  }

  private startTerminalCapture(
    terminal: vscode.Terminal,
    terminalName: string,
  ): void {
    const result = this.captureManager.startCapture(terminal);
    if (result.success) {
      vscode.window.showInformationMessage(
        `Started capturing terminal: ${terminalName}`,
      );
      return;
    }

    vscode.window.showErrorMessage(
      `Failed to start capture: ${result.error ?? "Unknown error"}`,
    );
  }

  private async handleOpenFile(
    path: string,
    line?: number,
    endLine?: number,
    column?: number,
  ): Promise<void> {
    // Security: Validate path to prevent path traversal attacks
    if (path.includes("..") || path.includes("\0") || path.includes("~")) {
      vscode.window.showErrorMessage(
        "Invalid file path: Path traversal detected",
      );
      return;
    }

    try {
      const normalizedPath = path.replace(/\\/g, "/");

      let uri: vscode.Uri;

      if (vscode.Uri.parse(path).scheme === "file") {
        uri = vscode.Uri.file(path);
      } else if (normalizedPath.startsWith("/")) {
        uri = vscode.Uri.file(normalizedPath);
      } else {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          uri = vscode.Uri.joinPath(workspaceFolders[0].uri, normalizedPath);
        } else {
          uri = vscode.Uri.file(normalizedPath);
        }
      }

      try {
        const selection = this.createSelection(line, endLine, column);

        await vscode.window.showTextDocument(uri, {
          selection,
          preview: true,
        });
      } catch (openError) {
        const matchedUri = await this.fuzzyMatchFile(normalizedPath);
        if (matchedUri) {
          const selection = this.createSelection(line, endLine, column);

          await vscode.window.showTextDocument(matchedUri, {
            selection,
            preview: true,
          });
        } else {
          vscode.window.showErrorMessage(`Failed to open file: ${path}`);
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open file: ${path}`);
    }
  }

  private createSelection(
    line?: number,
    endLine?: number,
    column?: number,
  ): vscode.Range | undefined {
    if (!line) return undefined;

    const MAX_COLUMN = 9999;
    return new vscode.Range(
      Math.max(0, line - 1),
      Math.max(0, (column || 1) - 1),
      Math.max(0, (endLine || line) - 1),
      endLine ? MAX_COLUMN : Math.max(0, (column || 1) - 1),
    );
  }

  private async fuzzyMatchFile(path: string): Promise<vscode.Uri | null> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
      }

      const pathParts = path.split("/").filter((part) => part.length > 0);
      const filename = pathParts[pathParts.length - 1];

      const pattern = `**/${filename}*`;
      const files = await vscode.workspace.findFiles(pattern, null, 100);

      files.sort((a, b) => {
        const aPath = a.fsPath.toLowerCase();
        const bPath = b.fsPath.toLowerCase();
        const lowerPath = path.toLowerCase();

        if (aPath.endsWith(lowerPath)) return -1;
        if (bPath.endsWith(lowerPath)) return 1;

        const aDirParts = a.fsPath.split("/");
        const bDirParts = b.fsPath.split("/");

        for (let i = 0; i < pathParts.length - 1; i++) {
          const expectedPart = pathParts[i].toLowerCase();
          if (aDirParts[i] && aDirParts[i].toLowerCase() === expectedPart) {
            return -1;
          }
          if (bDirParts[i] && bDirParts[i].toLowerCase() === expectedPart) {
            return 1;
          }
        }

        return 0;
      });

      return files[0] || null;
    } catch (error) {
      this.logger.error(
        `Fuzzy match failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private handleFilesDropped(files: string[], shiftKey: boolean): void {
    this.logger.info(
      `[PROVIDER] handleFilesDropped - files: ${JSON.stringify(files)} shiftKey: ${shiftKey}`,
    );

    // Normalize file:// URIs to filesystem paths (e.g. from drag & drop)
    const normalizedFiles = files.map((file) => {
      if (file.startsWith("file://")) {
        try {
          const url = new URL(file);
          let decoded = decodeURIComponent(url.pathname);
          // On Windows, file:///E:/path produces /E:/path — strip leading slash
          if (
            decoded.length >= 3 &&
            decoded[0] === "/" &&
            /[A-Za-z]/.test(decoded[1]) &&
            decoded[2] === ":"
          ) {
            decoded = decoded.slice(1);
          }
          return decoded;
        } catch {
          return file;
        }
      }
      return file;
    });

    const dedupedFiles = [
      ...new Set(normalizedFiles.map((p) => path.normalize(p))),
    ];

    if (shiftKey) {
      const fileRefs = dedupedFiles
        .map((file) => `@${vscode.workspace.asRelativePath(file)}`)
        .join(" ");
      this.logger.info(`[PROVIDER] Writing with @: ${fileRefs}`);
      this.terminalManager.writeToTerminal(
        this.activeInstanceId,
        fileRefs + " ",
      );
    } else {
      const filePaths = dedupedFiles
        .map((file) => vscode.workspace.asRelativePath(file))
        .join(" ");
      this.logger.info(`[PROVIDER] Writing without @: ${filePaths}`);
      this.terminalManager.writeToTerminal(
        this.activeInstanceId,
        filePaths + " ",
      );
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );

    const nonce = this.getNonce();

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
    #sidebar-container {
      width: 100%;
      min-height: 34px;
      max-height: 68px;
      border-bottom: 1px solid #333;
      overflow-x: auto;
      overflow-y: hidden;
      display: none; /* Hidden by default, shown when tree data arrives */
      align-items: center;
    }
    #sidebar-container:not(:empty) {
      display: flex;
    }
    #terminal-container {
      flex: 1;
      height: calc(100% - 34px);
      min-width: 0;
    }
    .session-tab-list {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      min-width: min-content;
    }
    .session-tab-item {
      border: 1px solid #3a3a3a;
      border-radius: 6px;
      background: #252526;
      color: #ccc;
      padding: 4px 10px;
      font-size: 12px;
      line-height: 1.2;
      white-space: nowrap;
      cursor: pointer;
    }
    .session-tab-item:hover {
      background-color: #2a2d2e;
    }
    .session-tab-item.active {
      background-color: #04395e;
      border-color: #0e639c;
      color: #fff;
    }
    .session-tab-empty-state {
      padding: 8px 12px;
      color: #888;
      font-style: italic;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div id="sidebar-container"></div>
  <div id="terminal-container"></div>
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

  dispose(): void {
    this.disposeListeners();
    this.activeInstanceSubscription?.dispose();
    this.activeInstanceSubscription = undefined;
    if (this.isStarted) {
      this.terminalManager.killTerminal(this.activeInstanceId);
    }
  }
}
