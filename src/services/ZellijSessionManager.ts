import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { basename } from "node:path";
import { TmuxSession } from "../types";
import { ILogger } from "./ILogger";

interface ExecError extends Error {
  code?: number | string | null;
  stderr?: string;
}

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

type ExecFileLike = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => void;

export class ZellijUnavailableError extends Error {
  constructor(message: string = "zellij is not installed") {
    super(message);
    this.name = "ZellijUnavailableError";
  }
}

interface EnsureZellijSessionResult {
  action: "attached" | "created";
  session: TmuxSession;
}

export interface ZellijPane {
  id: string;
  title: string;
  isFocused: boolean;
  isFloating: boolean;
}

export interface ZellijTab {
  index: number;
  name: string;
  isActive: boolean;
}

export class ZellijSessionManager {
  public constructor(
    private readonly logger?: ILogger,
    private readonly runExecFile: ExecFileLike = (
      file,
      args,
      options,
      callback,
    ) => {
      execFile(file, args, options, callback);
    },
  ) {}

  public async isAvailable(): Promise<boolean> {
    try {
      await this.runZellij(["--version"]);
      return true;
    } catch (error) {
      if (this.isZellijUnavailable(error)) {
        return false;
      }
      throw error;
    }
  }

  public async discoverSessions(): Promise<TmuxSession[]> {
    try {
      const stdout = await this.runZellij(["list-sessions"]);
      return this.parseSessions(stdout);
    } catch (error) {
      if (this.isNoSessionsError(error)) {
        return [];
      }
      if (this.isZellijUnavailable(error)) {
        throw new ZellijUnavailableError();
      }
      throw error;
    }
  }

  public async ensureSession(
    sessionName: string,
    workspacePath: string,
  ): Promise<EnsureZellijSessionResult> {
    const sessions = await this.discoverSessions();
    const existing = sessions.find((session) => session.id === sessionName);
    if (existing) {
      return { action: "attached", session: { ...existing, isActive: true } };
    }

    const existingIds = new Set(sessions.map((session) => session.id));
    const resolvedName = this.resolveCollisionSafeSessionName(
      sessionName,
      existingIds,
    );
    await this.createSession(resolvedName, workspacePath);
    return {
      action: "created",
      session: {
        id: resolvedName,
        name: resolvedName,
        workspace: basename(workspacePath) || resolvedName,
        isActive: true,
      },
    };
  }

  public async createSession(
    sessionName: string,
    workspacePath: string,
  ): Promise<void> {
    try {
      await this.runZellij(
        ["attach", "--create-background", sessionName],
        workspacePath,
      );
    } catch (error) {
      if (this.isZellijUnavailable(error)) {
        throw new ZellijUnavailableError();
      }
      throw error;
    }
  }

  public getAttachCommand(sessionName: string): string {
    return `zellij attach ${this.shellQuote(sessionName)}`;
  }

  /** Kill a zellij session by name */
  public async killSession(sessionName: string): Promise<void> {
    try {
      await this.runZellij(["kill-session", sessionName]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Switch to a different zellij session */
  public async switchSession(sessionName: string): Promise<void> {
    try {
      await this.runZellij(["action", "switch-session", sessionName]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Split the current pane in given direction. Returns new pane ID. */
  public async splitPane(
    direction: "h" | "v",
    options?: { command?: string; workingDirectory?: string },
  ): Promise<string> {
    const zellijDirection = direction === "h" ? "right" : "down";
    const args = ["action", "new-pane", "--direction", zellijDirection];

    if (options?.workingDirectory) {
      args.push("--cwd", options.workingDirectory);
    }
    if (options?.command) {
      args.push("--command", options.command);
    }

    try {
      const stdout = await this.runZellij(args, options?.workingDirectory);
      const paneId = this.extractPaneId(stdout);
      if (!paneId) {
        throw new Error("Failed to get pane ID from new-pane output");
      }
      return paneId;
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Close the focused pane */
  public async killPane(): Promise<void> {
    try {
      await this.runZellij(["action", "close-pane"]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Focus a specific pane by ID */
  public async selectPane(paneId: string): Promise<void> {
    try {
      await this.runZellij(["action", "focus-pane-id", paneId]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Resize the focused pane */
  public async resizePane(
    direction: "left" | "right" | "up" | "down",
    adjustment: number,
  ): Promise<void> {
    try {
      await this.runZellij([
        "action",
        "resize",
        `--${direction}`,
        this.formatSignedAdjustment(adjustment),
      ]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Toggle fullscreen on focused pane */
  public async zoomPane(): Promise<void> {
    try {
      await this.runZellij(["action", "toggle-fullscreen"]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Send text to the focused pane */
  public async sendTextToPane(
    text: string,
    options?: { submit?: boolean },
  ): Promise<void> {
    try {
      await this.runZellij(["action", "write-chars", text]);
      if (options?.submit) {
        await this.runZellij(["action", "send-keys", "Enter"]);
      }
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** List all panes in current session */
  public async listPanes(): Promise<ZellijPane[]> {
    try {
      const stdout = await this.runZellij(["action", "list-panes"]);
      return this.parsePanes(stdout);
    } catch (error) {
      if (this.isNoSessionsError(error)) {
        return [];
      }
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Create a new tab */
  public async createTab(options?: {
    name?: string;
    workingDirectory?: string;
  }): Promise<void> {
    const args = ["action", "new-tab"];
    if (options?.name) {
      args.push("--name", options.name);
    }
    if (options?.workingDirectory) {
      args.push("--cwd", options.workingDirectory);
    }

    try {
      await this.runZellij(args, options?.workingDirectory);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Go to next tab */
  public async nextTab(): Promise<void> {
    try {
      await this.runZellij(["action", "go-to-next-tab"]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Go to previous tab */
  public async prevTab(): Promise<void> {
    try {
      await this.runZellij(["action", "go-to-previous-tab"]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Close current tab */
  public async killTab(): Promise<void> {
    try {
      await this.runZellij(["action", "close-tab"]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Switch to tab by 1-based index */
  public async selectTab(index: number): Promise<void> {
    try {
      await this.runZellij(["action", "go-to-tab", String(index)]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Rename current tab */
  public async renameTab(name: string): Promise<void> {
    try {
      await this.runZellij(["action", "rename-tab", name]);
    } catch (error) {
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** List all tabs */
  public async listTabs(): Promise<ZellijTab[]> {
    try {
      const stdout = await this.runZellij(["action", "list-tabs"]);
      return this.parseTabs(stdout);
    } catch (error) {
      if (this.isNoSessionsError(error)) {
        return [];
      }
      this.throwUnavailableOrOriginal(error);
    }
  }

  /** Get active focus info */
  public async getActiveFocus(): Promise<
    { tabName: string; paneId: string } | undefined
  > {
    try {
      const [tabInfo, panes] = await Promise.all([
        this.runZellij(["action", "current-tab-info"]),
        this.listPanes(),
      ]);
      const tabName = this.extractTabName(tabInfo);
      const focusedPane = panes.find((pane) => pane.isFocused);
      if (!tabName || !focusedPane) {
        return undefined;
      }
      return { tabName, paneId: focusedPane.id };
    } catch (error) {
      this.logger?.debug(
        `[ZellijSessionManager] getActiveFocus failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
  /** Dump screen content of focused pane */
  public async dumpScreen(): Promise<string> {
    try {
      return await this.runZellij(["action", "dump-screen"]);
    } catch (error) {
      if (this.isZellijUnavailable(error)) {
        throw new ZellijUnavailableError();
      }
      if (this.isNoSessionsError(error)) {
        return "";
      }
      throw error;
    }
  }

  private parseSessions(stdout: string): TmuxSession[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const name = line.split(/\s+/)[0] ?? line;
        return {
          id: name,
          name,
          workspace: name,
          isActive: /\(current\)|\[current\]/i.test(line),
        };
      });
  }

  private parsePanes(stdout: string): ZellijPane[] {
    const json = this.tryParseJson(stdout);
    if (Array.isArray(json)) {
      return json
        .map((entry) => this.parsePaneFromUnknown(entry))
        .filter((pane): pane is ZellijPane => pane !== undefined);
    }

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => this.parsePaneFromLine(line))
      .filter((pane): pane is ZellijPane => pane !== undefined);
  }

  private parseTabs(stdout: string): ZellijTab[] {
    const json = this.tryParseJson(stdout);
    if (Array.isArray(json)) {
      return json
        .map((entry, index) => this.parseTabFromUnknown(entry, index + 1))
        .filter((tab): tab is ZellijTab => tab !== undefined);
    }

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(TAB_ID|PANE_ID)\b/i.test(line))
      .map((line, index) => this.parseTabFromLine(line, index + 1))
      .filter(Boolean);
  }

  private parsePaneFromUnknown(value: unknown): ZellijPane | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const id = this.extractPaneIdFromValue(value.id) ?? this.extractPaneId(JSON.stringify(value));
    if (!id) {
      return undefined;
    }

    return {
      id,
      title: this.stringFromRecord(value, ["title", "name", "pane_title"]) ?? "",
      isFocused: this.booleanFromRecord(value, ["is_focused", "isFocused", "focused"]),
      isFloating: this.booleanFromRecord(value, ["is_floating", "isFloating", "floating"]),
    };
  }

  private parsePaneFromLine(line: string): ZellijPane | undefined {
    const id = this.extractPaneId(line);
    if (!id) {
      return undefined;
    }
    const tabParts = line.split("\t");
    const title = tabParts.length >= 2 ? tabParts[1]?.trim() ?? "" : this.extractNamedValue(line, ["title", "name"]) ?? "";
    return {
      id,
      title,
      isFocused: /\b(is_)?focused\b\s*[:=]\s*true\b|\b(active|current)\b/i.test(line),
      isFloating: /\b(is_)?floating\b\s*[:=]\s*true\b/i.test(line),
    };
  }

  private parseTabFromUnknown(value: unknown, fallbackIndex: number): ZellijTab | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }
    const indexValue = value.index ?? value.position ?? value.tab_index;
    const name = this.stringFromRecord(value, ["name", "title", "tab_name"]);
    return {
      index: typeof indexValue === "number" ? indexValue : fallbackIndex,
      name: name ?? `Tab ${fallbackIndex}`,
      isActive: this.booleanFromRecord(value, ["is_active", "isActive", "active", "focused"]),
    };
  }

  private parseTabFromLine(line: string, fallbackIndex: number): ZellijTab {
    // zellij action list-tabs output is whitespace-separated:
    // "TAB_ID  POSITION  NAME" (header) then "0  0  Tab #1"
    const parts = line.split(/\s{2,}|\t+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const numericId = Number(parts[0]);
      const numericPos = Number(parts[1]);
      const positionIndex =
        Number.isFinite(numericPos) && numericPos >= 0
          ? numericPos + 1
          : Number.isFinite(numericId) && numericId >= 0
            ? numericId + 1
            : fallbackIndex;
      return {
        index: positionIndex,
        name: parts[2] ?? `Tab ${positionIndex}`,
        isActive: this.parseBooleanToken(parts[3]),
      };
    }
    const numbered = line.match(/^\s*(\d+)\s*[:.)\-]?\s*(.*?)\s*$/);
    const index = numbered?.[1] ? Number(numbered[1]) : fallbackIndex;
    const rawName = numbered?.[2] ?? line;
    const name = rawName
      .replace(/\b(active|current|focused)\b/gi, "")
      .replace(/[()\[\]{}*:]/g, "")
      .trim();
    return {
      index,
      name: name || `Tab ${index}`,
      isActive: /\bactive\b|\bcurrent\b|\bfocused\b|\*/i.test(line),
    };
  }

  private extractTabName(stdout: string): string | undefined {
    const json = this.tryParseJson(stdout);
    if (this.isRecord(json)) {
      return this.stringFromRecord(json, ["name", "title", "tab_name"]);
    }
    return this.extractNamedValue(stdout, ["name", "title", "tab_name"]) ?? stdout.trim().split(/\r?\n/)[0]?.trim();
  }

  private extractPaneId(stdout: string): string | undefined {
    return stdout.match(/\b(?:terminal|plugin)_\d+\b/)?.[0];
  }

  private extractPaneIdFromValue(value: unknown): string | undefined {
    if (typeof value === "string") {
      return this.extractPaneId(value);
    }
    if (typeof value === "number") {
      return `terminal_${value}`;
    }
    return undefined;
  }

  private extractNamedValue(text: string, names: string[]): string | undefined {
    for (const name of names) {
      const match = text.match(new RegExp(`${name}[\\s:=]+["']?([^,"'\\]}\\)]+)`, "i"));
      const value = match?.[1]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private tryParseJson(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      this.logger?.debug(
        `[ZellijSessionManager] tryParseJson failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private stringFromRecord(
    record: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") {
        return value;
      }
    }
    return undefined;
  }

  private booleanFromRecord(record: Record<string, unknown>, keys: string[]): boolean {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "string") {
        return this.parseBooleanToken(value);
      }
    }
    return false;
  }

  private parseBooleanToken(value: string | undefined): boolean {
    return /^(1|true|yes|active|current|focused)$/i.test(value?.trim() ?? "");
  }

  private formatSignedAdjustment(adjustment: number): string {
    return adjustment >= 0 ? `+${adjustment}` : String(adjustment);
  }

  private async runZellij(args: string[], cwd?: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      this.runExecFile("zellij", args, cwd ? { cwd } : {}, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: stderr || (error as ExecError).stderr || "" }));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private isNoSessionsError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const stderr = (error as ExecError).stderr ?? "";
    return (
      /no (active )?sessions?|not found/i.test(stderr) ||
      /no (active )?sessions?/i.test(error.message)
    );
  }

  private isZellijUnavailable(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const execError = error as ExecError;
    const text = `${execError.message} ${execError.stderr ?? ""}`.toLowerCase();
    return execError.code === "ENOENT" || text.includes("enoent");
  }

  private throwUnavailableOrOriginal(error: unknown): never {
    if (this.isZellijUnavailable(error)) {
      throw new ZellijUnavailableError();
    }
    throw error;
  }

  private resolveCollisionSafeSessionName(
    baseName: string,
    existingSessionNames: Set<string>,
  ): string {
    if (!existingSessionNames.has(baseName)) {
      return baseName;
    }
    let suffix = 2;
    let candidate = `${baseName}-${suffix}`;
    while (existingSessionNames.has(candidate)) {
      suffix += 1;
      candidate = `${baseName}-${suffix}`;
    }
    return candidate;
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
}
