import { connect } from "net";
import { execFile, spawn as nodeSpawn } from "child_process";
import { rmSync } from "fs";
import type { Readable } from "stream";
import type { HerdrSocketForward } from "./types";

export interface HerdrSshForwardChild {
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type HerdrSshSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ["ignore", "ignore", "pipe"] },
) => HerdrSshForwardChild;

export interface HerdrSshForwardOptions {
  readonly target: string;
  readonly localApiSocket: string;
  readonly localClientSocket: string;
  readonly spawnFn?: HerdrSshSpawn;
  readonly homeQuery?: () => Promise<string>;
  readonly readinessTimeoutMs?: number;
}

export interface HerdrSshForwardPaths {
  readonly remoteApiSocket: string;
  readonly remoteClientSocket: string;
}

const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const READINESS_POLL_MS = 100;
const MAX_SSH_DIAGNOSTIC_CHARS = 512;

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { readonly stdio: readonly ["ignore", "ignore", "pipe"] },
): HerdrSshForwardChild {
  return nodeSpawn(command, [...args], {
    stdio: [...options.stdio],
  }) as unknown as HerdrSshForwardChild;
}

function tryConnect(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

export class HerdrSshForward {
  private readonly options: HerdrSshForwardOptions;
  private child: HerdrSshForwardChild | undefined;
  private disposed = false;

  public constructor(options: HerdrSshForwardOptions) {
    this.options = options;
  }

  public static buildArgs(
    paths: HerdrSshForwardPaths,
    target: string,
    localApiSocket: string,
    localClientSocket: string,
  ): string[] {
    return [
      "-nNT",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${localApiSocket}:${paths.remoteApiSocket}`,
      "-L",
      `${localClientSocket}:${paths.remoteClientSocket}`,
      target,
    ];
  }

  public async start(): Promise<HerdrSocketForward> {
    const home = (await this.resolveRemoteHome()).replace(/\/+$/, "");
    if (this.disposed) {
      throw new Error(
        `Herdr ssh forward to "${this.options.target}" was disposed during startup.`,
      );
    }
    const paths: HerdrSshForwardPaths = {
      remoteApiSocket: `${home}/.config/herdr/herdr.sock`,
      remoteClientSocket: `${home}/.config/herdr/herdr-client.sock`,
    };
    const spawnFn = this.options.spawnFn ?? defaultSpawn;
    const child = spawnFn(
      "ssh",
      HerdrSshForward.buildArgs(
        paths,
        this.options.target,
        this.options.localApiSocket,
        this.options.localClientSocket,
      ),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    this.child = child;

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_SSH_DIAGNOSTIC_CHARS);
    });

    const readinessTimeoutMs =
      this.options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      if (readinessTimer !== undefined) {
        clearTimeout(readinessTimer);
      }
    };
    const failed = new Promise<never>((_, reject) => {
      child.on("exit", (code) => {
        stop();
        this.dispose();
        reject(
          new Error(
            `Herdr ssh forward to "${this.options.target}" failed (exit code ${code ?? "unknown"}): ${stderr.trim()}`,
          ),
        );
      });
      child.on("error", (error) => {
        stop();
        this.dispose();
        reject(
          new Error(
            `Herdr ssh forward to "${this.options.target}" failed: ${error.message}`,
          ),
        );
      });
      readinessTimer = setTimeout(() => {
        stop();
        this.dispose();
        reject(
          new Error(
            `Herdr ssh forward to "${this.options.target}" did not become ready within ${readinessTimeoutMs} ms. ${stderr.trim()}`,
          ),
        );
      }, readinessTimeoutMs);
    });

    const ready = new Promise<void>((resolve) => {
      const attempt = (): void => {
        if (settled) {
          return;
        }
        Promise.all([
          tryConnect(this.options.localApiSocket),
          tryConnect(this.options.localClientSocket),
        ]).then(
          () => {
            stop();
            resolve();
          },
          () => undefined,
        );
      };
      attempt();
      pollTimer = setInterval(attempt, READINESS_POLL_MS);
      child.on("exit", stop);
      child.on("error", stop);
    });

    try {
      await Promise.race([ready, failed]);
    } catch (error) {
      stop();
      this.dispose();
      throw error;
    } finally {
      stop();
    }

    return {
      apiSocketPath: this.options.localApiSocket,
      clientSocketPath: this.options.localClientSocket,
    };
  }

  public dispose(): void {
    this.disposed = true;
    this.child?.kill("SIGTERM");
    this.child = undefined;
    rmSync(this.options.localApiSocket, { force: true });
    rmSync(this.options.localClientSocket, { force: true });
  }

  private resolveRemoteHome(): Promise<string> {
    if (this.options.homeQuery) {
      return this.options.homeQuery();
    }
    return new Promise((resolve, reject) => {
      execFile(
        "ssh",
        [this.options.target, "printf", "%s", "$HOME"],
        { timeout: 10_000, encoding: "utf8" },
        (error, stdout, stderr) => {
          const home = stdout.trim();
          if (error || home === "") {
            reject(
              new Error(
                `could not resolve the remote home directory: ${stderr || error?.message || "empty output"}`,
              ),
            );
            return;
          }
          resolve(home);
        },
      );
    });
  }
}
