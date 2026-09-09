import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrAttachTarget } from "./HerdrAttachController";
import {
  HerdrNotInstalledError,
  HerdrProtocolError,
  HerdrServerDownError,
  HerdrUnsupportedVersionError,
} from "./errors";
import type {
  HerdrAgent,
  HerdrCommandResult,
  HerdrCommandRunner,
  HerdrInvocation,
  HerdrSpace,
  HerdrTimers,
} from "./types";

const COMMAND_TIMEOUT_MS = 5_000;
const MAX_AGENTS = 1_000;
const MAX_WORKSPACES = 1_000;
const MINIMUM_VERSION = [0, 8, 0] as const;
const SERVER_UNREACHABLE =
  /(?:failed|unable|cannot) to connect|connection refused|server (?:is )?(?:unavailable|not running|unreachable)/i;

interface HerdrCliClientOptions {
  readonly run: HerdrCommandRunner;
  readonly invocation: HerdrInvocation;
  readonly timers?: HerdrTimers;
  readonly localDagMetadata?: boolean;
}

interface AgentListEnvelope {
  readonly result: {
    readonly agents: unknown[];
  };
}

interface WorkspaceListEnvelope {
  readonly result: {
    readonly workspaces: unknown[];
  };
}

const defaultTimers: HerdrTimers = {
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class HerdrCliClient {
  private readonly run: HerdrCommandRunner;
  private readonly invocation: HerdrInvocation;
  private readonly timers: HerdrTimers;
  private readonly localDagMetadata: boolean;

  public constructor(options: HerdrCliClientOptions) {
    this.run = options.run;
    this.invocation = options.invocation;
    this.timers = options.timers ?? defaultTimers;
    this.localDagMetadata = options.localDagMetadata ?? true;
  }

  public async findDagPane(parentPane: string): Promise<HerdrAttachTarget | undefined> {
    const home = this.invocation.env.HOME ?? this.invocation.env.USERPROFILE;
    const directory = this.invocation.env.OMO_HERDR_DAG_STATE_DIR ?? (home ? join(home, ".omo", "agent", "herdr-dag") : undefined);
    if (!this.localDagMetadata || directory === undefined) {
      return undefined;
    }
    const status = await this.execute(["status", "--json"]);
    this.throwForFailure(status, "status");
    const endpoint: unknown = JSON.parse(status.stdout);
    if (!this.isRecord(endpoint) || !this.isRecord(endpoint.server) || typeof endpoint.server.socket !== "string") {
      throw new HerdrProtocolError(this.invocation.displayEndpoint, "status did not contain server.socket");
    }
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (this.isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    const candidates: Array<{ key: string; updatedAt: string }> = [];
    for (const file of files.filter((name) => /^[a-f0-9]{24}\.json$/.test(name))) {
      const key = file.slice(0, 24);
      try {
        const state: unknown = JSON.parse(await readFile(join(directory, `${key}.json`), "utf8"));
        if (!this.isRecord(state) || typeof state.sessionId !== "string" || state.connected !== true) continue;
        const expected = createHash("sha256").update(JSON.stringify([endpoint.server.socket, parentPane, state.sessionId])).digest("hex").slice(0, 24);
        if (expected !== key) continue;
        candidates.push({ key, updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "" });
      } catch (error) {
        if (error instanceof SyntaxError || (this.isRecord(error) && error.code === "ENOENT")) continue;
        throw error;
      }
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const candidate = candidates[0];
    if (!candidate) return undefined;
    let record: unknown;
    try {
      record = JSON.parse(await readFile(join(directory, `${candidate.key}.pane.json`), "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || (this.isRecord(error) && error.code === "ENOENT")) return undefined;
      throw error;
    }
    if (!this.isRecord(record) || record.ready !== true || typeof record.paneId !== "string") return undefined;
    const result = await this.execute(["pane", "get", record.paneId]);
    if (result.code !== 0 && /pane_not_found|unknown pane|pane .*not found/i.test(`${result.stdout} ${result.stderr}`)) return undefined;
    this.throwForFailure(result, "DAG pane get");
    const parsed: unknown = JSON.parse(result.stdout);
    if (!this.isRecord(parsed) || !this.isRecord(parsed.result) || !this.isRecord(parsed.result.pane) || parsed.result.pane.pane_id !== record.paneId || typeof parsed.result.pane.terminal_id !== "string") {
      throw new HerdrProtocolError(this.invocation.displayEndpoint, "DAG pane get returned an invalid pane");
    }
    return { terminalId: parsed.result.pane.terminal_id, label: "DAG" };
  }

  public async versionCheck(): Promise<{ readonly version: string }> {
    const result = await this.execute(["--version"]);
    this.throwForFailure(result, "version check");

    const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/.exec(
      `${result.stdout}\n${result.stderr}`,
    );
    if (!match) {
      throw new HerdrProtocolError(
        this.invocation.displayEndpoint,
        "the version output did not contain a semantic version",
      );
    }

    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (this.compareVersion(parts, MINIMUM_VERSION) < 0) {
      throw new HerdrUnsupportedVersionError(
        this.invocation.displayEndpoint,
        version,
      );
    }
    return { version };
  }

  public async listAgents(): Promise<readonly HerdrAgent[]> {
    const result = await this.execute(["agent", "list"]);
    this.throwForFailure(result, "agent list");

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new HerdrProtocolError(
        this.invocation.displayEndpoint,
        "agent list was not valid JSON",
        error,
      );
    }

    if (!this.isAgentListEnvelope(parsed)) {
      throw new HerdrProtocolError(
        this.invocation.displayEndpoint,
        "agent list did not contain result.agents",
      );
    }
    if (parsed.result.agents.length > MAX_AGENTS) {
      throw new HerdrProtocolError(
        this.invocation.displayEndpoint,
        `agent list exceeded the ${MAX_AGENTS}-agent limit`,
      );
    }

    return parsed.result.agents.map((row, index) => this.mapAgent(row, index));
  }

  public async listWorkspaces(): Promise<readonly HerdrSpace[]> {
    const result = await this.execute(["workspace", "list"]);
    this.throwForFailure(result, "workspace list");

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new HerdrProtocolError(
        this.invocation.displayEndpoint,
        "workspace list was not valid JSON",
        error,
      );
    }

    if (!this.isWorkspaceListEnvelope(parsed)) {
      throw new HerdrProtocolError(
        this.invocation.displayEndpoint,
        "workspace list did not contain result.workspaces",
      );
    }
    if (parsed.result.workspaces.length > MAX_WORKSPACES) {
      throw new HerdrProtocolError(
        this.invocation.displayEndpoint,
        `workspace list exceeded the ${MAX_WORKSPACES}-workspace limit`,
      );
    }

    return parsed.result.workspaces.map((row, index) =>
      this.mapWorkspace(row, index),
    );
  }

  private async execute(args: readonly string[]): Promise<HerdrCommandResult> {
    const commandArgs = [...this.invocation.argsPrefix, ...args];
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = this.timers.setTimeout(() => {
        reject(
          new HerdrServerDownError(
            this.invocation.displayEndpoint,
            `command timed out after ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.run(
          this.invocation.command,
          commandArgs,
          this.invocation.env,
          COMMAND_TIMEOUT_MS,
        ),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof HerdrServerDownError) {
        throw error;
      }
      if (this.isMissingExecutable(error)) {
        throw new HerdrNotInstalledError(
          this.invocation.displayEndpoint,
          this.invocation.command,
          error,
        );
      }
      throw new HerdrServerDownError(
        this.invocation.displayEndpoint,
        this.errorDetail(error),
        error,
      );
    } finally {
      if (timeoutHandle !== undefined) {
        this.timers.clearTimeout(timeoutHandle);
      }
    }
  }

  private throwForFailure(
    result: HerdrCommandResult,
    operation: string,
  ): void {
    if (result.code === 127) {
      throw new HerdrNotInstalledError(
        this.invocation.displayEndpoint,
        this.invocation.command,
      );
    }
    const output = `${result.stderr}\n${result.stdout}`.trim();
    if (result.code !== 0 || SERVER_UNREACHABLE.test(output)) {
      throw new HerdrServerDownError(
        this.invocation.displayEndpoint,
        output || `${operation} exited with code ${result.code}`,
      );
    }
  }

  private isAgentListEnvelope(value: unknown): value is AgentListEnvelope {
    if (!this.isRecord(value) || !this.isRecord(value.result)) {
      return false;
    }
    return Array.isArray(value.result.agents);
  }

  private isWorkspaceListEnvelope(value: unknown): value is WorkspaceListEnvelope {
    if (!this.isRecord(value) || !this.isRecord(value.result)) {
      return false;
    }
    return Array.isArray(value.result.workspaces);
  }

  private mapAgent(value: unknown, index: number): HerdrAgent {
    if (!this.isRecord(value)) {
      throw this.invalidAgent(index);
    }

    const paneId = value.pane_id;
    const terminalId = value.terminal_id;
    const agent = value.agent;
    const status = value.agent_status;
    const workspaceId = value.workspace_id;
    if (
      typeof paneId !== "string" ||
      typeof terminalId !== "string" ||
      typeof agent !== "string" ||
      typeof status !== "string" ||
      typeof workspaceId !== "string"
    ) {
      throw this.invalidAgent(index);
    }
    return {
      paneId,
      terminalId,
      agent,
      status,
      title: typeof value.terminal_title_stripped === "string" ? value.terminal_title_stripped : "",
      cwd: typeof value.cwd === "string" ? value.cwd : "",
      workspaceId,
    };
  }

  private mapWorkspace(value: unknown, index: number): HerdrSpace {
    if (!this.isRecord(value)) {
      throw this.invalidWorkspace(index);
    }
    const workspaceId = value.workspace_id;
    const label = value.label;
    const status = value.agent_status;
    const paneCount = value.pane_count;
    if (
      typeof workspaceId !== "string" ||
      typeof label !== "string" ||
      typeof status !== "string" ||
      typeof paneCount !== "number"
    ) {
      throw this.invalidWorkspace(index);
    }
    return { workspaceId, label, status, paneCount };
  }

  private invalidWorkspace(index: number): HerdrProtocolError {
    return new HerdrProtocolError(
      this.invocation.displayEndpoint,
      `workspace at index ${index} was missing a required field`,
    );
  }

  private invalidAgent(index: number): HerdrProtocolError {
    return new HerdrProtocolError(
      this.invocation.displayEndpoint,
      `agent at index ${index} was missing a required string field`,
    );
  }

  private compareVersion(
    left: readonly number[],
    right: readonly number[],
  ): number {
    for (let index = 0; index < 3; index += 1) {
      const difference = left[index] - right[index];
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  }

  private isMissingExecutable(error: unknown): boolean {
    return (
      this.isRecord(error) &&
      (error.code === "ENOENT" || error.code === 127)
    );
  }

  private errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
