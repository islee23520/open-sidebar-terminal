import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "child_process";
import { StringDecoder } from "string_decoder";
import * as vscode from "vscode";
import type {
  TerminalTransport,
  TerminalTransportExitReason,
} from "../terminals/TerminalTransport";
import type { HerdrScrollGesture } from "../types";
import type { HerdrInvocation, HerdrTimers } from "./types";

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 5_000;
const DEFAULT_RELEASE_GRACE_MS = 2_000;
const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 512;

export interface HerdrControlChild {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly kill: (signal?: NodeJS.Signals | number) => boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type HerdrControlSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
  },
) => HerdrControlChild;

export interface HerdrControlTransportOptions {
  readonly invocation: HerdrInvocation;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  readonly spawnFn?: HerdrControlSpawn;
  readonly timers?: HerdrTimers;
  readonly firstFrameTimeoutMs?: number;
  readonly releaseGraceMs?: number;
  readonly maxRecordBytes?: number;
}

interface TerminalFrameRecord {
  readonly type: "terminal.frame";
  readonly bytes: string;
  readonly encoding: "ansi";
  readonly full: boolean;
  readonly width: number;
  readonly height: number;
  readonly seq: number;
}

interface TerminalClosedRecord {
  readonly type: "terminal.closed";
  readonly reason: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export class HerdrControlTransport implements TerminalTransport {
  public readonly kind = "herdr-control" as const;

  private readonly outputEmitter = new vscode.EventEmitter<{
    data: string;
    replay: "append" | "replace";
  }>();
  private readonly exitEmitter = new vscode.EventEmitter<{
    reason: TerminalTransportExitReason;
    message?: string;
  }>();
  private readonly timers: HerdrTimers;
  private readonly releaseGraceMs: number;
  private readonly maxRecordBytes: number;
  private readonly child: HerdrControlChild;
  private readonly lineDecoder = new StringDecoder("utf8");
  private frameDecoder = new StringDecoder("utf8");
  private line = "";
  private lineBytes = 0;
  private stderr = "";
  private firstFrameTimer: TimerHandle | undefined;
  private releaseTimer: TimerHandle | undefined;
  private exitEmitted = false;
  private childExited = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private cols: number;
  private rows: number;

  public readonly onOutput = this.outputEmitter.event;
  public readonly onExit = this.exitEmitter.event;

  public constructor(options: HerdrControlTransportOptions) {
    this.timers = options.timers ?? {
      setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
      clearTimeout: (handle) => clearTimeout(handle),
    };
    this.releaseGraceMs =
      options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS;
    this.maxRecordBytes =
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.cols = options.cols;
    this.rows = options.rows;
    const firstFrameTimeoutMs =
      options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS;

    const spawnFn = options.spawnFn ?? defaultSpawn;
    const args = [
      ...options.invocation.argsPrefix,
      "terminal",
      "session",
      "control",
      options.terminalId,
      "--takeover",
      "--cols",
      String(options.cols),
      "--rows",
      String(options.rows),
    ];

    try {
      this.child = spawnFn(options.invocation.command, args, {
        env: options.invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.child = createFailedChild();
      queueMicrotask(() => this.fail("spawn-error", this.errorMessage(error)));
      return;
    }

    this.child.stdout.on("data", (chunk: Buffer | string) => {
      this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = boundedAppend(this.stderr, chunk.toString(), MAX_DIAGNOSTIC_CHARS);
    });
    this.child.stdin.on("error", (error) => {
      if (isObject(error) && error.code === "EPIPE" && (this.closing || this.exitEmitted)) {
        return;
      }
      this.fail(
        "protocol-error",
        `Failed to write Herdr command: ${this.errorMessage(error)}`,
      );
    });
    this.child.on("error", (error) => {
      this.fail("spawn-error", this.errorMessage(error));
    });
    this.child.on("exit", (code, signal) => {
      this.childExited = true;
      this.clearReleaseTimer();
      this.resolvePendingClose();
      if (!this.exitEmitted) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        this.emitExit("process-exit", this.withStderr(detail));
      }
    });

    this.firstFrameTimer = this.timers.setTimeout(() => {
      this.fail(
        "timeout",
        `Herdr did not send a full terminal frame within ${firstFrameTimeoutMs} ms.`,
      );
    }, firstFrameTimeoutMs);
  }

  public write(data: string): void {
    if (data.length === 0) {
      throw new Error("Herdr terminal input must be non-empty.");
    }
    this.send({
      type: "terminal.input",
      bytes: Buffer.from(data, "utf8").toString("base64"),
    });
  }

  public scroll(gesture: HerdrScrollGesture): void {
    this.send({
      type: "terminal.scroll",
      direction: gesture.direction,
      lines: gesture.lines,
      source: gesture.source,
      column: gesture.column,
      row: gesture.row,
      modifiers: gesture.modifiers,
    });
    this.send({ type: "terminal.resize", cols: this.cols, rows: this.rows });
  }

  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.send({ type: "terminal.resize", cols, rows });
  }

  public close(reason: "release" | "shutdown"): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
    this.closing = true;

    if (this.childExited) {
      this.resolvePendingClose();
      return this.closePromise;
    }

    this.send({ type: "terminal.release" });
    if (reason === "shutdown") {
      this.forceKill();
      this.resolvePendingClose();
      return this.closePromise;
    }

    this.releaseTimer = this.timers.setTimeout(() => {
      this.forceKill();
      this.resolvePendingClose();
    }, this.releaseGraceMs);
    return this.closePromise;
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.exitEmitted) {
      return;
    }
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }
      if (!this.appendLineBytes(chunk.subarray(start, index))) {
        return;
      }
      this.processLine(this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line);
      this.line = "";
      this.lineBytes = 0;
      start = index + 1;
      if (this.exitEmitted) {
        return;
      }
    }
    this.appendLineBytes(chunk.subarray(start));
  }

  private appendLineBytes(bytes: Buffer): boolean {
    this.lineBytes += bytes.length;
    if (this.lineBytes > this.maxRecordBytes) {
      this.fail(
        "protocol-error",
        `Herdr control record exceeded the ${this.maxRecordBytes}-byte limit before parsing.`,
      );
      return false;
    }
    this.line += this.lineDecoder.write(bytes);
    return true;
  }

  private processLine(line: string): void {
    if (line.length === 0) {
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      this.fail(
        "protocol-error",
        `Malformed Herdr control JSON: ${this.errorMessage(error)}; record=${bounded(line)}`,
      );
      return;
    }

    if (!isObject(record) || typeof record.type !== "string") {
      this.fail("protocol-error", `Invalid Herdr control record: ${bounded(line)}`);
      return;
    }
    if (record.type === "terminal.frame") {
      if (!isFrameRecord(record)) {
        this.fail("protocol-error", `Invalid terminal.frame record: ${bounded(line)}`);
        return;
      }
      this.handleFrame(record);
      return;
    }
    if (record.type === "terminal.closed") {
      if (!isClosedRecord(record)) {
        this.fail("protocol-error", `Invalid terminal.closed record: ${bounded(line)}`);
        return;
      }
      this.handleClosed(record.reason);
      return;
    }
    this.fail(
      "protocol-error",
      `Unknown Herdr control record type ${JSON.stringify(record.type)}: ${bounded(line)}`,
    );
  }

  private handleFrame(record: TerminalFrameRecord): void {
    if (record.full) {
      this.frameDecoder = new StringDecoder("utf8");
      this.clearFirstFrameTimer();
    }
    const bytes = decodeBase64(record.bytes);
    if (!bytes) {
      this.fail("protocol-error", "terminal.frame bytes are not valid base64.");
      return;
    }
    this.outputEmitter.fire({
      data: this.frameDecoder.write(bytes),
      replay: record.full ? "replace" : "append",
    });
  }

  private handleClosed(reason: string): void {
    // Herdr 0.8.x closure mapping: detach is a normal release, controller
    // displacement is takeover, missing targets are pane exits, and all other
    // server-side closure diagnostics are classified as server-stopped.
    let mapped: TerminalTransportExitReason;
    if (reason === "detached") {
      mapped = "released";
    } else if (reason === "terminal attach taken over") {
      mapped = "takeover";
    } else if (reason === "not found") {
      mapped = "pane-exited";
    } else {
      mapped = "server-stopped";
    }
    this.emitExit(mapped);
  }

  private send(command: object): void {
    if (this.childExited) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      this.fail("protocol-error", `Failed to write Herdr command: ${this.errorMessage(error)}`);
    }
  }

  private fail(reason: TerminalTransportExitReason, message: string): void {
    if (this.exitEmitted) {
      return;
    }
    this.emitExit(reason, this.withStderr(message));
    this.forceKill();
    this.resolvePendingClose();
  }

  private emitExit(reason: TerminalTransportExitReason, message?: string): void {
    if (this.exitEmitted) {
      return;
    }
    this.exitEmitted = true;
    this.clearFirstFrameTimer();
    this.clearReleaseTimer();
    this.exitEmitter.fire(message ? { reason, message } : { reason });
  }

  private forceKill(): void {
    if (!this.childExited) {
      this.child.kill("SIGKILL");
    }
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer !== undefined) {
      this.timers.clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
    }
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer !== undefined) {
      this.timers.clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
  }

  private resolvePendingClose(): void {
    const resolve = this.resolveClose;
    this.resolveClose = undefined;
    resolve?.();
  }

  private withStderr(message: string): string {
    return this.stderr ? `${message} stderr=${bounded(this.stderr)}` : message;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

const defaultSpawn: HerdrControlSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFrameRecord(
  record: Record<string, unknown>,
): record is Record<string, unknown> & TerminalFrameRecord {
  return (
    record.type === "terminal.frame" &&
    typeof record.bytes === "string" &&
    record.encoding === "ansi" &&
    typeof record.full === "boolean" &&
    Number.isInteger(record.width) &&
    Number.isInteger(record.height) &&
    Number.isInteger(record.seq)
  );
}

function isClosedRecord(
  record: Record<string, unknown>,
): record is Record<string, unknown> & TerminalClosedRecord {
  return record.type === "terminal.closed" && typeof record.reason === "string";
}

function decodeBase64(value: string): Buffer | undefined {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "base64");
}

function bounded(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_CHARS
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_CHARS)}...`;
}

function boundedAppend(current: string, next: string, limit: number): string {
  return bounded(`${current}${next}`).slice(0, limit + 3);
}

function createFailedChild(): HerdrControlChild {
  let child: HerdrControlChild;
  const stream = {
    on: () => stream,
    write: () => false,
  } as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
  child = {
    stdin: stream,
    stdout: stream,
    stderr: stream,
    kill: () => false,
    on: () => child,
  };
  return child;
}
