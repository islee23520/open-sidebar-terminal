import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import type { CliAdapter } from "../core/cli";
import {
  OpenCodeAdapter,
  ClaudeAdapter,
  CodexAdapter,
  GeminiAdapter,
  AiderAdapter,
} from "../adapters";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { PortManager } from "../services/PortManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import { TabManager } from "../services/TabManager";
import { ALLOWED_IMAGE_TYPES, CliToolType, MAX_IMAGE_SIZE } from "../types";

interface ToolRuntimeConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class CliAdapterFactory {
  private readonly adapters = new Map<CliToolType, CliAdapter>();

  constructor(terminalManager: TerminalManager) {
    this.adapters.set("opencode", new OpenCodeAdapter(terminalManager));
    this.adapters.set("claude", new ClaudeAdapter(terminalManager));
    this.adapters.set("codex", new CodexAdapter(terminalManager));
    this.adapters.set("gemini", new GeminiAdapter(terminalManager));
    this.adapters.set("aider", new AiderAdapter(terminalManager));
  }

  getAdapter(toolId: CliToolType): CliAdapter {
    const adapter = this.adapters.get(toolId);
    if (!adapter) {
      throw new Error(`Unknown tool: ${toolId}`);
    }

    return adapter;
  }
}

export class OpenCodeTuiProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeTui";
  private static readonly LEGACY_TERMINAL_ID: InstanceId = "opencode-main";
  private static readonly DEFAULT_TOOL_COMMANDS: Record<CliToolType, string> = {
    opencode: "opencode -c",
    claude: "claude",
    codex: "codex",
    gemini: "gemini",
    aider: "aider",
  };
  private _view?: vscode.WebviewView;
  private activeInstanceId: InstanceId = "default";
  private isStarted = false;
  private apiClient?: OpenCodeApiClient;
  private readonly portManager: PortManager;
  private readonly contextSharingService: ContextSharingService;
  private readonly tabManager = new TabManager();
  private readonly adapterFactory: CliAdapterFactory;
  private readonly tabStateSubscriptions: vscode.Disposable[] = [];
  private readonly logger = OutputChannelService.getInstance();
  private httpAvailable = false;
  private autoContextSent = false;
  private dataListener?: vscode.Disposable;
  private exitListener?: vscode.Disposable;
  private activeInstanceSubscription?: vscode.Disposable;
  private lastKnownCols: number = 0;
  private lastKnownRows: number = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly captureManager: OutputCaptureManager,
    private readonly instanceStore?: InstanceStore,
  ) {
    this.portManager = new PortManager();
    this.contextSharingService = new ContextSharingService();
    this.adapterFactory = new CliAdapterFactory(this.terminalManager);
    this.subscribeToTabChanges();

    if (this.instanceStore) {
      this.subscribeToActiveInstanceChanges();
    } else {
      this.activeInstanceId = OpenCodeTuiProvider.LEGACY_TERMINAL_ID;
    }
  }

  private subscribeToTabChanges(): void {
    this.tabStateSubscriptions.push(
      this.tabManager.onDidChangeTabs(() => {
        this.postTabsState();
      }),
      this.tabManager.onDidChangeActive((activeTab) => {
        if (!activeTab) {
          this.activeInstanceId = OpenCodeTuiProvider.LEGACY_TERMINAL_ID;
          this.resetState(false);
          this._view?.webview.postMessage({ type: "clearTerminal" });
          return;
        }

        this.activeInstanceId = activeTab.id;
        this.isStarted =
          this.terminalManager.getTerminal(activeTab.id) !== undefined;
      }),
    );
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
    const targetTab = this.tabManager.getTab(instanceId);
    if (targetTab) {
      await this.switchTab(targetTab.id);
      return;
    }

    if (instanceId === this.activeInstanceId) {
      return;
    }

    this.activeInstanceId = instanceId;
    const existingTerminal =
      this.terminalManager.getByInstance(instanceId) ||
      this.terminalManager.getTerminal(instanceId);

    if (!existingTerminal) {
      await this.startOpenCode();
      return;
    }

    this._view?.webview.postMessage({ type: "clearTerminal" });
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
    this.postTabsState();

    const processAlive =
      this.isStarted &&
      this.terminalManager.getTerminal(this.activeInstanceId) !== undefined;

    if (this.isStarted && !processAlive) {
      this.resetState();
    }

    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });

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
    const activeTab = this.tabManager.getActiveTab();
    if (
      activeTab?.toolId === "opencode" &&
      this.terminalManager.getTerminal(activeTab.id)
    ) {
      this.isStarted = true;
      return;
    }

    await this.createTab("opencode");
  }

  public async createTab(toolId: CliToolType): Promise<void> {
    const tab = this.tabManager.createTab(toolId);
    const adapter = this.adapterFactory.getAdapter(toolId);
    const config = this.getToolConfig(toolId);

    try {
      await adapter.start({
        instanceId: tab.id,
        toolId,
        command: config.command,
        args: config.args,
        env: config.env,
        workingDir: this.getWorkspaceRoot(),
        cols: this.lastKnownCols || undefined,
        rows: this.lastKnownRows || undefined,
      });
    } catch (error) {
      this.tabManager.removeTab(tab.id);
      const message =
        error instanceof Error ? error.message : "Failed to start CLI tool";
      this.logger.error(`[OpenCodeTuiProvider] ${message}`);
      vscode.window.showErrorMessage(
        `Failed to create ${toolId} tab: ${message}`,
      );
      return;
    }

    this.isStarted = true;
    this.activeInstanceId = tab.id;
    this.reconnectListeners();
    this.upsertInstanceStore(tab.id, toolId, adapter.getPort(tab.id));

    await this.switchTab(tab.id);
  }

  public async switchTab(tabId: string): Promise<void> {
    const tab = this.tabManager.getTab(tabId);
    if (!tab) {
      return;
    }

    this.tabManager.setActiveTab(tabId);
    this.activeInstanceId = tab.id;

    this._view?.webview.postMessage({
      type: "switchTab",
      tabId,
      toolId: tab.toolId,
    });

    this._view?.webview.postMessage({ type: "clearTerminal" });
    await this.refreshActiveApiClient();

    if (this.lastKnownCols && this.lastKnownRows) {
      this.adapterFactory
        .getAdapter(tab.toolId)
        .resize(tab.id, this.lastKnownCols, this.lastKnownRows);
    }
  }

  public async closeTab(tabId: string): Promise<void> {
    const tab = this.tabManager.getTab(tabId);
    if (!tab) {
      return;
    }

    const wasActive = this.tabManager.getActiveTab()?.id === tabId;
    const adapter = this.adapterFactory.getAdapter(tab.toolId);

    await adapter.stop(tab.id);
    this.tabManager.removeTab(tabId);

    if (!wasActive) {
      return;
    }

    const nextActive = this.tabManager.getActiveTab();
    if (!nextActive) {
      this.activeInstanceId = OpenCodeTuiProvider.LEGACY_TERMINAL_ID;
      this.resetState(false);
      this._view?.webview.postMessage({ type: "clearTerminal" });
      return;
    }

    await this.switchTab(nextActive.id);
  }

  public async restartOpenCode(): Promise<void> {
    const active = this.tabManager.getActiveTab();
    if (active) {
      await this.closeTab(active.id);
    }

    await this.createTab("opencode");
  }

  public sendToTerminal(data: string): void {
    const activeTab = this.tabManager.getActiveTab();
    if (activeTab) {
      this.adapterFactory
        .getAdapter(activeTab.toolId)
        .writeInput(activeTab.id, data);
      return;
    }

    this.terminalManager.writeToTerminal(this.activeInstanceId, data);
  }

  private postTabsState(): void {
    const tabs = this.tabManager.getAllTabs();
    const activeTabId = this.tabManager.getActiveTab()?.id ?? null;
    this._view?.webview.postMessage({
      type: "tabsChanged",
      tabs,
      activeTabId,
    });
  }

  private getToolConfig(toolId: CliToolType): ToolRuntimeConfig {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    const toolConfig = config.get<{
      command?: string;
      shellArgs?: string[];
      env?: Record<string, unknown>;
    }>(`tools.${toolId}`);

    const fallbackCommand =
      toolId === "opencode"
        ? config.get<string>(
            "command",
            OpenCodeTuiProvider.DEFAULT_TOOL_COMMANDS.opencode,
          )
        : OpenCodeTuiProvider.DEFAULT_TOOL_COMMANDS[toolId];

    const env: Record<string, string> = {};
    const sourceEnv = toolConfig?.env ?? {};
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }

    return {
      command: toolConfig?.command ?? fallbackCommand,
      args: toolConfig?.shellArgs ?? [],
      env,
    };
  }

  private getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private async refreshActiveApiClient(): Promise<void> {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab || activeTab.toolId !== "opencode") {
      this.apiClient = undefined;
      this.httpAvailable = false;
      return;
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const enableHttpApi = config.get<boolean>("enableHttpApi", true);
    if (!enableHttpApi) {
      this.apiClient = undefined;
      this.httpAvailable = false;
      return;
    }

    const port = this.adapterFactory
      .getAdapter("opencode")
      .getPort(activeTab.id);
    if (!port) {
      this.apiClient = undefined;
      this.httpAvailable = false;
      return;
    }

    const httpTimeout = config.get<number>("httpTimeout", 5000);
    this.apiClient = new OpenCodeApiClient(port, 10, 200, httpTimeout);
    await this.pollForHttpReadiness();
  }

  private upsertInstanceStore(
    instanceId: string,
    toolId: CliToolType,
    port?: number,
  ): void {
    if (!this.instanceStore) {
      return;
    }

    try {
      const existing = this.instanceStore.get(instanceId);
      if (existing) {
        this.instanceStore.upsert({
          ...existing,
          config: {
            ...existing.config,
            id: instanceId,
            toolId,
          },
          runtime: {
            ...existing.runtime,
            terminalKey: instanceId,
            port,
          },
          state: "connected",
        });
        return;
      }

      this.instanceStore.upsert({
        config: {
          id: instanceId,
          toolId,
        },
        runtime: { terminalKey: instanceId, port },
        state: "connected",
      });
    } catch (error) {
      this.logger.warn(
        `[OpenCodeTuiProvider] Failed to sync instance store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    void this.restartOpenCode();
  }

  private resetState(releasePorts: boolean = true): void {
    this.isStarted = false;
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

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case "terminalInput":
        this.sendToTerminal(message.data);
        break;
      case "terminalResize":
        this.lastKnownCols = message.cols;
        this.lastKnownRows = message.rows;
        {
          const activeTab = this.tabManager.getActiveTab();
          if (activeTab) {
            this.adapterFactory
              .getAdapter(activeTab.toolId)
              .resize(activeTab.id, message.cols, message.rows);
          } else {
            this.terminalManager.resizeTerminal(
              this.activeInstanceId,
              message.cols,
              message.rows,
            );
          }
        }
        break;
      case "ready":
        if (message.cols && message.rows) {
          this.lastKnownCols = message.cols;
          this.lastKnownRows = message.rows;
        }
        if (!this.isStarted) {
          await this.startOpenCode();
        } else {
          const activeTab = this.tabManager.getActiveTab();
          if (this.lastKnownCols && this.lastKnownRows) {
            if (activeTab) {
              this.adapterFactory
                .getAdapter(activeTab.toolId)
                .resize(activeTab.id, this.lastKnownCols, this.lastKnownRows);
            } else {
              this.terminalManager.resizeTerminal(
                this.activeInstanceId,
                this.lastKnownCols,
                this.lastKnownRows,
              );
            }
          }
        }

        this.postTabsState();
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
        await this.handleImagePasted(message.data);
        break;
      case "createTab":
        if (message.toolId) {
          await this.createTab(message.toolId as CliToolType);
        }
        break;
      case "closeTab":
        if (typeof message.tabId === "string") {
          await this.closeTab(message.tabId);
        }
        break;
      case "switchTab":
        if (typeof message.tabId === "string") {
          await this.switchTab(message.tabId);
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
      this.sendToTerminal(fileRefs + " ");
    } else {
      const filePaths = dedupedFiles
        .map((file) => vscode.workspace.asRelativePath(file))
        .join(" ");
      this.logger.info(`[PROVIDER] Writing without @: ${filePaths}`);
      this.sendToTerminal(filePaths + " ");
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
    }
    #terminal-container {
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
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

    for (const subscription of this.tabStateSubscriptions) {
      subscription.dispose();
    }
    this.tabStateSubscriptions.length = 0;

    for (const tab of this.tabManager.getAllTabs()) {
      void this.adapterFactory
        .getAdapter(tab.toolId)
        .stop(tab.id)
        .catch((error) => {
          this.logger.warn(
            `[OpenCodeTuiProvider] Failed to stop tab ${tab.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    if (this.isStarted) {
      this.terminalManager.killTerminal(this.activeInstanceId);
    }
  }
}
