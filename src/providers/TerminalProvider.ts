import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes, randomUUID } from "crypto";
import * as vscode from "vscode";
import type {
  HerdrAttachPresenter,
  HerdrAttachTarget,
  SourceState,
} from "../herdr/HerdrAttachController";
import { HerdrAttachController, herdrSessionId } from "../herdr/HerdrAttachController";
import type { CursorStyle, HostMessage, TerminalConfig, WebviewMessage } from "../types";
import { TerminalManager } from "../terminals/TerminalManager";
import type { TerminalTransport } from "../terminals/TerminalTransport";
import { renderTerminalHtml } from "../webview/terminal/html";

const TERMINAL_ID = "sidebar-shell";
const DAG_TERMINAL_ID = "sidebar-dag";
const EDITOR_VIEW_TYPE = "ulw.terminalEditor";
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export type TerminalLocation = "sidebar" | "editor";

type HerdrEditorSession = {
  readonly panel: vscode.WebviewPanel;
  readonly controller: HerdrAttachController;
  readonly target: HerdrAttachTarget;
};

export class TerminalProvider
  implements vscode.WebviewViewProvider, vscode.Disposable, HerdrAttachPresenter
{
  public static readonly viewType = "ulw";

  private view: vscode.WebviewView | undefined;
  private editorPanel: vscode.WebviewPanel | undefined;
  private activeLocation: TerminalLocation = "sidebar";
  private disposing = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly herdrSessions = new Map<string, HerdrEditorSession>();
  private activeTerminalId = TERMINAL_ID;
  private dagDiscovery: (() => Promise<HerdrAttachTarget | undefined>) | undefined;
  private dagFactory: ((target: HerdrAttachTarget, cols: number, rows: number) => TerminalTransport) | undefined;
  private dagTarget: string | undefined;
  private dagController: HerdrAttachController | undefined;
  private dagClosedTarget: string | undefined;
  private dagGeneration = 0;
  private dagRefresh: Promise<void> | undefined;
  private dagDimensions = { cols: 80, rows: 24 };
  private dagReady = false;
  private dagMessage = "Select a Herdr agent to view its existing DAG pane.";

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly terminalManager: TerminalManager,
    private readonly attachController?: HerdrAttachController,
  ) {
    this.disposables.push(
      terminalManager.onData(({ id, data, replay }) => {
        if (id === DAG_TERMINAL_ID) {
          if (replay === "replace") this.postToSurface("sidebar", { type: "reset" });
          this.postToSurface("sidebar", { type: "output", data });
          this.postToSurface("sidebar", { type: "sourceState", source: "herdr", phase: "attached", label: "DAG" });
          return;
        }
        if (id === TERMINAL_ID) {
          if (replay === "replace") {
            this.postMessage({ type: "reset" });
          }
          this.postMessage({ type: "output", data });
          return;
        }
        const session = this.herdrSessions.get(id);
        if (!session) {
          return;
        }
        if (replay === "replace") {
          void session.panel.webview.postMessage({ type: "reset" });
        }
        void session.panel.webview.postMessage({ type: "output", data });
      }),
      terminalManager.onExit(({ id, code, signal }) => {
        if (id === DAG_TERMINAL_ID) {
          this.dagClosedTarget = this.dagTarget;
          this.dagTarget = undefined;
          this.showDagMessage("DAG pane closed or control unavailable. Select another agent or refresh to retry.");
          return;
        }
        if (id === TERMINAL_ID) {
          if (
            this.terminalManager.activeSource(TERMINAL_ID) === "herdr-control" ||
            this.attachController?.sourceState.phase === "attached"
          ) {
            return;
          }
          this.postMessage({ type: "exit", code, signal });
          return;
        }
        const session = this.herdrSessions.get(id);
        if (!session) {
          return;
        }
        void session.panel.webview.postMessage({ type: "exit", code, signal });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("ulw")) {
          this.postMessage({ type: "config", ...this.readConfig() });
        }
        if (event.affectsConfiguration("ulw.sidebar.enabled")) {
          this.applySidebarVisibility();
        }
        if (event.affectsConfiguration("ulw.herdr") || event.affectsConfiguration("ulw.sidebar.enabled")) {
          this.resetDag();
          if (!this.herdrEnabled()) {
            for (const session of [...this.herdrSessions.values()]) session.panel.dispose();
            this.openAtConfiguredLocation();
            if (this.view) this.view.title = "Terminal";
            if (this.view) this.view.webview.html = this.renderHtml(this.view.webview);
          }
        }
      }),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.dagReady = false;
    this.view = webviewView;
    this.configureWebview(webviewView.webview);
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
        if (this.view !== webviewView) return;
        this.handleMessage(message, "sidebar");
      }),
      webviewView.onDidChangeVisibility(() => {
        if (this.view !== webviewView || !this.herdrEnabled()) return;
        if (webviewView.visible) {
          void this.refreshDag();
        } else {
          const closedTarget = this.dagClosedTarget;
          this.resetDag();
          this.dagClosedTarget = closedTarget;
          this.dagReady = false;
          webviewView.webview.html = this.renderHtml(webviewView.webview);
        }
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.resetDag();
          this.dagReady = false;
          this.view = undefined;
        }
      }),
    );
    webviewView.webview.html = this.renderHtml(webviewView.webview);
  }

  public openAtConfiguredLocation(): void {
    if (this.readDefaultLocation() === "editor" || !this.sidebarEnabled()) {
      this.openEditorPanel();
    }
  }

  public toggleEditorLocation(): void {
    if (this.editorPanel) {
      if (!this.sidebarEnabled()) {
        return;
      }
      this.closeEditorPanel();
      return;
    }
    this.openEditorPanel();
  }

  public isEditorLocation(): boolean {
    return this.activeLocation === "editor";
  }

  public getDefaultLocation(): TerminalLocation {
    return this.readDefaultLocation();
  }

  public write(data: string): void {
    this.terminalManager.write(this.activeTerminalId, data);
  }

  public configureDag(
    discover: () => Promise<HerdrAttachTarget | undefined>,
    factory: (target: HerdrAttachTarget, cols: number, rows: number) => TerminalTransport,
  ): void {
    this.resetDag();
    this.dagDiscovery = discover;
    this.dagFactory = factory;
  }

  public resetDag(): void {
    this.dagGeneration += 1;
    this.dagRefresh = undefined;
    this.dagController?.dispose();
    this.dagController = undefined;
    this.terminalManager.detach(DAG_TERMINAL_ID);
    this.dagTarget = undefined;
    this.dagClosedTarget = undefined;
    if (this.herdrEnabled()) this.showDagMessage("Select a Herdr agent to view its existing DAG pane.");
  }

  public refreshDag(): Promise<void> {
    if (this.dagRefresh) return this.dagRefresh;
    if (!this.herdrEnabled() || !this.sidebarEnabled() || !this.view?.visible || !this.dagReady || !this.dagDiscovery || !this.dagFactory) return Promise.resolve();
    const generation = this.dagGeneration;
    this.dagRefresh = this.dagDiscovery().then((target) => {
      if (generation !== this.dagGeneration || !this.herdrEnabled() || !this.sidebarEnabled() || !this.view?.visible) return;
      if (!target) {
        this.dagController?.dispose();
        this.dagController = undefined;
        this.terminalManager.detach(DAG_TERMINAL_ID);
        this.dagTarget = undefined;
        this.showDagMessage("No available DAG pane for this agent. Open the DAG in OMO first. Remote forwarding cannot read plugin metadata.");
        return;
      }
      if (target.terminalId === this.dagTarget || target.terminalId === this.dagClosedTarget) return;
      this.dagController?.dispose();
      this.dagController = undefined;
      this.terminalManager.detach(DAG_TERMINAL_ID);
      this.dagTarget = target.terminalId;
      const factory = this.dagFactory;
      if (factory) {
        const controller = new HerdrAttachController({
          manager: this.terminalManager,
          terminalId: DAG_TERMINAL_ID,
          transportFactory: (candidate, dimensions) => factory(candidate, dimensions.cols, dimensions.rows),
          presenter: {
            postReset: () => this.postToSurface("sidebar", { type: "reset" }),
            postOutput: (data) => this.postToSurface("sidebar", { type: "output", data }),
            postSourceState: (state) => {
              if (state.phase === "error") {
                this.dagClosedTarget = target.terminalId;
                this.dagTarget = undefined;
                this.showDagMessage(state.message ?? "DAG control unavailable. Refresh to retry.");
              } else if (state.source === "herdr") {
                this.postToSurface("sidebar", { type: "sourceState", ...state, label: "DAG" });
              }
            },
          },
        });
        this.dagController = controller;
        void controller.attach(target, this.dagDimensions);
      }
    }).catch((error: unknown) => {
      if (generation !== this.dagGeneration) return;
      this.dagController?.dispose();
      this.dagController = undefined;
      this.terminalManager.detach(DAG_TERMINAL_ID);
      this.dagTarget = undefined;
      this.showDagMessage(`DAG unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (generation === this.dagGeneration) this.dagRefresh = undefined;
    });
    return this.dagRefresh;
  }

  private showDagMessage(message: string): void {
    this.dagMessage = message;
    if (this.view) this.view.title = "DAG";
    this.postToSurface("sidebar", { type: "reset" });
    this.postToSurface("sidebar", { type: "output", data: message.replace(/[\x00-\x1f\x7f]/g, " ") + "\r\n" });
    this.postToSurface("sidebar", { type: "sourceState", source: "herdr", phase: "error", message });
  }

  private herdrEnabled(): boolean {
    return vscode.workspace.getConfiguration("ulw").get<boolean>("herdr.enabled", false);
  }

  public async openHerdrSession(
    target: HerdrAttachTarget,
    attach: (target: HerdrAttachTarget) => Promise<void>,
    createController: (sessionId: string, presenter: HerdrAttachPresenter) => HerdrAttachController,
  ): Promise<void> {
    const sessionId = herdrSessionId(target.terminalId);
    const existing = this.herdrSessions.get(sessionId);
    if (existing) {
      this.focusHerdrSession(sessionId);
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (existing.controller.sourceState.phase === "shell") {
        await attach(target);
        return;
      }
      this.postSourceStateToPanel(existing.panel, existing.controller.sourceState);
      return;
    }

    const title = target.label?.trim() || target.terminalId;
    const panel = vscode.window.createWebviewPanel(
      EDITOR_VIEW_TYPE,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );
    this.configureWebview(panel.webview);
    const presenter: HerdrAttachPresenter = {
      postReset: () => {
        void panel.webview.postMessage({ type: "reset" });
      },
      postOutput: (data) => {
        void panel.webview.postMessage({ type: "output", data });
      },
      postSourceState: (state) => {
        this.postSourceStateToPanel(panel, state);
      },
    };
    const controller = createController(sessionId, presenter);
    const session: HerdrEditorSession = { panel, controller, target };
    this.herdrSessions.set(sessionId, session);
    this.focusHerdrSession(sessionId);
    const messageSubscription = panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        this.handleHerdrSessionMessage(sessionId, message);
      },
    );
    const viewStateSubscription = panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (webviewPanel.active) {
          this.focusHerdrSession(sessionId);
        }
      },
    );
    const disposeSubscription = panel.onDidDispose(() => {
      messageSubscription.dispose();
      viewStateSubscription.dispose();
      disposeSubscription.dispose();
      const current = this.herdrSessions.get(sessionId);
      if (current?.panel !== panel) {
        return;
      }
      this.herdrSessions.delete(sessionId);
      current.controller.dispose();
      if (this.activeTerminalId === sessionId) {
        const remaining = [...this.herdrSessions.keys()];
        this.activeTerminalId =
          remaining.length > 0 ? remaining[remaining.length - 1] : TERMINAL_ID;
        this.resetDag();
        if (!this.disposing) void this.refreshDag();
      }
    });
    panel.webview.html = this.renderHtml(panel.webview);
    await attach(target);
  }

  public herdrSessionCount(): number {
    return this.herdrSessions.size;
  }

  public activeSessionId(): string {
    return this.activeTerminalId;
  }

  private focusHerdrSession(sessionId: string): void {
    const session = this.herdrSessions.get(sessionId);
    if (!session) {
      return;
    }
    this.herdrSessions.delete(sessionId);
    this.herdrSessions.set(sessionId, session);
    const changed = this.activeTerminalId !== sessionId;
    this.activeTerminalId = sessionId;
    if (changed) {
      this.resetDag();
      void this.refreshDag();
    }
  }

  public postReset(): void {
    this.postToSurface(this.activeLocation, { type: "reset" });
  }

  public postOutput(data: string): void {
    this.postMessage({ type: "output", data });
  }

  public postSourceState(state: SourceState): void {
    this.postSourceStateToSurface(this.activeLocation, state);
  }

  public isRunning(): boolean {
    return this.terminalManager.hasTerminal(TERMINAL_ID);
  }

  public terminalCount(): number {
    return this.terminalManager.terminalCount();
  }

  public dispose(): void {
    this.disposing = true;
    this.resetDag();
    for (const [sessionId, session] of this.herdrSessions) {
      session.controller.dispose();
      session.panel.dispose();
      this.herdrSessions.delete(sessionId);
    }
    this.terminalManager.kill(TERMINAL_ID);
    const panel = this.editorPanel;
    this.editorPanel = undefined;
    panel?.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.view = undefined;
    this.activeLocation = "sidebar";
    this.disposing = false;
  }

  private openEditorPanel(): void {
    if (this.editorPanel) {
      this.activeLocation = "editor";
      this.editorPanel.reveal(vscode.ViewColumn.Beside);
      this.postMessage({ type: "focus" });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      EDITOR_VIEW_TYPE,
      "ULW Terminal",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );
    this.editorPanel = panel;
    this.activeLocation = "editor";
    this.configureWebview(panel.webview);
    const messageSubscription = panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        this.handleMessage(message, "editor");
      },
    );
    const disposeSubscription = panel.onDidDispose(() => {
      messageSubscription.dispose();
      disposeSubscription.dispose();
      if (this.editorPanel === panel && !this.disposing) {
        this.editorPanel = undefined;
        if (!this.sidebarEnabled()) {
          this.activeLocation = "editor";
          void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
          return;
        }
        this.activeLocation = "sidebar";
        this.postMessage({ type: "focus" });
        void vscode.commands.executeCommand("workbench.view.extension.ulwContainer");
      }
    });
    panel.webview.html = this.renderHtml(panel.webview);
    void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  }

  private closeEditorPanel(): void {
    const panel = this.editorPanel;
    if (!panel) {
      return;
    }
    this.editorPanel = undefined;
    if (!this.sidebarEnabled()) {
      this.activeLocation = "editor";
      panel.dispose();
      void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      return;
    }
    this.activeLocation = "sidebar";
    panel.dispose();
    if (!this.disposing) {
      this.postMessage({ type: "focus" });
      void vscode.commands.executeCommand("workbench.view.extension.ulwContainer");
    }
  }

  private handleMessage(message: WebviewMessage, source: TerminalLocation): void {
    if (source === "sidebar" && this.view) {
      if (message.type === "ready") this.dagReady = true;
      if (message.type === "ready" || message.type === "resize") {
        this.dagDimensions = { cols: message.cols, rows: message.rows };
      }
    }
    if (source === "sidebar" && this.herdrEnabled()) {
      if (!this.sidebarEnabled() || !this.view?.visible) return;
      if (message.type === "ready") {
        this.postToSurface("sidebar", { type: "config", ...this.readConfig() });
        const replay = this.terminalManager.replay(DAG_TERMINAL_ID);
        if (replay) {
          this.postToSurface("sidebar", { type: "reset" });
          this.postToSurface("sidebar", { type: "output", data: replay });
          this.postToSurface("sidebar", { type: "sourceState", source: "herdr", phase: "attached", label: "DAG" });
          this.terminalManager.resize(DAG_TERMINAL_ID, message.cols, message.rows);
        } else this.showDagMessage(this.dagMessage);
        void this.refreshDag();
      } else if (message.type === "resize") {
        this.terminalManager.resize(DAG_TERMINAL_ID, message.cols, message.rows);
      } else if (message.type === "input" && message.data) {
        this.terminalManager.write(DAG_TERMINAL_ID, message.data);
      } else if (message.type === "scroll") {
        this.terminalManager.scroll(DAG_TERMINAL_ID, message);
      } else if (message.type === "copy" && message.text) {
        void vscode.env.clipboard.writeText(message.text);
      }
      return;
    }
    switch (message.type) {
      case "ready": {
        const isActive = source === this.activeLocation;
        if (isActive) {
          const activeSource = this.terminalManager.activeSource(TERMINAL_ID);
          const controllerPhase = this.attachController?.sourceState.phase ?? "shell";
          if (activeSource === undefined && controllerPhase === "shell") {
            this.terminalManager.ensureLocalShell(
              TERMINAL_ID,
              message.cols,
              message.rows,
            );
          } else if (activeSource !== undefined) {
            this.terminalManager.resize(TERMINAL_ID, message.cols, message.rows);
          }
        }
        this.postToSurface(source, { type: "config", ...this.readConfig() });
        const sourceState: SourceState = this.attachController?.sourceState ?? {
          source: "shell",
          phase: "shell",
        };
        this.postSourceStateToSurface(source, sourceState);
        this.postToSurface(source, { type: "reset" });
        const replay = this.terminalManager.replay(TERMINAL_ID);
        if (replay.length > 0) {
          this.postToSurface(source, { type: "output", data: replay });
        }
        if (isActive) {
          this.postMessage({ type: "focus" });
        }
        break;
      }
      case "input":
        if (source !== this.activeLocation) {
          return;
        }
        this.terminalManager.write(TERMINAL_ID, message.data);
        break;
      case "scroll":
        if (source !== this.activeLocation) {
          return;
        }
        this.terminalManager.scroll(TERMINAL_ID, message);
        break;
      case "resize":
        if (source !== this.activeLocation) {
          return;
        }
        this.terminalManager.resize(TERMINAL_ID, message.cols, message.rows);
        break;
      case "copy":
        if (message.text) {
          void vscode.env.clipboard.writeText(message.text);
        }
        break;
      case "imagePasted":
        void this.saveImageAndPostPath(message.data);
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private postMessage(message: HostMessage): void {
    if (message.type === "focus") {
      if (this.activeLocation === "editor" && this.editorPanel) {
        void this.editorPanel.webview.postMessage(message);
        return;
      }
      void this.view?.webview.postMessage(message);
      return;
    }

    if (!this.herdrEnabled() || message.type === "config") void this.view?.webview.postMessage(message);
    void this.editorPanel?.webview.postMessage(message);
  }

  private postToSurface(source: TerminalLocation, message: HostMessage): void {
    if (source === "editor") {
      void this.editorPanel?.webview.postMessage(message);
      return;
    }
    void this.view?.webview.postMessage(message);
  }

  private postSourceStateToSurface(
    source: TerminalLocation,
    state: SourceState,
  ): void {
    this.postToSurface(source, {
      type: "sourceState",
      source: state.source,
      phase: state.phase,
      ...(state.label === undefined ? {} : { label: state.label }),
      ...(state.message === undefined ? {} : { message: state.message }),
    });
  }

  private configureWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    return renderTerminalHtml({
      cspSource: webview.cspSource,
      nonce: this.createNonce(),
      scriptUri: scriptUri.toString(),
      renderer: this.readRendererPreference(),
    });
  }

  private async saveImageAndPostPath(dataUrl: string): Promise<void> {
    const parsed = this.parseDataUrl(dataUrl);
    if (!parsed) {
      return;
    }

    const { mimeType, buffer } = parsed;
    if (!ALLOWED_IMAGE_TYPES.includes(mimeType as (typeof ALLOWED_IMAGE_TYPES)[number])) {
      return;
    }
    if (buffer.length > MAX_IMAGE_SIZE) {
      return;
    }

    const extension = mimeType.split("/")[1];
    const tmpPath = path.join(
      os.tmpdir(),
      `ulw-clipboard-${randomUUID()}.${extension}`,
    );
    await fs.promises.writeFile(tmpPath, buffer, { mode: 0o600 });
    this.postMessage({ type: "clipboardImage", filePath: tmpPath });
  }

  private parseDataUrl(
    data: string,
  ): { mimeType: string; buffer: Buffer } | undefined {
    const match = data.match(
      /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/,
    );
    if (!match) {
      return undefined;
    }
    return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
  }

  private handleHerdrSessionMessage(
    sessionId: string,
    message: WebviewMessage,
  ): void {
    const session = this.herdrSessions.get(sessionId);
    if (!session) {
      return;
    }
    switch (message.type) {
      case "ready": {
        const source = this.terminalManager.activeSource(sessionId);
        if (source !== undefined && sessionId === this.activeTerminalId) {
          this.terminalManager.resize(sessionId, message.cols, message.rows);
        }
        void session.panel.webview.postMessage({ type: "config", ...this.readConfig() });
        this.postSourceStateToPanel(session.panel, session.controller.sourceState);
        void session.panel.webview.postMessage({ type: "reset" });
        const replay = this.terminalManager.replay(sessionId);
        if (replay.length > 0) {
          void session.panel.webview.postMessage({ type: "output", data: replay });
        }
        void session.panel.webview.postMessage({ type: "focus" });
        break;
      }
      case "input":
        if (sessionId === this.activeTerminalId) {
          this.terminalManager.write(sessionId, message.data);
        }
        break;
      case "scroll":
        if (sessionId === this.activeTerminalId) {
          this.terminalManager.scroll(sessionId, message);
        }
        break;
      case "resize":
        if (sessionId === this.activeTerminalId) {
          this.terminalManager.resize(sessionId, message.cols, message.rows);
        }
        break;
      case "copy":
        if (message.text) {
          void vscode.env.clipboard.writeText(message.text);
        }
        break;
      case "imagePasted":
        void this.saveImageAndPostPath(message.data);
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private postSourceStateToPanel(
    panel: vscode.WebviewPanel,
    state: SourceState,
  ): void {
    void panel.webview.postMessage({
      type: "sourceState",
      source: state.source,
      phase: state.phase,
      ...(state.label === undefined ? {} : { label: state.label }),
      ...(state.message === undefined ? {} : { message: state.message }),
    });
  }

  private applySidebarVisibility(): void {
    if (this.sidebarEnabled()) {
      return;
    }
    if (this.editorPanel) {
      this.activeLocation = "editor";
    }
    void vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  }

  private sidebarEnabled(): boolean {
    return vscode.workspace.getConfiguration("ulw").get<boolean>("sidebar.enabled", true);
  }

  private readDefaultLocation(): TerminalLocation {
    if (!this.sidebarEnabled()) {
      return "editor";
    }
    const configuration = vscode.workspace.getConfiguration("ulw");
    const configured = configuration.get<string>("defaultLocation", "editor");
    return configured === "sidebar" ? "sidebar" : "editor";
  }

  private readRendererPreference(): "webgl" | "dom" {
    const configured = vscode.workspace
      .getConfiguration("ulw")
      .get<string>("renderer", "webgl");
    return configured === "dom" ? "dom" : "webgl";
  }

  private readConfig(): TerminalConfig {
    const configuration = vscode.workspace.getConfiguration("ulw");
    return {
      fontSize: configuration.get<number>("fontSize", 14),
      fontFamily: configuration.get<string>(
        "fontFamily",
        "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', Menlo, Monaco, 'Apple SD Gothic Neo', 'Malgun Gothic', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans', 'Noto Sans CJK KR', 'Noto Sans CJK JP', 'Noto Sans CJK SC', monospace",
      ),
      cursorBlink: configuration.get<boolean>("cursorBlink", true),
      cursorStyle: configuration.get<CursorStyle>("cursorStyle", "block"),
      scrollback: configuration.get<number>("scrollback", 10000),
    };
  }

  private createNonce(): string {
    return randomBytes(32).toString("base64");
  }
}
