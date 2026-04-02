import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { OutputCaptureManager } from "../../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../../services/OpenCodeApiClient";
import { PortManager } from "../../services/PortManager";
import { ContextSharingService } from "../../services/ContextSharingService";
import { OutputChannelService } from "../../services/OutputChannelService";
import { InstanceId, InstanceStore } from "../../services/InstanceStore";
import { resolveAiToolConfigs, getToolLaunchCommand } from "../../types";
import {
  TmuxSessionManager,
  TmuxUnavailableError,
} from "../../services/TmuxSessionManager";
import { TerminalManager } from "../../terminals/TerminalManager";

type LaunchChoice = "opencode" | "shell";

interface StartupWorkspaceResolution {
  workspacePath: string;
  isWorkspaceScoped: boolean;
}

interface OpenCodeSessionRuntimeCallbacks {
  postMessage: (message: unknown) => void;
  onActiveInstanceChanged: (instanceId: InstanceId) => void;
  requestStartOpenCode: () => Promise<void>;
}

export class OpenCodeSessionRuntime {
  private static readonly LEGACY_TERMINAL_ID: InstanceId = "opencode-main";

  private activeInstanceId: InstanceId = "default";
  private isStarted = false;
  private isStarting = false;
  private apiClient?: OpenCodeApiClient;
  private httpAvailable = false;
  private autoContextSent = false;
  private dataListener?: vscode.Disposable;
  private exitListener?: vscode.Disposable;
  private activeInstanceSubscription?: vscode.Disposable;
  private lastKnownCols = 0;
  private lastKnownRows = 0;
  private selectedTmuxSessionId?: string;
  private forceNativeShellNextStart = false;

  public constructor(
    private readonly terminalManager: TerminalManager,
    _captureManager: OutputCaptureManager,
    _openCodeApiClient: OpenCodeApiClient | undefined,
    private readonly portManager: PortManager,
    private readonly tmuxSessionManager: TmuxSessionManager | undefined,
    private readonly instanceStore: InstanceStore | undefined,
    private readonly logger: OutputChannelService,
    private readonly contextSharingService: ContextSharingService,
    private readonly callbacks: OpenCodeSessionRuntimeCallbacks,
  ) {
    if (this.instanceStore) {
      this.subscribeToActiveInstanceChanges();
    } else {
      this.activeInstanceId = OpenCodeSessionRuntime.LEGACY_TERMINAL_ID;
    }
  }

  public getActiveInstanceId(): InstanceId {
    return this.activeInstanceId;
  }

  public getLastKnownTerminalSize(): { cols: number; rows: number } {
    return { cols: this.lastKnownCols, rows: this.lastKnownRows };
  }

  public setLastKnownTerminalSize(cols: number, rows: number): void {
    this.lastKnownCols = cols;
    this.lastKnownRows = rows;
  }

  public isStartedFlag(): boolean {
    return this.isStarted;
  }

  public getApiClient(): OpenCodeApiClient | undefined {
    return this.apiClient;
  }

  public isHttpAvailable(): boolean {
    return this.httpAvailable;
  }

  public hasLiveTerminalProcess(): boolean {
    return (
      this.isStarted &&
      this.terminalManager.getTerminal(this.activeInstanceId) !== undefined
    );
  }

  public async switchToInstance(
    instanceId: InstanceId,
    options?: { forceRestart?: boolean },
  ): Promise<void> {
    const forceRestart = options?.forceRestart ?? false;
    if (instanceId === this.activeInstanceId && !forceRestart) {
      return;
    }

    this.disposeListeners();
    this.portManager.releaseTerminalPorts(this.activeInstanceId);
    this.portManager.releaseTerminalPorts(instanceId);
    this.resetState(false);
    this.activeInstanceId = instanceId;

    this.callbacks.postMessage({ type: "clearTerminal" });

    const existingTerminal =
      this.terminalManager.getByInstance(instanceId) ||
      this.terminalManager.getTerminal(instanceId);

    if (existingTerminal && !forceRestart) {
      this.isStarted = true;
      this.reconnectListeners();
      this.syncActiveInstance(instanceId);

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

    if (existingTerminal && forceRestart) {
      this.terminalManager.killByInstance(instanceId);
      this.terminalManager.killTerminal(instanceId);
    }

    await this.callbacks.requestStartOpenCode();
    this.syncActiveInstance(instanceId);
  }

  public async startOpenCode(): Promise<void> {
    if (this.isStarted || this.isStarting) {
      return;
    }

    this.isStarting = true;

    try {
      this.disposeListeners();

      const config = vscode.workspace.getConfiguration("opencodeTui");
      const enableHttpApi = config.get<boolean>("enableHttpApi", true);
      const httpTimeout = config.get<number>("httpTimeout", 5000);
      const defaultToolName = config.get<string>("defaultAiTool", "opencode");
      const tools = resolveAiToolConfigs(config.get("aiTools", []));

      let command: string;
      const defaultTool = tools.find((t) => t.name === defaultToolName);
      if (defaultTool) {
        command = getToolLaunchCommand(defaultTool);
      } else {
        const toolItems = tools.map((t) => ({
          label: t.label,
          description: `Launch ${t.label} in tmux`,
          tool: t,
        }));
        const picked = await vscode.window.showQuickPick(toolItems, {
          placeHolder: "Select AI tool to launch",
        });
        if (!picked) {
          this.isStarting = false;
          return;
        }
        command = getToolLaunchCommand(picked.tool);
        await config.update(
          "defaultAiTool",
          picked.tool.name,
          vscode.ConfigurationTarget.Global,
        );
      }
      const forceNativeShell = this.forceNativeShellNextStart;
      const selectedTmuxSessionId = this.selectedTmuxSessionId;
      let tmuxSessionId = forceNativeShell
        ? undefined
        : (selectedTmuxSessionId ??
          this.resolveTmuxSessionIdForInstance(this.activeInstanceId));

      let port: number | undefined;
      const { workspacePath, isWorkspaceScoped } =
        this.resolveStartupWorkspacePath();

      if (!forceNativeShell && !selectedTmuxSessionId && isWorkspaceScoped) {
        const ensuredSessionId =
          await this.ensureWorkspaceSession(workspacePath);
        if (ensuredSessionId) {
          tmuxSessionId = ensuredSessionId;
        }
      } else if (
        !forceNativeShell &&
        !selectedTmuxSessionId &&
        !tmuxSessionId
      ) {
        tmuxSessionId = await this.resolveFallbackTmuxSessionId();
      }

      if (tmuxSessionId && this.tmuxSessionManager) {
        try {
          await this.tmuxSessionManager.setMouseOn(tmuxSessionId);
        } catch {}
      }

      const terminalCommand = this.resolveTerminalStartupCommand(
        command,
        tmuxSessionId,
      );
      this.selectedTmuxSessionId = undefined;
      this.forceNativeShellNextStart = false;

      if (enableHttpApi) {
        try {
          port = this.portManager.assignPortToTerminal(this.activeInstanceId);
          this.logger.info(
            `[TerminalProvider] Assigned port ${port} to terminal ${this.activeInstanceId}`,
          );
        } catch (error) {
          this.logger.error(
            `[TerminalProvider] Failed to assign port: ${error instanceof Error ? error.message : String(error)}`,
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
            `[TerminalProvider] Failed to update instance store with terminal key: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.reconnectListeners();

      this.isStarted = true;

      this.notifyActiveSession(tmuxSessionId);

      if (enableHttpApi && port) {
        this.apiClient = new OpenCodeApiClient(port, 10, 200, httpTimeout);
        await this.pollForHttpReadiness();
      } else {
        this.logger.info(
          "[TerminalProvider] HTTP API disabled or unavailable, using message passing fallback",
        );
        this.httpAvailable = false;
      }
    } finally {
      this.isStarting = false;
    }
  }

  public restart(): void {
    this.disposeListeners();
    this.terminalManager.killTerminal(this.activeInstanceId);
    this.resetState();

    this.callbacks.postMessage({ type: "clearTerminal" });

    void this.callbacks.requestStartOpenCode();
  }

  public resetState(releasePorts: boolean = true): void {
    this.isStarted = false;
    this.isStarting = false;
    this.httpAvailable = false;
    this.apiClient = undefined;
    this.autoContextSent = false;
    if (releasePorts) {
      this.portManager.releaseTerminalPorts(this.activeInstanceId);
    }
  }

  public disposeListeners(): void {
    if (this.dataListener) {
      this.dataListener.dispose();
      this.dataListener = undefined;
    }
    if (this.exitListener) {
      this.exitListener.dispose();
      this.exitListener = undefined;
    }
  }

  public reconnectListeners(): void {
    this.disposeListeners();

    this.dataListener = this.terminalManager.onData((event) => {
      if (event.id === this.activeInstanceId) {
        this.callbacks.postMessage({
          type: "terminalOutput",
          data: event.data,
        });
      }
    });

    this.exitListener = this.terminalManager.onExit((id) => {
      if (id === this.activeInstanceId) {
        this.resetState();
        this.callbacks.postMessage({
          type: "terminalExited",
        });
      }
    });
  }

  public async pollForHttpReadiness(): Promise<void> {
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
          this.logger.info("[TerminalProvider] HTTP API is ready");
          await this.sendAutoContext();
          return;
        }
      } catch {
        this.logger.info(
          `[TerminalProvider] Health check attempt ${attempt}/${maxRetries} failed`,
        );
      }

      if (attempt < maxRetries) {
        await this.sleep(delayMs);
      }
    }

    this.logger.info(
      "[TerminalProvider] HTTP API not available after retries, using message passing fallback",
    );
    this.httpAvailable = false;
  }

  public sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public resolveStartupWorkspacePath(): StartupWorkspaceResolution {
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

  public resolveWorkspacePathFromActiveInstance(): string | undefined {
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

  public async ensureWorkspaceSession(
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
        `[TerminalProvider] tmux session ${result.action}: ${result.session.id}`,
      );
      return result.session.id;
    } catch (error) {
      if (error instanceof TmuxUnavailableError) {
        this.logger.info(
          "[TerminalProvider] tmux unavailable, continuing with default startup",
        );
        return undefined;
      }

      this.logger.warn(
        `[TerminalProvider] Failed to ensure tmux session: ${error instanceof Error ? error.message : String(error)}. Continuing with default startup.`,
      );
      return undefined;
    }
  }

  public resolveTerminalStartupCommand(
    defaultCommand: string,
    tmuxSessionId?: string,
  ): string {
    if (!tmuxSessionId) {
      return defaultCommand;
    }

    return `tmux attach-session -t ${tmuxSessionId} \\; set-option -u status off`;
  }

  public resolveTmuxSessionIdForInstance(
    instanceId: InstanceId,
  ): string | undefined {
    if (!this.instanceStore) {
      return undefined;
    }

    return this.instanceStore.get(instanceId)?.runtime.tmuxSessionId;
  }

  public async resolveFallbackTmuxSessionId(): Promise<string | undefined> {
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
        `[TerminalProvider] Failed to resolve fallback tmux session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  public resolveInstanceIdFromSessionId(sessionId: string): InstanceId {
    if (!this.instanceStore) {
      return this.activeInstanceId;
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

    return workspaceMapped?.config.id ?? this.activeInstanceId;
  }

  public async switchToTmuxSession(sessionId: string): Promise<void> {
    this.forceNativeShellNextStart = false;
    this.selectedTmuxSessionId = sessionId;
    await this.switchToInstance(
      this.resolveInstanceIdFromSessionId(sessionId),
      {
        forceRestart: true,
      },
    );
    this.notifyActiveSession(sessionId);
  }

  private async resolveLaunchChoice(
    configKey: "nativeShellDefault" | "tmuxSessionDefault",
  ): Promise<LaunchChoice | undefined> {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    const persisted = config.get<string>(configKey, "");
    if (persisted === "opencode" || persisted === "shell") {
      return persisted;
    }

    const items: vscode.QuickPickItem[] = [
      {
        label: "$(terminal) OpenCode",
        description: "Launch OpenCode in the terminal",
      },
      {
        label: "$(shell) Default Shell (zsh)",
        description: "Launch default shell without OpenCode",
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "What would you like to launch?",
      canPickMany: false,
    });

    if (!picked) {
      return undefined;
    }

    const choice: LaunchChoice = picked.label.includes("OpenCode")
      ? "opencode"
      : "shell";

    const remember = await vscode.window.showInformationMessage(
      "Remember this choice? You can change it later in settings.",
      { modal: false },
      "Yes, remember",
    );

    if (remember === "Yes, remember") {
      await config.update(configKey, choice, vscode.ConfigurationTarget.Global);
    }

    return choice;
  }

  public async switchToNativeShell(): Promise<void> {
    this.selectedTmuxSessionId = undefined;

    const launchChoice = await this.resolveLaunchChoice("nativeShellDefault");
    if (!launchChoice) {
      return;
    }

    if (launchChoice === "shell") {
      this.forceNativeShellNextStart = true;
    } else {
      this.forceNativeShellNextStart = false;
    }

    if (this.instanceStore) {
      const existing = this.instanceStore.get(this.activeInstanceId);
      if (existing?.runtime.tmuxSessionId) {
        this.instanceStore.upsert({
          ...existing,
          runtime: {
            ...existing.runtime,
            tmuxSessionId: undefined,
          },
        });
      }
    }

    await this.switchToInstance(this.activeInstanceId, { forceRestart: true });
    this.notifyActiveSession(undefined);
  }

  public async createTmuxSession(): Promise<string | undefined> {
    if (!this.tmuxSessionManager) {
      return undefined;
    }

    const launchChoice = await this.resolveLaunchChoice("tmuxSessionDefault");
    if (!launchChoice) {
      return undefined;
    }

    const { workspacePath } = this.resolveStartupWorkspacePath();

    try {
      const sessions = await this.tmuxSessionManager.discoverSessions();
      const existingIds = new Set(sessions.map((session) => session.id));
      const baseName = path.basename(workspacePath) || "opencode";

      let candidate = baseName;
      let suffix = 2;
      while (existingIds.has(candidate)) {
        candidate = `${baseName}-${suffix}`;
        suffix += 1;
      }

      await this.tmuxSessionManager.createSession(candidate, workspacePath);

      if (launchChoice === "opencode") {
        await this.switchToTmuxSession(candidate);
      }

      return candidate;
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to create tmux session: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.showErrorMessage("Failed to create tmux session");
      return undefined;
    }
  }

  public async killTmuxSession(sessionId: string): Promise<void> {
    if (!this.tmuxSessionManager) {
      return;
    }

    try {
      const activeTmuxSessionId = this.resolveTmuxSessionIdForInstance(
        this.activeInstanceId,
      );
      const shouldFallbackToNative =
        this.selectedTmuxSessionId === sessionId ||
        activeTmuxSessionId === sessionId;

      if (this.selectedTmuxSessionId === sessionId) {
        this.selectedTmuxSessionId = undefined;
      }

      await this.tmuxSessionManager.killSession(sessionId);

      if (this.instanceStore) {
        const records = this.instanceStore.getAll();
        for (const record of records) {
          if (record.runtime.tmuxSessionId === sessionId) {
            this.portManager.releaseTerminalPorts(record.config.id);
            this.instanceStore.upsert({
              ...record,
              runtime: {
                ...record.runtime,
                tmuxSessionId: undefined,
                port: undefined,
              },
            });
          }
        }
      }

      if (shouldFallbackToNative && this.isStarted) {
        await this.switchToNativeShell();
      }
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to kill tmux session: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.showErrorMessage("Failed to kill tmux session");
    }
  }

  public subscribeToActiveInstanceChanges(): void {
    if (!this.instanceStore) {
      return;
    }

    try {
      this.activeInstanceId = this.instanceStore.getActive().config.id;
    } catch {}

    this.activeInstanceSubscription = this.instanceStore.onDidSetActive(
      (id) => {
        this.callbacks.onActiveInstanceChanged(id);
      },
    );
  }

  private syncActiveInstance(instanceId: InstanceId): void {
    if (!this.instanceStore) {
      return;
    }
    try {
      const currentActive = this.instanceStore.getActive().config.id;
      if (currentActive !== instanceId) {
        this.instanceStore.setActive(instanceId);
      }
    } catch {}
  }

  private notifyActiveSession(sessionId: string | undefined): void {
    if (!sessionId) {
      this.callbacks.postMessage({ type: "activeSession" });
      return;
    }
    this.callbacks.postMessage({
      type: "activeSession",
      sessionName: sessionId,
      sessionId,
    });
  }

  public dispose(): void {
    this.disposeListeners();
    this.activeInstanceSubscription?.dispose();
    this.activeInstanceSubscription = undefined;
    if (this.isStarted) {
      this.terminalManager.killTerminal(this.activeInstanceId);
    }
  }

  private async sendAutoContext(): Promise<void> {
    if (this.autoContextSent) {
      return;
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const enableHttpApi = config.get<boolean>("enableHttpApi", true);
    const autoShareContext = config.get<boolean>("autoShareContext", true);

    if (!enableHttpApi) {
      this.logger.info(
        "[TerminalProvider] HTTP API disabled, skipping auto-context",
      );
      return;
    }

    if (!autoShareContext) {
      this.logger.info(
        "[TerminalProvider] Auto-context sharing disabled by user",
      );
      return;
    }

    if (!this.httpAvailable || !this.apiClient) {
      this.logger.info(
        "[TerminalProvider] HTTP not available, skipping auto-context",
      );
      return;
    }

    const context = this.contextSharingService.getCurrentContext();
    if (!context) {
      this.logger.info(
        "[TerminalProvider] No active editor, skipping auto-context",
      );
      return;
    }

    const fileRef = this.contextSharingService.formatContext(context);
    this.logger.info(`[TerminalProvider] Sending auto-context: ${fileRef}`);

    try {
      await this.apiClient.appendPrompt(fileRef);
      this.autoContextSent = true;
      this.logger.info(
        "[TerminalProvider] Auto-context sent successfully via HTTP",
      );
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to send auto-context: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
