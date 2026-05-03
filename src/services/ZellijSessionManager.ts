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

export class ZellijSessionManager {
  public constructor(
    _logger?: ILogger,
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

  private async runZellij(args: string[], cwd?: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      this.runExecFile("zellij", args, cwd ? { cwd } : {}, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
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
    return /no sessions|not found/i.test(stderr) || /no sessions/i.test(error.message);
  }

  private isZellijUnavailable(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const execError = error as ExecError;
    const text = `${execError.message} ${execError.stderr ?? ""}`.toLowerCase();
    return execError.code === "ENOENT" || text.includes("enoent");
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
