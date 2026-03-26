import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { TmuxSession, TreeSnapshot } from "../webview/sidebar/types";

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

export class TmuxUnavailableError extends Error {
  constructor(message: string = "tmux is not installed") {
    super(message);
    this.name = "TmuxUnavailableError";
  }
}

export interface EnsureTmuxSessionResult {
  action: "attached" | "created";
  session: TmuxSession;
}

export class TmuxSessionManager {
  constructor(
    private readonly runExecFile: ExecFileLike = (file, args, callback) => {
      execFile(file, args, callback as never);
    },
  ) {}

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
    const exactWorkspaceMatches = discoveredSessions.filter((entry) =>
      this.pathsMatch(entry.workspacePath, workspacePath),
    );

    const existingSession = this.pickPreferredSession(
      exactWorkspaceMatches,
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
    } catch (error) {
      if (this.isTmuxUnavailable(error)) {
        throw new TmuxUnavailableError();
      }

      throw error;
    }
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
    preferredName: string,
  ): TmuxSession | undefined {
    if (discoveredSessions.length === 0) {
      return undefined;
    }

    const exactNameMatch = discoveredSessions.find(
      ({ session }) =>
        session.id === preferredName || session.name === preferredName,
    );
    if (exactNameMatch) {
      return exactNameMatch.session;
    }

    return discoveredSessions
      .slice()
      .sort((a, b) => a.session.id.localeCompare(b.session.id))[0]?.session;
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
