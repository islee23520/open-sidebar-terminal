import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import * as vscode from "vscode";
import { TmuxDashboardPaneDto, TmuxSession, TreeSnapshot } from "../types";

const TMUX_LIST_FORMAT =
  "#{session_name}\t#{session_attached}\t#{session_path}";

interface ExecError extends Error {
  code?: number | string;
  stderr?: string;
}

type ExecFileCallback = (
  error: ExecError | null,
  stdout: string,
  stderr: string,
) => void;

type ExecFileLike = (
  file: string,
  args: string[],
  callback: ExecFileCallback,
) => void;

interface DiscoveredSession {
  session: TmuxSession;
  workspacePath: string | undefined;
}

export interface TmuxPane {
  paneId: string;
  index: number;
  title: string;
  isActive: boolean;
  currentCommand?: string;
  windowId?: string;
}

export interface TmuxPaneGeometry {
  paneId: string;
  paneLeft: number;
  paneTop: number;
  paneWidth: number;
  paneHeight: number;
}

interface TmuxWindow {
  windowId: string;
  index: number;
  name: string;
  isActive: boolean;
}

export class TmuxUnavailableError extends Error {
  constructor(message: string = "tmux is not installed") {
    super(message);
    this.name = "TmuxUnavailableError";
  }
}

interface EnsureTmuxSessionResult {
  action: "attached" | "created";
  session: TmuxSession;
}

export class TmuxSessionManager {
  private readonly _onPaneChanged = new vscode.EventEmitter<void>();
  public readonly onPaneChanged = this._onPaneChanged.event;

  constructor(
    private readonly runExecFile: ExecFileLike = (file, args, callback) => {
      execFile(file, args, callback as never);
    },
  ) {}

  public dispose(): void {
    this._onPaneChanged.dispose();
  }

  public async isAvailable(): Promise<boolean> {
    try {
      await this.runTmux(["-V"]);
      return true;
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        return false;
      }

      throw error;
    }
  }

  public async discoverSessions(): Promise<TmuxSession[]> {
    const discoveredSessions = await this.discoverSessionDetails();
    return discoveredSessions.map(({ session }) => session);
  }

  private async discoverSessionDetails(): Promise<DiscoveredSession[]> {
    try {
      const stdout = await this.runTmux([
        "list-sessions",
        "-F",
        TMUX_LIST_FORMAT,
      ]);
      return this.parseSessions(stdout);
    } catch (error) {
      if (this.isNoSessionsError(error)) {
        return [];
      }

      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }

      throw error;
    }
  }

  public async createTreeSnapshot(
    activeSessionId: string | null = null,
  ): Promise<TreeSnapshot> {
    try {
      const sessions = await this.discoverSessions();
      const resolvedActiveSessionId =
        activeSessionId ??
        sessions.find((session) => session.isActive)?.id ??
        null;

      return {
        type: "treeSnapshot",
        sessions,
        activeSessionId: resolvedActiveSessionId,
        emptyState: sessions.length === 0 ? "no-sessions" : undefined,
      };
    } catch (error) {
      if (error instanceof TmuxUnavailableError) {
        return {
          type: "treeSnapshot",
          sessions: [],
          activeSessionId: null,
          emptyState: "no-tmux",
        };
      }

      throw error;
    }
  }

  public async ensureSession(
    sessionName: string,
    workspacePath: string,
  ): Promise<EnsureTmuxSessionResult> {
    const discoveredSessions = await this.discoverSessionDetails();
    const existingSession = this.selectWorkspaceSession(
      discoveredSessions,
      workspacePath,
      sessionName,
    );

    if (existingSession) {
      return {
        action: "attached",
        session: {
          ...existingSession,
          isActive: true,
        },
      };
    }

    const existingSessionNames = new Set(
      discoveredSessions.map(({ session }) => session.id),
    );
    const sessionNameForCreate = this.resolveCollisionSafeSessionName(
      sessionName,
      existingSessionNames,
    );

    await this.createSession(sessionNameForCreate, workspacePath);
    return {
      action: "created",
      session: {
        id: sessionNameForCreate,
        name: sessionNameForCreate,
        workspace: this.resolveWorkspaceName(
          workspacePath,
          sessionNameForCreate,
        ),
        isActive: true,
      },
    };
  }

  public async findSessionForWorkspace(
    workspacePath: string,
    preferredSessionName?: string,
  ): Promise<TmuxSession | undefined> {
    const discoveredSessions = await this.discoverSessionDetails();
    return this.selectWorkspaceSession(
      discoveredSessions,
      workspacePath,
      preferredSessionName,
    );
  }

  public async attachSession(sessionName: string): Promise<void> {
    try {
      await this.runTmux(["attach-session", "-t", sessionName]);
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }

      throw error;
    }
  }

  public async createSession(
    sessionName: string,
    workspacePath: string,
  ): Promise<void> {
    try {
      await this.runTmux([
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        workspacePath,
      ]);
      await this.runTmux(["set-option", "-t", sessionName, "mouse", "on"]);
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }

      throw error;
    }
  }

  public async showBuffer(): Promise<string> {
    try {
      return await this.runTmux(["show-buffer"]);
    } catch {
      return "";
    }
  }

  public async setMouseOn(sessionId: string): Promise<void> {
    try {
      await this.runTmux(["set-option", "-t", sessionId, "mouse", "on"]);
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }

      throw error;
    }
  }

  public async killSession(sessionName: string): Promise<void> {
    try {
      await this.runTmux(["kill-session", "-t", sessionName]);
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }

      throw error;
    }
  }

  public async createWindow(
    sessionId: string,
    workingDirectory?: string,
  ): Promise<void> {
    try {
      const args = ["new-window", "-t", sessionId];
      if (workingDirectory) {
        args.push("-c", workingDirectory);
      }
      await this.runTmux(args);
      this._onPaneChanged.fire();
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async nextWindow(sessionId: string): Promise<void> {
    try {
      await this.runTmux(["next-window", "-t", sessionId]);
      this._onPaneChanged.fire();
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async prevWindow(sessionId: string): Promise<void> {
    try {
      await this.runTmux(["previous-window", "-t", sessionId]);
      this._onPaneChanged.fire();
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async killWindow(windowId: string): Promise<void> {
    try {
      await this.runTmux(["kill-window", "-t", windowId]);
      this._onPaneChanged.fire();
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async splitPane(
    targetPaneId: string,
    direction: "h" | "v",
    options?: { command?: string; workingDirectory?: string },
  ): Promise<string> {
    try {
      const args = [
        "split-window",
        "-t",
        targetPaneId,
        `-${direction}`,
        "-P",
        "-F",
        "#{pane_id}",
      ];
      if (options?.workingDirectory) {
        args.push("-c", options.workingDirectory);
      }
      if (options?.command) {
        args.push(options.command);
      }
      console.log(
        `[DIAG:splitPane] targetPaneId="${targetPaneId}" direction="${direction}" command="${options?.command ?? "none"}" args=${JSON.stringify(args)}`,
      );
      const stdout = await this.runTmux(args);
      const newPaneId = stdout.trim();
      console.log(`[DIAG:splitPane] SUCCESS newPaneId="${newPaneId}"`);
      this._onPaneChanged.fire();
      return newPaneId;
    } catch (error) {
      console.log(
        `[DIAG:splitPane] FAILED targetPaneId="${targetPaneId}" error=${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async killPane(paneId: string): Promise<void> {
    try {
      console.log(`[DIAG:killPane] paneId="${paneId}"`);
      await this.runTmux(["kill-pane", "-t", paneId]);
      console.log(`[DIAG:killPane] SUCCESS paneId="${paneId}"`);
      this._onPaneChanged.fire();
    } catch (error) {
      console.log(
        `[DIAG:killPane] FAILED paneId="${paneId}" error=${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async selectWindow(windowId: string): Promise<void> {
    try {
      await this.runTmux(["select-window", "-t", windowId]);
      this._onPaneChanged.fire();
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async selectPane(paneId: string, windowId?: string): Promise<void> {
    try {
      console.log(
        `[DIAG:selectPane] paneId="${paneId}" windowId="${windowId ?? "none"}"`,
      );
      if (windowId) {
        await this.runTmux(["select-window", "-t", windowId]);
      }
      await this.runTmux(["select-pane", "-t", paneId]);
      console.log(
        `[DIAG:selectPane] SUCCESS paneId="${paneId}" windowId="${windowId ?? "none"}"`,
      );
      this._onPaneChanged.fire();
    } catch (error) {
      console.log(
        `[DIAG:selectPane] FAILED paneId="${paneId}" windowId="${windowId ?? "none"}" error=${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async resizePane(
    paneId: string,
    direction: "L" | "R" | "U" | "D",
    adjustment: number,
  ): Promise<void> {
    try {
      await this.runTmux([
        "resize-pane",
        "-t",
        paneId,
        `-${direction}`,
        String(adjustment),
      ]);
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async swapPanes(
    sourcePaneId: string,
    targetPaneId: string,
  ): Promise<void> {
    try {
      await this.runTmux(["swap-pane", "-s", sourcePaneId, "-t", targetPaneId]);
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async sendTextToPane(
    paneId: string,
    text: string,
    options?: { submit?: boolean },
  ): Promise<void> {
    try {
      const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
      const submit = options?.submit !== false;
      console.log(
        `[DIAG:sendTextToPane] paneId="${paneId}" text="${preview}" submit=${submit}`,
      );
      const args: string[] = ["send-keys", "-t", paneId];
      if (submit) {
        args.push(text, "C-m");
      } else {
        args.push("-l", text);
      }
      await this.runTmux(args);
      console.log(`[DIAG:sendTextToPane] SUCCESS paneId="${paneId}"`);
    } catch (error) {
      console.log(
        `[DIAG:sendTextToPane] FAILED paneId="${paneId}" error=${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async listWindows(sessionId: string): Promise<TmuxWindow[]> {
    try {
      const format =
        "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}";
      const stdout = await this.runTmux([
        "list-windows",
        "-t",
        sessionId,
        "-F",
        format,
      ]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [windowId, index, name, active] = line.split("\t");
          return {
            windowId: windowId ?? "",
            index: Number(index),
            name: name ?? "",
            isActive: active === "1",
          };
        });
    } catch (error) {
      if (this.isNoSessionsError(error)) {
        return [];
      }
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async listPanes(sessionId: string): Promise<TmuxPane[]> {
    try {
      const format =
        "#{pane_id}\t#{pane_index}\t#{pane_title}\t#{pane_active}\t#{pane_current_command}\t#{window_id}";
      const stdout = await this.runTmux([
        "list-panes",
        "-s",
        "-t",
        sessionId,
        "-F",
        format,
      ]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [paneId, index, title, active, currentCommand, windowId] =
            line.split("\t");
          return {
            paneId: paneId ?? "",
            index: Number(index),
            title: title ?? "",
            isActive: active === "1",
            ...(currentCommand !== undefined
              ? { currentCommand: currentCommand ?? "" }
              : {}),
            ...(windowId !== undefined ? { windowId: windowId ?? "" } : {}),
          };
        });
    } catch (error) {
      if (this.isNoSessionsError(error)) {
        return [];
      }
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async listVisiblePaneGeometry(
    sessionId: string,
  ): Promise<TmuxPaneGeometry[]> {
    try {
      const format =
        "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}";
      const stdout = await this.runTmux([
        "list-panes",
        "-t",
        sessionId,
        "-F",
        format,
      ]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [paneId, left, top, width, height] = line.split("\t");
          return {
            paneId: paneId ?? "",
            paneLeft: Number(left),
            paneTop: Number(top),
            paneWidth: Number(width),
            paneHeight: Number(height),
          };
        });
    } catch (error) {
      if (this.isNoSessionsError(error)) {
        return [];
      }
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }
      throw error;
    }
  }

  public async listPaneDtos(
    sessionId: string,
  ): Promise<TmuxDashboardPaneDto[]> {
    const panes = await this.listPanes(sessionId);
    return panes.map((p) => ({
      paneId: p.paneId,
      index: p.index,
      title: p.title,
      isActive: p.isActive,
      ...(p.currentCommand !== undefined
        ? { currentCommand: p.currentCommand }
        : {}),
      ...(p.windowId !== undefined ? { windowId: p.windowId } : {}),
    }));
  }

  private parseSessions(stdout: string): DiscoveredSession[] {
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        const [name, attachedCount, sessionPath] = line.split("\t");
        const trimmedName = name?.trim();

        if (!trimmedName) {
          return [];
        }

        return [
          {
            session: {
              id: trimmedName,
              name: trimmedName,
              workspace: this.resolveWorkspaceName(sessionPath, trimmedName),
              isActive: Number(attachedCount) > 0,
            },
            workspacePath: this.normalizeWorkspacePath(sessionPath),
          } satisfies DiscoveredSession,
        ];
      });
  }

  private pickPreferredSession(
    discoveredSessions: DiscoveredSession[],
    preferredName?: string,
  ): TmuxSession | undefined {
    if (discoveredSessions.length === 0) {
      return undefined;
    }

    if (preferredName) {
      const exactNameMatch = discoveredSessions.find(
        ({ session }) =>
          session.id === preferredName || session.name === preferredName,
      );
      if (exactNameMatch) {
        return exactNameMatch.session;
      }
    }

    const activeSession = discoveredSessions.find(
      ({ session }) => session.isActive,
    );
    if (activeSession) {
      return activeSession.session;
    }

    return discoveredSessions
      .slice()
      .sort((a, b) => a.session.id.localeCompare(b.session.id))[0]?.session;
  }

  private selectWorkspaceSession(
    discoveredSessions: DiscoveredSession[],
    workspacePath: string,
    preferredSessionName?: string,
  ): TmuxSession | undefined {
    const exactWorkspaceMatches = discoveredSessions.filter((entry) =>
      this.pathsMatch(entry.workspacePath, workspacePath),
    );

    return this.pickPreferredSession(
      exactWorkspaceMatches,
      preferredSessionName,
    );
  }

  private resolveCollisionSafeSessionName(
    requestedName: string,
    existingSessionNames: Set<string>,
  ): string {
    if (!existingSessionNames.has(requestedName)) {
      return requestedName;
    }

    let suffix = 2;
    while (existingSessionNames.has(`${requestedName}-${suffix}`)) {
      suffix += 1;
    }

    return `${requestedName}-${suffix}`;
  }

  private pathsMatch(
    discoveredWorkspacePath: string | undefined,
    requestedWorkspacePath: string,
  ): boolean {
    const normalizedDiscoveredPath = this.normalizeWorkspacePath(
      discoveredWorkspacePath,
    );
    const normalizedRequestedPath = this.normalizeWorkspacePath(
      requestedWorkspacePath,
    );

    if (!normalizedDiscoveredPath || !normalizedRequestedPath) {
      return false;
    }

    return normalizedDiscoveredPath === normalizedRequestedPath;
  }

  private normalizeWorkspacePath(
    workspacePath: string | undefined,
  ): string | undefined {
    const trimmedPath = workspacePath?.trim() ?? "";
    if (!trimmedPath) {
      return undefined;
    }

    const hasDrivePrefix = /^[a-zA-Z]:[/\\]/.test(trimmedPath);
    const withoutTrailingSlash = trimmedPath.replace(/[\\/]+$/, "");
    const absolutePath =
      hasDrivePrefix || withoutTrailingSlash.startsWith("/")
        ? withoutTrailingSlash
        : resolve(withoutTrailingSlash);
    const normalizedSeparators = absolutePath.replace(/\\/g, "/");
    const normalizedPath =
      normalizedSeparators.length > 1
        ? normalizedSeparators.replace(/\/+$/, "")
        : normalizedSeparators;

    if (process.platform === "win32" || process.platform === "darwin") {
      return normalizedPath.toLowerCase();
    }

    return normalizedPath;
  }

  private resolveWorkspaceName(
    workspacePath: string | undefined,
    fallbackName: string,
  ): string {
    if (!workspacePath) {
      return fallbackName;
    }

    const normalizedPath = workspacePath.trim().replace(/[\\/]+$/, "");
    return basename(normalizedPath) || fallbackName;
  }

  private runTmux(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      this.runExecFile("tmux", args, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve(stdout.toString());
      });
    });
  }

  private isTmuxUnavailable(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const execError = error as ExecError;
    const message =
      `${execError.message} ${execError.stderr ?? ""}`.toLowerCase();
    return (
      execError.code === "ENOENT" ||
      (message.includes("tmux") && message.includes("not found"))
    );
  }

  private isNoSessionsError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const execError = error as ExecError;
    const message =
      `${execError.message} ${execError.stderr ?? ""}`.toLowerCase();
    return (
      message.includes("no server running") ||
      message.includes("failed to connect to server") ||
      message.includes("no sessions")
    );
  }
}
