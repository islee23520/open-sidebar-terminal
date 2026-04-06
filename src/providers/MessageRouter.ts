import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { ContextSharingService } from "../services/ContextSharingService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OutputChannelService } from "../services/OutputChannelService";
import { TerminalManager } from "../terminals/TerminalManager";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE, WebviewMessage } from "../types";

export interface MessageRouterProviderBridge {
  startOpenCode(): Promise<void>;
  switchToTmuxSession(sessionId: string): Promise<void>;
  killTmuxSession(sessionId: string): Promise<void>;
  createTmuxSession(): Promise<string | undefined>;
  createTmuxWindow(): Promise<void>;
  navigateTmuxWindow(direction: "next" | "prev"): Promise<void>;
  navigateTmuxSession(direction: "next" | "prev"): Promise<void>;
  toggleDashboard(): void;
  switchToNativeShell(): Promise<void>;
  pasteText(text: string): void;
  getActiveInstanceId(): InstanceId;
  setLastKnownTerminalSize(cols: number, rows: number): void;
  getLastKnownTerminalSize(): { cols: number; rows: number };
  isStarted(): boolean;
  resizeActiveTerminal(cols: number, rows: number): void;
  postWebviewMessage(message: unknown): void;
  routeDroppedTextToTmuxPane(
    text: string,
    dropCell: { col: number; row: number },
  ): Promise<boolean>;
  formatDroppedFiles(paths: string[], useAtSyntax: boolean): string;
  formatPastedImage(tempPath: string): string | undefined;
  launchAiTool(
    sessionId: string,
    toolName: string,
    savePreference: boolean,
    targetPaneId?: string,
  ): Promise<void>;
  showAiToolSelector(
    sessionId: string,
    sessionName: string,
    forceShow?: boolean,
    targetPaneId?: string,
  ): Promise<void>;
  splitTmuxPane(direction: "h" | "v"): Promise<string | undefined>;
  zoomTmuxPane(): Promise<void>;
  killTmuxPane(): Promise<void>;
  getSelectedTmuxSessionId(): string | undefined;
}

export class MessageRouter {
  public constructor(
    private readonly provider: MessageRouterProviderBridge,
    private readonly context: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly captureManager: OutputCaptureManager,
    _apiClient: OpenCodeApiClient | undefined,
    _contextSharingService: ContextSharingService,
    private readonly logger: OutputChannelService,
    _instanceStore: InstanceStore | undefined,
  ) {}

  public async handleMessage(rawMessage: unknown): Promise<void> {
    if (!rawMessage || typeof rawMessage !== "object") {
      return;
    }

    const message = rawMessage as WebviewMessage;
    switch (message.type) {
      case "terminalInput":
        this.handleTerminalInput(message.data);
        break;
      case "terminalResize":
        this.handleTerminalResize(message.cols, message.rows);
        break;
      case "ready":
        this.handleReady(message.cols, message.rows);
        break;
      case "filesDropped":
        this.handleFilesDropped(
          message.files ?? [],
          message.shiftKey ?? false,
          message.dropCell,
        );
        break;
      case "openUrl":
        if (typeof message.url === "string") {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case "openFile":
        if (typeof message.path === "string") {
          void this.handleOpenFile(
            message.path,
            message.line,
            message.endLine,
            message.column,
          );
        }
        break;
      case "listTerminals":
        void this.handleListTerminals();
        break;
      case "terminalAction":
        if (message.action && typeof message.terminalName === "string") {
          void this.handleTerminalAction(
            message.action,
            message.terminalName,
            message.command,
          );
        }
        break;
      case "getClipboard":
        void this.handleGetClipboard();
        break;
      case "setClipboard":
        if (typeof message.text === "string") {
          void this.handleSetClipboard(message.text);
        }
        break;
      case "triggerPaste":
        void this.handlePaste();
        break;
      case "imagePasted":
        if (typeof message.data === "string") {
          void this.handleImagePasted(message.data);
        }
        break;
      case "switchSession":
        if (typeof message.sessionId === "string") {
          void this.provider.switchToTmuxSession(message.sessionId);
        }
        break;
      case "killSession":
        if (typeof message.sessionId === "string") {
          void this.provider.killTmuxSession(message.sessionId);
        }
        break;
      case "createTmuxSession":
        void this.provider.createTmuxSession();
        break;
      case "createTmuxWindow":
        try {
          await this.provider.createTmuxWindow();
        } catch (error) {
          this.logger.error(
            `[MessageRouter] createTmuxWindow failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case "navigateTmuxWindow":
        if (message.direction === "next" || message.direction === "prev") {
          try {
            await this.provider.navigateTmuxWindow(message.direction);
          } catch (error) {
            this.logger.error(
              `[MessageRouter] navigateTmuxWindow failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        break;
      case "navigateTmuxSession":
        if (message.direction === "next" || message.direction === "prev") {
          void this.provider.navigateTmuxSession(message.direction);
        }
        break;
      case "switchNativeShell":
        void this.provider.switchToNativeShell();
        break;
      case "launchAiTool":
        void this.provider.launchAiTool(
          message.sessionId,
          message.tool,
          message.savePreference,
          message.targetPaneId,
        );
        break;
      case "splitTmuxPane":
        if (message.direction === "h" || message.direction === "v") {
          try {
            await this.provider.splitTmuxPane(message.direction);
          } catch (error) {
            this.logger.error(
              `[MessageRouter] splitTmuxPane failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        break;
      case "zoomTmuxPane":
        try {
          await this.provider.zoomTmuxPane();
        } catch (error) {
          this.logger.error(
            `[MessageRouter] zoomTmuxPane failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case "killTmuxPane":
        try {
          await this.provider.killTmuxPane();
        } catch (error) {
          this.logger.error(
            `[MessageRouter] killTmuxPane failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case "sendTmuxPromptChoice":
        if (message.choice === "tmux") {
          void this.provider.createTmuxSession();
        } else if (message.choice === "shell") {
          void this.provider.switchToNativeShell();
        }
        break;
      case "requestAiToolSelector": {
        const sessionId =
          this.provider.getSelectedTmuxSessionId() ??
          this.provider.getActiveInstanceId();
        void this.provider.showAiToolSelector(sessionId, sessionId, true);
        break;
      }
      case "toggleDashboard":
        this.provider.toggleDashboard();
        break;
      default:
        break;
    }
  }

  public handleTerminalInput(data: string | undefined): void {
    if (typeof data !== "string") {
      return;
    }

    this.terminalManager.writeToTerminal(
      this.provider.getActiveInstanceId(),
      data,
    );
  }

  public handleTerminalResize(
    cols: number | undefined,
    rows: number | undefined,
  ): void {
    if (typeof cols !== "number" || typeof rows !== "number") {
      return;
    }

    this.provider.setLastKnownTerminalSize(cols, rows);
    this.terminalManager.resizeTerminal(
      this.provider.getActiveInstanceId(),
      cols,
      rows,
    );
  }

  public handleReady(cols: number | undefined, rows: number | undefined): void {
    if (typeof cols === "number" && typeof rows === "number") {
      this.provider.setLastKnownTerminalSize(cols, rows);
    }

    if (!this.provider.isStarted()) {
      void this.provider.startOpenCode();
    } else {
      const size = this.provider.getLastKnownTerminalSize();
      if (size.cols && size.rows) {
        this.provider.resizeActiveTerminal(size.cols, size.rows);
      }
    }

    this.provider.postWebviewMessage({
      type: "platformInfo",
      platform: process.platform,
    });
  }

  public async handleOpenFile(
    filePath: string,
    line?: number,
    endLine?: number,
    column?: number,
  ): Promise<void> {
    if (
      filePath.includes("..") ||
      filePath.includes("\0") ||
      filePath.includes("~")
    ) {
      void vscode.window.showErrorMessage(
        "Invalid file path: Path traversal detected",
      );
      return;
    }

    try {
      const normalizedPath = filePath.replace(/\\/g, "/");

      let uri: vscode.Uri;

      if (vscode.Uri.parse(filePath).scheme === "file") {
        uri = vscode.Uri.file(filePath);
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
      } catch {
        const matchedUri = await this.fuzzyMatchFile(normalizedPath);
        if (matchedUri) {
          const selection = this.createSelection(line, endLine, column);

          await vscode.window.showTextDocument(matchedUri, {
            selection,
            preview: true,
          });
        } else {
          void vscode.window.showErrorMessage(
            `Failed to open file: ${filePath}`,
          );
        }
      }
    } catch {
      void vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
    }
  }

  public handleFilesDropped(
    files: string[],
    shiftKey: boolean,
    dropCell?: { col: number; row: number },
  ): void {
    this.logger.info(
      `[PROVIDER] handleFilesDropped - files: ${JSON.stringify(files)} shiftKey: ${shiftKey} dropCell: ${JSON.stringify(dropCell)}`,
    );

    const normalizedFiles = files.map((file) => {
      if (file.startsWith("file://")) {
        try {
          const url = new URL(file);
          let decoded = decodeURIComponent(url.pathname);
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
      const fileRefs = this.provider.formatDroppedFiles(
        dedupedFiles.map((file) => vscode.workspace.asRelativePath(file)),
        true,
      );
      this.logger.info(`[PROVIDER] Writing with @: ${fileRefs}`);

      if (dropCell) {
        void this.provider
          .routeDroppedTextToTmuxPane(fileRefs + " ", dropCell)
          .then((routed) => {
            if (!routed) {
              this.logger.info(
                `[PROVIDER] Pane routing failed, falling back to active terminal`,
              );
              this.terminalManager.writeToTerminal(
                this.provider.getActiveInstanceId(),
                fileRefs + " ",
              );
            }
          });
      } else {
        this.terminalManager.writeToTerminal(
          this.provider.getActiveInstanceId(),
          fileRefs + " ",
        );
      }
    } else {
      const filePaths = this.provider.formatDroppedFiles(
        dedupedFiles.map((file) => vscode.workspace.asRelativePath(file)),
        false,
      );
      this.logger.info(`[PROVIDER] Writing without @: ${filePaths}`);
      this.terminalManager.writeToTerminal(
        this.provider.getActiveInstanceId(),
        filePaths + " ",
      );
    }
  }

  public async handlePaste(): Promise<void> {
    try {
      const text = await vscode.env.clipboard.readText();
      if (text) {
        this.provider.pasteText(text);
      }
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to paste: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async handleSetClipboard(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to write clipboard: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async handleGetClipboard(): Promise<void> {
    try {
      const text = await vscode.env.clipboard.readText();
      this.provider.postWebviewMessage({
        type: "clipboardContent",
        text,
      });
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to read clipboard: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async handleImagePasted(data: string): Promise<void> {
    try {
      const base64Match = data.match(
        /^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!base64Match) {
        this.logger.error("[TerminalProvider] Invalid image data URL format");
        return;
      }

      const mimeType = base64Match[1];
      if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
        this.logger.error(
          `[TerminalProvider] Unsupported image type: ${mimeType}`,
        );
        return;
      }

      const buffer = Buffer.from(base64Match[2], "base64");
      if (buffer.length > MAX_IMAGE_SIZE) {
        this.logger.error("[TerminalProvider] Image exceeds 10MB size limit");
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

      const formattedImage = this.provider.formatPastedImage(tmpPath);
      if (formattedImage) {
        this.provider.pasteText(formattedImage);
      }

      setTimeout(
        async () => {
          try {
            await fs.promises.unlink(tmpPath);
            this.logger.debug(
              `[TerminalProvider] Cleaned up temp file: ${tmpPath}`,
            );
          } catch (err) {
            this.logger.warn(
              `[TerminalProvider] Failed to cleanup temp file: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
        5 * 60 * 1000,
      );
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to handle pasted image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async handleListTerminals(): Promise<void> {
    const terminals = await this.getTerminalEntries();
    this.provider.postWebviewMessage({
      type: "terminalList",
      terminals,
    });
  }

  public async handleTerminalAction(
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

  public async sendCommandToTerminal(
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

  public startTerminalCapture(
    terminal: vscode.Terminal,
    terminalName: string,
  ): void {
    const result = this.captureManager.startCapture(terminal);
    if (result.success) {
      void vscode.window.showInformationMessage(
        `Started capturing terminal: ${terminalName}`,
      );
      return;
    }

    void vscode.window.showErrorMessage(
      `Failed to start capture: ${result.error ?? "Unknown error"}`,
    );
  }

  public async getTerminalEntries(): Promise<
    Array<{ name: string; cwd: string }>
  > {
    const entries: Array<{ name: string; cwd: string }> = [];

    for (const terminal of vscode.window.terminals) {
      if (terminal.name === "Open AI Sidebar Terminal") {
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

  public createSelection(
    line?: number,
    endLine?: number,
    column?: number,
  ): vscode.Range | undefined {
    if (!line) {
      return undefined;
    }

    const maxColumn = 9999;
    return new vscode.Range(
      Math.max(0, line - 1),
      Math.max(0, (column || 1) - 1),
      Math.max(0, (endLine || line) - 1),
      endLine ? maxColumn : Math.max(0, (column || 1) - 1),
    );
  }

  public async fuzzyMatchFile(filePath: string): Promise<vscode.Uri | null> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return null;
      }

      const pathParts = filePath.split("/").filter((part) => part.length > 0);
      const filename = pathParts[pathParts.length - 1];

      const pattern = `**/${filename}*`;
      const files = await vscode.workspace.findFiles(pattern, null, 100);

      files.sort((a, b) => {
        const aPath = a.fsPath.toLowerCase();
        const bPath = b.fsPath.toLowerCase();
        const lowerPath = filePath.toLowerCase();

        if (aPath.endsWith(lowerPath)) {
          return -1;
        }
        if (bPath.endsWith(lowerPath)) {
          return 1;
        }

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
}
