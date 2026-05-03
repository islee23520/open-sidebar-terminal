import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { PortManager } from "../services/PortManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import {
  AiToolConfig,
  resolveAiToolConfigs,
  TerminalBackendType,
} from "../types";
import { AiToolFileReference } from "../services/aiTools/AiToolOperator";
import {
  TmuxSessionManager,
  TmuxUnavailableError,
} from "../services/TmuxSessionManager";
import { TerminalManager } from "../terminals/TerminalManager";
import { AiToolOperatorRegistry } from "../services/aiTools/AiToolOperatorRegistry";
import { ZellijSessionManager } from "../services/ZellijSessionManager";
import { TerminalBackendRegistry } from "../services/terminalBackends";

interface StartupWorkspaceResolution {
  workspacePath: string;
  isWorkspaceScoped: boolean;
}

interface SessionRuntimeCallbacks {
  postMessage: (message: unknown) => void;
  onActiveInstanceChanged: (instanceId: InstanceId) => void;
  requestStartOpenCode: () => Promise<void>;
  showAiToolSelector: (
    sessionId: string,
    sessionName: string,
    forceShow?: boolean,
  ) => void;
}

export class SessionRuntime {
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
  private selectedZellijSessionId?: string;
  private pendingBackendOverride?: TerminalBackendType;
  private activeBackend: TerminalBackendType = "native";
  private forceNativeShellNextStart = false;
  private pendingLaunchToolName?: string;
  private activeTool?: AiToolConfig;
  private clipboardPollInterval?: ReturnType<typeof setInterval>;
  private lastTmuxBuffer = "";
  private sigusr2Handler?: () => void;
  private knownPaneIds: Map<string, Set<string>> = new Map();
  private knownPaneCommands: Map<string, string> = new Map();
  private knownActiveWindowId?: string;
  private _lastCanKillPane?: boolean;
  private sigusr2FiredSinceLastCheck = false;
  private externalChangeListener?: vscode.Disposable;
  private paneMonitorInterval?: ReturnType<typeof setInterval>;

  public constructor(
    private readonly terminalManager: TerminalManager,
    _captureManager: OutputCaptureManager,
    _openCodeApiClient: OpenCodeApiClient | undefined,
    private readonly portManager: PortManager,
    private readonly tmuxSessionManager: TmuxSessionManager | undefined,
    private readonly zellijSessionManager: ZellijSessionManager | undefined,
    private readonly backendRegistry: TerminalBackendRegistry,
    private readonly instanceStore: InstanceStore | undefined,
    private readonly logger: OutputChannelService,
    private readonly contextSharingService: ContextSharingService,
    private readonly aiToolRegistry: AiToolOperatorRegistry,
    private readonly callbacks: SessionRuntimeCallbacks,
  ) {
    if (this.instanceStore) {
      this.subscribeToActiveInstanceChanges();
    } else {
      this.activeInstanceId = SessionRuntime.LEGACY_TERMINAL_ID;
    }
  }

  public getActiveInstanceId(): InstanceId {
    return this.activeInstanceId;
  }

  public getActiveTerminalId(): string {
    return this.resolveTerminalIdForInstance(this.activeInstanceId);
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

  public getActiveTool(): AiToolConfig | undefined {
    return this.activeTool;
  }

  public getSelectedTmuxSessionId(): string | undefined {
    return this.selectedTmuxSessionId;
  }

  public getActiveBackend(): TerminalBackendType {
    return this.activeBackend;
  }

  public getBackendAvailability() {
    return this.backendRegistry.getAvailability();
  }

  public async cycleTerminalBackend(): Promise<void> {
    await this.selectTerminalBackend(
      this.backendRegistry.nextAvailable(this.activeBackend),
    );
  }

  public async selectTerminalBackend(
    backend: TerminalBackendType,
  ): Promise<void> {
    const resolved = this.backendRegistry.resolveAvailable(backend);
    if (resolved === "native") {
      await this.switchToNativeShell();
      return;
    }
    if (resolved === "tmux") {
      const sessionId = await this.ensureTmuxBackendSession();
      if (sessionId) {
        await this.switchToTmuxSession(sessionId);
        return;
      }
      await this.switchToNativeShell();
      return;
    }
    const sessionId = await this.ensureZellijBackendSession();
    if (sessionId) {
      await this.switchToZellijSession(sessionId);
      return;
    }
    await this.switchToNativeShell();
  }

  public resolveToolByName(toolName: string): AiToolConfig | undefined {
    return this.resolveToolConfig(toolName);
  }

  public rememberSelectedTool(
    toolName: string | undefined,
    instanceId = this.activeInstanceId,
  ): void {
    this.persistSelectedTool(toolName, instanceId);
    if (instanceId === this.activeInstanceId) {
      this.activeTool = this.resolveToolConfig(toolName);
    }
  }

  public isHttpAvailable(): boolean {
    return this.httpAvailable;
  }

  public hasLiveTerminalProcess(): boolean {
    return (
      this.isStarted &&
      this.terminalManager.getTerminal(this.getActiveTerminalId()) !== undefined
    );
  }

  public async switchToInstance(
    instanceId: InstanceId,
    options?: { forceRestart?: boolean; preferredToolName?: string },
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
      this.activeTool = this.resolveStoredTool(instanceId);
      this.reconnectListeners();
      this.syncActiveInstance(instanceId);

      const config = vscode.workspace.getConfiguration("opencodeTui");
      const enableHttpApi = config.get<boolean>("enableHttpApi", true);
      const operator = this.activeTool
        ? this.aiToolRegistry.getForConfig(this.activeTool)
        : undefined;
      if (
        enableHttpApi &&
        existingTerminal.port &&
        this.activeTool &&
        operator?.supportsHttpApi(this.activeTool)
      ) {
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
          this.getActiveTerminalId(),
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

    this.pendingLaunchToolName =
      options?.preferredToolName ?? this.pendingLaunchToolName;
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

      const { workspacePath, isWorkspaceScoped } =
        this.resolveStartupWorkspacePath();

      const forceNativeShell = this.forceNativeShellNextStart;
      const requestedBackend = forceNativeShell
        ? "native"
        : this.pendingBackendOverride ??
          (this.selectedTmuxSessionId
            ? "tmux"
            : this.selectedZellijSessionId
              ? "zellij"
              : this.resolveConfiguredBackend(config));
      const backend = this.backendRegistry.resolveAvailable(requestedBackend);
      this.activeBackend = backend;

      let tmuxSessionId: string | undefined;
      let zellijSessionId: string | undefined;

      if (backend === "tmux") {
        const selectedTmuxSessionId = this.selectedTmuxSessionId;
        tmuxSessionId =
          selectedTmuxSessionId ??
          this.resolveTmuxSessionIdForInstance(this.activeInstanceId);

        if (!selectedTmuxSessionId && isWorkspaceScoped) {
          const ensuredSessionId =
            await this.ensureWorkspaceSession(workspacePath);
          if (ensuredSessionId) {
            tmuxSessionId = ensuredSessionId;
          }
        } else if (!selectedTmuxSessionId && !tmuxSessionId) {
          tmuxSessionId = await this.resolveFallbackTmuxSessionId();
        }

        if (!tmuxSessionId) {
          this.activeBackend = "native";
        }
      } else if (backend === "zellij") {
        zellijSessionId =
          this.selectedZellijSessionId ??
          this.resolveZellijSessionIdForInstance(this.activeInstanceId);

        if (!zellijSessionId && isWorkspaceScoped) {
          zellijSessionId = await this.ensureZellijWorkspaceSession(
            workspacePath,
          );
        }
        if (!zellijSessionId) {
          zellijSessionId = await this.resolveFallbackZellijSessionId();
        }
        if (!zellijSessionId) {
          this.activeBackend = "native";
        }
      }

      if (tmuxSessionId && this.tmuxSessionManager) {
        try {
          await this.tmuxSessionManager.setMouseOn(tmuxSessionId);
        } catch {}

        try {
          await this.tmuxSessionManager.registerSessionHooks(
            tmuxSessionId,
            process.pid,
          );
        } catch {}
        try {
          await this.startExternalChangeMonitoring(tmuxSessionId);
        } catch {}
      }

      let resolvedTool: AiToolConfig | undefined;
      let command: string | undefined;

      if (
        !forceNativeShell &&
        (this.activeBackend === "native" ||
          Boolean(tmuxSessionId) ||
          Boolean(zellijSessionId) ||
          Boolean(this.pendingLaunchToolName))
      ) {
        resolvedTool = await this.resolveToolForStartup(config);
        if (!resolvedTool) {
          this.isStarting = false;
          return;
        }

        const operator = this.aiToolRegistry.getForConfig(resolvedTool);
        command = operator.getLaunchCommand(resolvedTool);
      }

      this.activeTool = resolvedTool;
      const terminalCommand = this.resolveTerminalStartupCommand(
        command,
        tmuxSessionId,
        zellijSessionId,
      );

      let port: number | undefined;
      this.selectedTmuxSessionId = undefined;
      this.selectedZellijSessionId = undefined;
      this.pendingBackendOverride = undefined;
      this.forceNativeShellNextStart = false;
      this.pendingLaunchToolName = undefined;

      const activeOperator =
        this.activeTool && this.aiToolRegistry.getForConfig(this.activeTool);
      if (
        enableHttpApi &&
        command !== undefined &&
        this.activeTool &&
        activeOperator?.supportsHttpApi(this.activeTool)
      ) {
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
              config: {
                ...existing.config,
                selectedAiTool: this.activeTool?.name,
              },
              runtime: {
                ...existing.runtime,
                terminalKey: this.activeInstanceId,
                tmuxSessionId,
                zellijSessionId,
                terminalBackend: this.activeBackend,
                port: port ?? existing.runtime.port,
              },
            });
          } else {
            this.instanceStore.upsert({
              config: {
                id: this.activeInstanceId,
                selectedAiTool: this.activeTool?.name,
              },
              runtime: {
                terminalKey: this.activeInstanceId,
                tmuxSessionId,
                zellijSessionId,
                terminalBackend: this.activeBackend,
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

      this.notifyActiveSession(tmuxSessionId ?? zellijSessionId, this.activeBackend);

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
    this.terminalManager.killTerminal(this.getActiveTerminalId());
    this.resetState();

    this.callbacks.postMessage({ type: "clearTerminal" });

    void this.callbacks.requestStartOpenCode();
  }

  public resetState(releasePorts: boolean = true): void {
    this.isStarted = false;
    this.isStarting = false;
    this.httpAvailable = false;
    this.apiClient = undefined;
    this.activeTool = undefined;
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
        const exitedTmuxSessionId =
          this.selectedTmuxSessionId ??
          this.resolveTmuxSessionIdForInstance(this.activeInstanceId);

        if (exitedTmuxSessionId && this.isStarted) {
          void this.restoreAfterAttachedTmuxSessionExit(exitedTmuxSessionId);
          return;
        }

        this.resetState();
        this.callbacks.postMessage({
          type: "terminalExited",
        });
      }
    });
  }

  private async restoreAfterAttachedTmuxSessionExit(
    exitedSessionId: string,
  ): Promise<void> {
    const fallbackWorkspacePath = this.resolveWorkspacePathForTmuxFallback();

    if (this.selectedTmuxSessionId === exitedSessionId) {
      this.selectedTmuxSessionId = undefined;
    }

    if (this.instanceStore) {
      const records = this.instanceStore.getAll();
      for (const record of records) {
        if (record.runtime.tmuxSessionId === exitedSessionId) {
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

    try {
      const replacementSessionId = fallbackWorkspacePath
        ? await this.findReplacementTmuxSession(
            fallbackWorkspacePath,
            exitedSessionId,
          )
        : undefined;

      if (replacementSessionId) {
        await this.switchToTmuxSession(replacementSessionId);
        return;
      }

      await this.switchToNativeShell();
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to restore after tmux exit: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.resetState();
      this.callbacks.postMessage({
        type: "terminalExited",
      });
    }
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
    defaultCommand: string | undefined,
    tmuxSessionId?: string,
    zellijSessionId?: string,
  ): string | undefined {
    if (tmuxSessionId) {
      return `tmux attach-session -t ${tmuxSessionId} \\; set-option -u status off`;
    }
    if (zellijSessionId && this.zellijSessionManager) {
      return this.zellijSessionManager.getAttachCommand(zellijSessionId);
    }
    return defaultCommand;
  }

  public resolveConfiguredBackend(
    config: vscode.WorkspaceConfiguration,
  ): TerminalBackendType {
    const configured = config.get<TerminalBackendType>(
      "terminalBackend",
      "tmux",
    );
    if (
      configured === "native" ||
      configured === "tmux" ||
      configured === "zellij"
    ) {
      return configured;
    }
    return "tmux";
  }

  public resolveTmuxSessionIdForInstance(
    instanceId: InstanceId,
  ): string | undefined {
    if (!this.instanceStore) {
      return undefined;
    }

    return this.instanceStore.get(instanceId)?.runtime.tmuxSessionId;
  }

  public resolveZellijSessionIdForInstance(
    instanceId: InstanceId,
  ): string | undefined {
    if (!this.instanceStore) {
      return undefined;
    }

    return this.instanceStore.get(instanceId)?.runtime.zellijSessionId;
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

  public async resolveFallbackZellijSessionId(): Promise<string | undefined> {
    if (!this.zellijSessionManager) {
      return undefined;
    }

    try {
      const sessions = await this.zellijSessionManager.discoverSessions();
      if (sessions.length === 0) {
        return undefined;
      }
      const preferredSession =
        sessions.find((session) => session.isActive) ?? sessions[0];
      return preferredSession?.id;
    } catch (error) {
      this.logger.warn(
        `[TerminalProvider] Failed to resolve fallback zellij session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  public async ensureZellijWorkspaceSession(
    workspacePath: string,
  ): Promise<string | undefined> {
    if (!this.zellijSessionManager) {
      return undefined;
    }

    const sessionName = path.basename(workspacePath) || this.activeInstanceId;
    try {
      const result = await this.zellijSessionManager.ensureSession(
        sessionName,
        workspacePath,
      );
      this.logger.info(
        `[TerminalProvider] zellij session ${result.action}: ${result.session.id}`,
      );
      return result.session.id;
    } catch (error) {
      this.logger.warn(
        `[TerminalProvider] Failed to ensure zellij session: ${error instanceof Error ? error.message : String(error)}. Continuing with native startup.`,
      );
      return undefined;
    }
  }

  private async ensureTmuxBackendSession(): Promise<string | undefined> {
    const { workspacePath } = this.resolveStartupWorkspacePath();
    return await this.ensureWorkspaceSession(workspacePath);
  }

  private async ensureZellijBackendSession(): Promise<string | undefined> {
    const { workspacePath } = this.resolveStartupWorkspacePath();
    return await this.ensureZellijWorkspaceSession(workspacePath);
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

    const zellijMapped = records.find(
      (record) => record.runtime.zellijSessionId === sessionId,
    );
    if (zellijMapped) {
      return zellijMapped.config.id;
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
    await this.switchToTmuxSessionWithTool(sessionId);
  }

  public async switchToTmuxSessionWithTool(
    sessionId: string,
    preferredToolName?: string,
  ): Promise<void> {
    if (this.tmuxSessionManager) {
      try {
        await this.tmuxSessionManager.registerSessionHooks(
          sessionId,
          process.pid,
        );
      } catch {}
      try {
        await this.startExternalChangeMonitoring(sessionId);
      } catch {}
    }

    this.forceNativeShellNextStart = false;
    this.pendingBackendOverride = "tmux";
    this.activeBackend = "tmux";
    this.selectedTmuxSessionId = sessionId;
    this.selectedZellijSessionId = undefined;
    this.pendingLaunchToolName = preferredToolName;
    if (preferredToolName) {
      const instanceId = this.resolveInstanceIdFromSessionId(sessionId);
      this.persistSelectedTool(preferredToolName, instanceId);
    }
    await this.switchToInstance(
      this.resolveInstanceIdFromSessionId(sessionId),
      {
        forceRestart: true,
        preferredToolName,
      },
    );
    this.notifyActiveSession(sessionId);
  }

  public async switchToZellijSession(sessionId: string): Promise<void> {
    this.forceNativeShellNextStart = false;
    this.pendingBackendOverride = "zellij";
    this.selectedTmuxSessionId = undefined;
    this.selectedZellijSessionId = sessionId;
    this.activeBackend = "zellij";
    await this.switchToInstance(this.resolveInstanceIdFromSessionId(sessionId), {
      forceRestart: true,
    });
    this.notifyActiveSession(sessionId, "zellij");
  }

  public async switchToNativeShell(): Promise<void> {
    this.selectedTmuxSessionId = undefined;
    this.selectedZellijSessionId = undefined;
    this.pendingBackendOverride = "native";
    this.activeBackend = "native";
    this.forceNativeShellNextStart = true;
    this.pendingLaunchToolName = undefined;

    if (this.instanceStore) {
      const existing = this.instanceStore.get(this.activeInstanceId);
      if (existing?.runtime.tmuxSessionId || existing?.runtime.zellijSessionId) {
        this.instanceStore.upsert({
          ...existing,
          runtime: {
            ...existing.runtime,
            tmuxSessionId: undefined,
            zellijSessionId: undefined,
            terminalBackend: "native",
          },
        });
      }
    }

    await this.switchToInstance(this.activeInstanceId, { forceRestart: true });
    this.notifyActiveSession(undefined, "native");
  }

  public async createTmuxSession(): Promise<string | undefined> {
    if (!this.tmuxSessionManager) {
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
      await this.switchToTmuxSessionWithTool(candidate);

      return candidate;
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to create tmux session: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.showErrorMessage("Failed to create tmux session");
      return undefined;
    }
  }

  public async zoomTmuxPane(): Promise<void> {
    if (!this.tmuxSessionManager) {
      return;
    }
    const workspacePath = this.resolveWorkspacePathForTmuxFallback();
    const sessionId = workspacePath
      ? await this.ensureWorkspaceSession(workspacePath)
      : undefined;
    if (!sessionId) {
      this.logger.warn(
        `[TerminalProvider] Cannot zoom tmux pane: no workspace session available (instance=${this.activeInstanceId})`,
      );
      return;
    }
    try {
      const panes = await this.tmuxSessionManager.listPanes(sessionId);
      const activePane = panes.find((p) => p.isActive) ?? panes[0];
      if (activePane) {
        await this.tmuxSessionManager.zoomPane(activePane.paneId);
      }
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to zoom tmux pane: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      const fallbackWorkspacePath = shouldFallbackToNative
        ? this.resolveWorkspacePathForTmuxFallback()
        : undefined;

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
        const replacementSessionId = fallbackWorkspacePath
          ? await this.findReplacementTmuxSession(
              fallbackWorkspacePath,
              sessionId,
            )
          : undefined;
        if (replacementSessionId) {
          await this.switchToTmuxSession(replacementSessionId);
          return;
        }

        await this.switchToNativeShell();
      }
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to kill tmux session: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.showErrorMessage("Failed to kill tmux session");
    }
  }

  public async routeDroppedTextToTmuxPane(
    text: string,
    dropCell: { col: number; row: number },
  ): Promise<boolean> {
    if (!this.tmuxSessionManager) {
      return false;
    }
    const workspacePath = this.resolveWorkspacePathForTmuxFallback();
    const sessionId = workspacePath
      ? await this.ensureWorkspaceSession(workspacePath)
      : undefined;
    if (!sessionId) {
      return false;
    }
    try {
      const panes =
        await this.tmuxSessionManager.listVisiblePaneGeometry(sessionId);
      const target = panes.find((p) => {
        const right = p.paneLeft + p.paneWidth - 1;
        const bottom = p.paneTop + p.paneHeight - 1;
        return (
          dropCell.col >= p.paneLeft &&
          dropCell.col <= right &&
          dropCell.row >= p.paneTop &&
          dropCell.row <= bottom
        );
      });
      if (!target) {
        return false;
      }
      await this.tmuxSessionManager.selectPane(target.paneId);
      await this.tmuxSessionManager.sendTextToPane(target.paneId, text, {
        submit: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  public formatDroppedFiles(
    paths: string[],
    options: { useAtSyntax: boolean },
  ): string {
    const operator = this.activeTool
      ? this.aiToolRegistry.getForConfig(this.activeTool)
      : this.aiToolRegistry.getByToolName("opencode");
    if (!operator) {
      return paths.join(" ");
    }

    return operator.formatDroppedFiles(paths, options);
  }

  public formatFileReference(reference: AiToolFileReference): string {
    const operator = this.activeTool
      ? this.aiToolRegistry.getForConfig(this.activeTool)
      : this.aiToolRegistry.getByToolName("opencode");
    if (!operator) {
      return reference.path;
    }

    return operator.formatFileReference(reference);
  }

  public formatPastedImage(tempPath: string): string | undefined {
    const operator = this.activeTool
      ? this.aiToolRegistry.getForConfig(this.activeTool)
      : this.aiToolRegistry.getByToolName("opencode");
    return operator?.formatPastedImage(tempPath);
  }

  private resolveWorkspacePathForTmuxFallback(): string | undefined {
    const instanceWorkspacePath = this.resolveWorkspacePathFromActiveInstance();
    if (instanceWorkspacePath) {
      return instanceWorkspacePath;
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async findReplacementTmuxSession(
    workspacePath: string,
    killedSessionId: string,
  ): Promise<string | undefined> {
    if (!this.tmuxSessionManager) {
      return undefined;
    }

    try {
      const replacement =
        await this.tmuxSessionManager.findSessionForWorkspace(workspacePath);
      if (!replacement || replacement.id === killedSessionId) {
        return undefined;
      }

      return replacement.id;
    } catch (error) {
      this.logger.warn(
        `[TerminalProvider] Failed to resolve replacement tmux session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
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

  private notifyActiveSession(
    sessionId: string | undefined,
    backend: TerminalBackendType = this.activeBackend,
  ): void {
    void vscode.commands.executeCommand(
      "setContext",
      "opencodeTui.tmuxAttached",
      backend === "tmux" && Boolean(sessionId),
    );

    if (!sessionId) {
      this.stopClipboardSync();
      this.callbacks.postMessage({ type: "activeSession", backend: "native" });
      return;
    }
    if (backend === "tmux") {
      this.startClipboardSync();
    } else {
      this.stopClipboardSync();
    }
    this.callbacks.postMessage({
      type: "activeSession",
      sessionName: sessionId,
      sessionId,
      backend,
    });
  }

  private startClipboardSync(): void {
    this.stopClipboardSync();
    if (!this.tmuxSessionManager) {
      return;
    }
    this.clipboardPollInterval = setInterval(async () => {
      try {
        const buf = await this.tmuxSessionManager!.showBuffer();
        if (buf && buf !== this.lastTmuxBuffer) {
          this.lastTmuxBuffer = buf;
          await vscode.env.clipboard.writeText(buf);
        }
      } catch {}
    }, 500);
  }

  private async startExternalChangeMonitoring(
    sessionId: string,
  ): Promise<void> {
    if (!this.tmuxSessionManager) {
      return;
    }

    try {
      const panes = await this.tmuxSessionManager.listPanes(sessionId, {
        activeWindowOnly: true,
      });
      this.knownPaneIds.set(sessionId, new Set(panes.map((p) => p.paneId)));
      const activePane = panes.find((p) => p.isActive);
      if (activePane?.paneId) {
        this.knownPaneCommands.set(
          `${sessionId}:${activePane.paneId}`,
          activePane.currentCommand ?? "",
        );
      }
    } catch {}

    if (!this.sigusr2Handler) {
      this.sigusr2Handler = () => {
        this.sigusr2FiredSinceLastCheck = true;
        void this.checkPaneChanges();
      };
      process.on("SIGUSR2", this.sigusr2Handler);
    }

    if (
      !this.externalChangeListener &&
      this.tmuxSessionManager.onExternalPaneChange
    ) {
      this.externalChangeListener =
        this.tmuxSessionManager.onExternalPaneChange(() => {
          this.sigusr2FiredSinceLastCheck = true;
        });
    }

    if (!this.paneMonitorInterval) {
      this.paneMonitorInterval = setInterval(() => {
        void this.checkPaneChanges();
      }, 1500);
    }
  }

  private stopExternalChangeMonitoring(): void {
    if (this.sigusr2Handler) {
      process.off("SIGUSR2", this.sigusr2Handler);
      this.sigusr2Handler = undefined;
    }

    this.externalChangeListener?.dispose();
    this.externalChangeListener = undefined;
    if (this.paneMonitorInterval) {
      clearInterval(this.paneMonitorInterval);
      this.paneMonitorInterval = undefined;
    }
    this.knownPaneIds.clear();
  }

  private async checkPaneChanges(): Promise<void> {
    if (!this.tmuxSessionManager) {
      return;
    }

    let activeSessionId =
      this.selectedTmuxSessionId ??
      this.resolveTmuxSessionIdForInstance(this.activeInstanceId);

    if (!activeSessionId) {
      try {
        const sessions = await this.tmuxSessionManager.discoverSessions();
        if (sessions.length > 0) {
          activeSessionId = sessions[0].id;
        }
      } catch {}
    }

    if (!activeSessionId) {
      return;
    }

    try {
      const panes = await this.tmuxSessionManager.listPanes(activeSessionId, {
        activeWindowOnly: true,
      });
      const currentPaneIds = new Set(panes.map((p) => p.paneId));

      if (this.sigusr2FiredSinceLastCheck) {
        this.sigusr2FiredSinceLastCheck = false;
      }

      this.knownPaneIds.set(activeSessionId, currentPaneIds);
      for (const pane of panes) {
        const key = `${activeSessionId}:${pane.paneId}`;
        this.knownPaneCommands.set(key, pane.currentCommand ?? "");
      }

      const windows =
        await this.tmuxSessionManager.listWindows(activeSessionId);
      const activeWindow = windows.find((w) => w.isActive);
      const windowChanged =
        activeWindow && activeWindow.windowId !== this.knownActiveWindowId;

      const canKillPane = panes.length > 1 || windows.length > 1;

      if (windowChanged || canKillPane !== this._lastCanKillPane) {
        if (windowChanged) {
          this.knownActiveWindowId = activeWindow.windowId;
        }
        this._lastCanKillPane = canKillPane;
        this.callbacks.postMessage({
          type: "activeSession",
          sessionName: activeSessionId,
          sessionId: activeSessionId,
          windowIndex: activeWindow?.index,
          windowName: activeWindow?.name,
          canKillPane,
        });
      }
    } catch {}
  }

  private stopClipboardSync(): void {
    if (this.clipboardPollInterval !== undefined) {
      clearInterval(this.clipboardPollInterval);
      this.clipboardPollInterval = undefined;
    }
  }

  public dispose(): void {
    this.stopExternalChangeMonitoring();
    this.stopClipboardSync();
    this.disposeListeners();
    this.activeInstanceSubscription?.dispose();
    this.activeInstanceSubscription = undefined;
    if (this.isStarted) {
      this.terminalManager.killTerminal(this.getActiveTerminalId());
    }
  }

  private resolveTerminalIdForInstance(instanceId: InstanceId): string {
    if (!this.instanceStore) {
      return instanceId;
    }

    try {
      return (
        this.instanceStore.get(instanceId)?.runtime.terminalKey ?? instanceId
      );
    } catch {
      return instanceId;
    }
  }

  private async sendAutoContext(): Promise<void> {
    if (this.autoContextSent) {
      return;
    }

    const config = vscode.workspace.getConfiguration("opencodeTui");
    const enableHttpApi = config.get<boolean>("enableHttpApi", true);
    const autoShareContext = config.get<boolean>("autoShareContext", true);
    const operator = this.activeTool
      ? this.aiToolRegistry.getForConfig(this.activeTool)
      : undefined;

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

    if (!this.activeTool || !operator?.supportsAutoContext(this.activeTool)) {
      this.logger.info(
        "[TerminalProvider] Active tool does not support auto-context",
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

    const fileRef = this.formatFileReference({
      path: context.filePath,
      selectionStart: context.selectionStart,
      selectionEnd: context.selectionEnd,
    });
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

  private getConfiguredTools(
    config = vscode.workspace.getConfiguration("opencodeTui"),
  ): AiToolConfig[] {
    return resolveAiToolConfigs(config.get("aiTools", []));
  }

  private resolveStoredTool(
    instanceId = this.activeInstanceId,
  ): AiToolConfig | undefined {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    const storedToolName =
      this.instanceStore?.get(instanceId)?.config.selectedAiTool;
    return this.resolveToolConfig(
      storedToolName ?? config.get<string>("defaultAiTool", ""),
      config,
    );
  }

  private resolveToolConfig(
    toolName: string | undefined,
    config = vscode.workspace.getConfiguration("opencodeTui"),
  ): AiToolConfig | undefined {
    if (!toolName) {
      return undefined;
    }

    return this.getConfiguredTools(config).find((tool) =>
      this.aiToolRegistry.matchesName(tool, toolName),
    );
  }

  private persistSelectedTool(
    toolName: string | undefined,
    instanceId = this.activeInstanceId,
  ): void {
    if (!this.instanceStore) {
      return;
    }

    const record = this.instanceStore.get(instanceId);
    if (!record) {
      return;
    }

    this.instanceStore.upsert({
      ...record,
      config: {
        ...record.config,
        selectedAiTool: toolName,
      },
    });
  }

  private async resolveToolForStartup(
    config: vscode.WorkspaceConfiguration,
  ): Promise<AiToolConfig | undefined> {
    const preferredToolName =
      this.pendingLaunchToolName ??
      this.instanceStore?.get(this.activeInstanceId)?.config.selectedAiTool ??
      config.get<string>("defaultAiTool", "");

    let tool = this.resolveToolConfig(preferredToolName, config);
    if (!tool) {
      const toolItems = this.getConfiguredTools(config).map((candidate) => ({
        label: candidate.label,
        description: `Launch ${candidate.label} in the terminal`,
        tool: candidate,
      }));
      const picked = await vscode.window.showQuickPick(toolItems, {
        placeHolder: "Select AI tool to launch",
      });
      if (!picked) {
        return undefined;
      }
      tool = picked.tool;
      await config.update(
        "defaultAiTool",
        picked.tool.name,
        vscode.ConfigurationTarget.Global,
      );
    }

    this.persistSelectedTool(tool.name);
    return tool;
  }
}
