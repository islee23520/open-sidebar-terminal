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
import {
  ALLOWED_IMAGE_TYPES,
  DroppedBlobFile,
  MAX_IMAGE_SIZE,
  TMUX_RAW_ALLOWED_SUBCOMMANDS,
  TMUX_WEBVIEW_COMMAND_IDS,
  WebviewMessage,
} from "../types";
import type { TmuxRawSubcommand, TmuxWebviewCommandId } from "../types";
import { isWindowsAbsolutePath } from "../utils/pathUtils";

export interface MessageRouterProviderBridge {
  startOpenCode(): Promise<void>;
  switchToTmuxSession(sessionId: string): Promise<void>;
  killTmuxSession(sessionId: string): Promise<void>;
  createTmuxSession(): Promise<string | undefined>;
  toggleDashboard(): void;
  toggleEditorAttachment(): Promise<void>;
  restart(): void;
  switchToNativeShell(): Promise<void>;
  pasteText(text: string): void;
  getActiveInstanceId(): InstanceId;
  getActiveTerminalId(): string;
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
  executeRawTmuxCommand(subcommand: string, args?: string[]): Promise<string>;
  zoomTmuxPane(): Promise<void>;
  getSelectedTmuxSessionId(): string | undefined;
  isTmuxAvailable(): boolean;
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
        await this.handleFilesDropped(
          message.files ?? [],
          message.shiftKey ?? false,
          message.dropCell,
          message.blobFiles,
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
      case "launchAiTool":
        void this.provider.launchAiTool(
          message.sessionId,
          message.tool,
          message.savePreference,
          message.targetPaneId,
        );
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
      case "executeTmuxCommand":
        await this.handleExecuteTmuxCommand(message.commandId);
        break;
      case "executeTmuxRawCommand":
        await this.handleExecuteTmuxRawCommand(
          message.subcommand,
          message.args,
        );
        break;
      case "toggleDashboard":
        this.provider.toggleDashboard();
        break;
      case "toggleEditorAttachment":
        await this.provider.toggleEditorAttachment();
        break;
      case "requestRestart":
        this.provider.restart();
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
      this.provider.getActiveTerminalId(),
      data,
    );
  }

  private async handleExecuteTmuxCommand(commandId: unknown): Promise<void> {
    if (!this.isTmuxWebviewCommandId(commandId)) {
      return;
    }

    try {
      await vscode.commands.executeCommand(commandId);
    } catch (error) {
      this.logger.error(
        `[MessageRouter] executeTmuxCommand failed for ${commandId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleExecuteTmuxRawCommand(
    subcommand: unknown,
    args: unknown,
  ): Promise<void> {
    if (!this.isTmuxRawSubcommand(subcommand)) {
      return;
    }

    if (args !== undefined && !this.isStringArray(args)) {
      return;
    }

    try {
      await this.provider.executeRawTmuxCommand(subcommand, args);
    } catch (error) {
      this.logger.error(
        `[MessageRouter] executeTmuxRawCommand failed for ${subcommand}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private isTmuxWebviewCommandId(
    value: unknown,
  ): value is TmuxWebviewCommandId {
    return (
      typeof value === "string" &&
      TMUX_WEBVIEW_COMMAND_IDS.some((commandId) => commandId === value)
    );
  }

  private isTmuxRawSubcommand(value: unknown): value is TmuxRawSubcommand {
    return (
      typeof value === "string" &&
      TMUX_RAW_ALLOWED_SUBCOMMANDS.some((command) => command === value)
    );
  }

  private isStringArray(value: unknown): value is string[] {
    return (
      Array.isArray(value) && value.every((item) => typeof item === "string")
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
      this.provider.getActiveTerminalId(),
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
      tmuxAvailable: this.provider.isTmuxAvailable(),
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
      } else if (
        normalizedPath.startsWith("/") ||
        isWindowsAbsolutePath(filePath)
      ) {
        uri = vscode.Uri.file(filePath);
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

  public async handleFilesDropped(
    files: string[],
    shiftKey: boolean,
    dropCell?: { col: number; row: number },
    blobFiles?: DroppedBlobFile[],
  ): Promise<void> {
    this.logger.info(
      `[PROVIDER] handleFilesDropped - files: ${JSON.stringify(files)} shiftKey: ${shiftKey} dropCell: ${JSON.stringify(dropCell)}`,
    );

    const normalizedFiles = files.map((file) => {
      // Normalize any URI-scheme string (file://, vscode-file://, etc.) to a
      // filesystem path using vscode.Uri.parse so that outside-workspace
      // absolute paths are preserved correctly before asRelativePath is called.
      if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(file)) {
        try {
          return vscode.Uri.parse(file).fsPath;
        } catch {
          // fall through to raw value
        }
      }
      return file;
    });

    let dedupedFiles = [
      ...new Set(normalizedFiles.map((p) => path.normalize(p))),
    ];

    if (dedupedFiles.length === 0 && blobFiles && blobFiles.length > 0) {
      const materializedBlobPaths =
        await this.materializeDroppedBlobFiles(blobFiles);
      dedupedFiles = [
        ...new Set(materializedBlobPaths.map((p) => path.normalize(p))),
      ];
    }

    if (dedupedFiles.length === 0) {
      this.logger.warn("[PROVIDER] No usable dropped file paths were resolved");
      return;
    }

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

  public async handleImagePasted(data: string): Promise<void> {
    try {
      const parsedDataUrl = this.parseDataUrl(data);
      if (!parsedDataUrl) {
        this.logger.error("[TerminalProvider] Invalid image data URL format");
        return;
      }

      const { mimeType, buffer } = parsedDataUrl;
      if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
        this.logger.error(
          `[TerminalProvider] Unsupported image type: ${mimeType}`,
        );
        return;
      }

      if (buffer.length > MAX_IMAGE_SIZE) {
        this.logger.error("[TerminalProvider] Image exceeds 10MB size limit");
        return;
      }

      const extension = mimeType.split("/")[1];
      const tmpPath = await this.writeSecureTempFile(
        `opencode-clipboard-${randomUUID()}.${extension}`,
        buffer,
      );

      const formattedImage = this.provider.formatPastedImage(tmpPath);
      if (formattedImage) {
        this.provider.pasteText(formattedImage);
      }

      this.scheduleTempFileCleanup(tmpPath);
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to handle pasted image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private parseDataUrl(
    data: string,
  ): { mimeType: string; buffer: Buffer } | undefined {
    const base64Match = data.match(
      /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/,
    );
    if (!base64Match) {
      return undefined;
    }

    return {
      mimeType: base64Match[1],
      buffer: Buffer.from(base64Match[2], "base64"),
    };
  }

  private sanitizeDroppedBlobFileName(name: string): string {
    const baseName = name.split(/[\\/]/).pop()?.trim() || "dropped-file";
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
    return sanitized.length > 0 ? sanitized : "dropped-file";
  }

  private async writeSecureTempFile(
    fileName: string,
    buffer: Buffer,
  ): Promise<string> {
    const tmpPath = path.join(os.tmpdir(), fileName);
    await fs.promises.writeFile(tmpPath, buffer, {
      flag: "wx",
      mode: 0o600,
    });
    return tmpPath;
  }

  private scheduleTempFileCleanup(tmpPath: string): void {
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
  }

  private async materializeDroppedBlobFiles(
    blobFiles: DroppedBlobFile[],
  ): Promise<string[]> {
    const materializedPaths: string[] = [];

    for (const blobFile of blobFiles) {
      try {
        const parsedDataUrl = this.parseDataUrl(blobFile.data);
        if (!parsedDataUrl) {
          this.logger.error(
            `[TerminalProvider] Invalid dropped blob data URL for ${blobFile.name}`,
          );
          continue;
        }

        if (parsedDataUrl.buffer.length > MAX_IMAGE_SIZE) {
          this.logger.error(
            `[TerminalProvider] Dropped file exceeds 10MB size limit: ${blobFile.name}`,
          );
          continue;
        }

        const safeName = this.sanitizeDroppedBlobFileName(blobFile.name);
        const tmpPath = await this.writeSecureTempFile(
          `opencode-drop-${randomUUID()}-${safeName}`,
          parsedDataUrl.buffer,
        );
        this.scheduleTempFileCleanup(tmpPath);
        materializedPaths.push(tmpPath);
      } catch (error) {
        this.logger.error(
          `[TerminalProvider] Failed to materialize dropped blob ${blobFile.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return materializedPaths;
  }

  public async handleListTerminals(): Promise<void> {
    const terminals = await this.getTerminalEntries();
    this.provider.postWebviewMessage({
      type: "terminalList",
      terminals,
    });
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
      if (terminal.name === "Open Sidebar Terminal") {
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

      const pathParts = filePath
        .split(/[\\/]/)
        .filter((part) => part.length > 0);
      const filename = pathParts[pathParts.length - 1];

      const pattern = `**/${filename}*`;
      const files = await vscode.workspace.findFiles(pattern, null, 100);

      const normalizedInput = filePath.replace(/\\/g, "/").toLowerCase();
      files.sort((a, b) => {
        const aPath = a.fsPath.replace(/\\/g, "/").toLowerCase();
        const bPath = b.fsPath.replace(/\\/g, "/").toLowerCase();

        if (aPath.endsWith(normalizedInput)) {
          return -1;
        }
        if (bPath.endsWith(normalizedInput)) {
          return 1;
        }

        const aDirParts = a.fsPath.split(/[\\/]/);
        const bDirParts = b.fsPath.split(/[\\/]/);

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
