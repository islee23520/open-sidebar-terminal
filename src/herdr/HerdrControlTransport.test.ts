import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  HerdrControlTransport,
  type HerdrControlChild,
  type HerdrControlSpawn,
} from "./HerdrControlTransport";
import { HerdrInvocationResolver } from "./HerdrInvocationResolver";

class FakeChild extends EventEmitter implements HerdrControlChild {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdinChunks: string[] = [];
  public readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinChunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  public readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

const invocation = HerdrInvocationResolver.resolve({
  executablePath: "/opt/herdr",
  session: "team",
  socketPath: undefined,
  env: { PATH: "/bin" },
  platform: "darwin",
});

function frame(data: string, full: boolean, seq: number): string {
  return `${JSON.stringify({
    type: "terminal.frame",
    bytes: Buffer.from(data, "utf8").toString("base64"),
    encoding: "ansi",
    full,
    width: 80,
    height: 24,
    seq,
    label: "가나다",
  })}\n`;
}

function setup(overrides: Partial<ConstructorParameters<typeof HerdrControlTransport>[0]> = {}) {
  const child = new FakeChild();
  const spawnFn = vi.fn<HerdrControlSpawn>(() => child);
  const transport = new HerdrControlTransport({
    invocation,
    terminalId: "terminal-123",
    cols: 80,
    rows: 24,
    spawnFn,
    timers: {
      setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    ...overrides,
  });
  const output: Array<{ data: string; replay: "append" | "replace" }> = [];
  const exits: Array<{ reason: string; message?: string }> = [];
  transport.onOutput((event) => output.push(event));
  transport.onExit((event) => exits.push(event));
  return { child, spawnFn, transport, output, exits };
}

function commands(child: FakeChild): unknown[] {
  return child.stdinChunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("HerdrControlTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("decodes frames and encodes input resize scroll release", async () => {
    vi.useFakeTimers();
    const { child, spawnFn, transport, output, exits } = setup();

    const full = frame("초기 가나다", true, 1);
    const splitAt = Buffer.from(full).indexOf(Buffer.from("가")) + 1;
    const bytes = Buffer.from(full);
    child.stdout.write(bytes.subarray(0, splitAt));
    child.stdout.write(bytes.subarray(splitAt));
    child.stdout.write(frame(" + delta", false, 2));

    expect(output).toEqual([
      { data: "초기 가나다", replay: "replace" },
      { data: " + delta", replay: "append" },
    ]);

    transport.write("ls\r");
    transport.write("\x1b[<64;4;7M");
    transport.write("\x1b[<65;8;9M");
    transport.write("\x1b[5~");
    transport.write("\x1b[6~");
    transport.write("\x1b[?unknown");
    transport.resize(100, 40);
    transport.write("\x1b[5~");
    const closing = transport.close("release");

    expect(commands(child)).toEqual([
      {
        type: "terminal.input",
        bytes: Buffer.from("ls\r", "utf8").toString("base64"),
      },
      {
        type: "terminal.input",
        bytes: Buffer.from("\x1b[<64;4;7M", "utf8").toString("base64"),
      },
      {
        type: "terminal.input",
        bytes: Buffer.from("\x1b[<65;8;9M", "utf8").toString("base64"),
      },
      {
        type: "terminal.input",
        bytes: Buffer.from("\x1b[5~", "utf8").toString("base64"),
      },
      {
        type: "terminal.input",
        bytes: Buffer.from("\x1b[6~", "utf8").toString("base64"),
      },
      {
        type: "terminal.input",
        bytes: Buffer.from("\x1b[?unknown", "utf8").toString("base64"),
      },
      { type: "terminal.resize", cols: 100, rows: 40 },
      {
        type: "terminal.input",
        bytes: Buffer.from("\x1b[5~", "utf8").toString("base64"),
      },
      { type: "terminal.release" },
    ]);
    const input = commands(child)[0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["bytes", "type"]);

    child.stdout.write(
      `${JSON.stringify({ type: "terminal.closed", reason: "detached" })}\n`,
    );
    child.emit("exit", 0, null);
    await closing;
    expect(exits).toEqual([{ reason: "released" }]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledWith(
      "/opt/herdr",
      [
        "--session",
        "team",
        "terminal",
        "session",
        "control",
        "terminal-123",
        "--takeover",
        "--cols",
        "80",
        "--rows",
        "24",
      ],
      { env: { PATH: "/bin" }, stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  test("spawn inherits the ssh forward sockets through the invocation env", () => {
    const forwardInvocation = HerdrInvocationResolver.resolve({
      executablePath: "/opt/herdr",
      session: "team",
      remoteTarget: "u@h",
      forwardSockets: {
        apiSocketPath: "/tmp/f.sock",
        clientSocketPath: "/tmp/f-client.sock",
      },
      socketPath: undefined,
      env: { PATH: "/bin" },
      platform: "darwin",
    });
    const { spawnFn } = setup({ invocation: forwardInvocation });

    expect(spawnFn).toHaveBeenCalledWith(
      "/opt/herdr",
      [
        "terminal",
        "session",
        "control",
        "terminal-123",
        "--takeover",
        "--cols",
        "80",
        "--rows",
        "24",
      ],
      {
        env: {
          PATH: "/bin",
          HERDR_SOCKET_PATH: "/tmp/f.sock",
          HERDR_CLIENT_SOCKET_PATH: "/tmp/f-client.sock",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  });

  test("scroll sends terminal.scroll then same-size resize checkpoint", () => {
    const { child, transport } = setup();
    child.stdout.write(frame("ready", true, 1));

    transport.scroll({
      direction: "up",
      lines: 3,
      source: "wheel",
      column: 4,
      row: 7,
      modifiers: 0,
    });
    transport.resize(100, 40);
    transport.scroll({
      direction: "down",
      lines: 14,
      source: "page_key",
      column: 0,
      row: 0,
      modifiers: 0,
    });

    expect(commands(child)).toEqual([
      {
        type: "terminal.scroll",
        direction: "up",
        lines: 3,
        source: "wheel",
        column: 4,
        row: 7,
        modifiers: 0,
      },
      { type: "terminal.resize", cols: 80, rows: 24 },
      { type: "terminal.resize", cols: 100, rows: 40 },
      {
        type: "terminal.scroll",
        direction: "down",
        lines: 14,
        source: "page_key",
        column: 0,
        row: 0,
        modifiers: 0,
      },
      { type: "terminal.resize", cols: 100, rows: 40 },
    ]);
  });

  test("preserves UTF-8 code points split across decoded frame boundaries", () => {
    const { child, output } = setup();
    const utf8 = Buffer.from("가나다", "utf8");
    child.stdout.write(
      frame(utf8.subarray(0, 4).toString("binary"), true, 1).replace(
        Buffer.from(utf8.subarray(0, 4).toString("binary"), "utf8").toString("base64"),
        utf8.subarray(0, 4).toString("base64"),
      ),
    );
    child.stdout.write(
      frame(utf8.subarray(4).toString("binary"), false, 2).replace(
        Buffer.from(utf8.subarray(4).toString("binary"), "utf8").toString("base64"),
        utf8.subarray(4).toString("base64"),
      ),
    );

    expect(output).toEqual([
      { data: "가", replay: "replace" },
      { data: "나다", replay: "append" },
    ]);
  });

  test("bounds records and terminates on protocol and timeout failures", async () => {
    vi.useFakeTimers();

    const oversized = setup();
    oversized.child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x78));
    expect(oversized.exits).toEqual([
      expect.objectContaining({ reason: "protocol-error" }),
    ]);
    expect(oversized.child.kill).toHaveBeenCalledWith("SIGKILL");

    const malformed = setup();
    malformed.child.stdout.write("{not-json}\n");
    expect(malformed.exits).toEqual([
      expect.objectContaining({ reason: "protocol-error" }),
    ]);

    const unknown = setup();
    unknown.child.stdout.write(`${JSON.stringify({ type: "future.record" })}\n`);
    expect(unknown.exits).toEqual([
      expect.objectContaining({ reason: "protocol-error" }),
    ]);

    const timeout = setup({ firstFrameTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(timeout.exits).toEqual([
      expect.objectContaining({ reason: "timeout" }),
    ]);
    expect(timeout.child.kill).toHaveBeenCalledWith("SIGKILL");

    const release = setup({ releaseGraceMs: 2_000 });
    const closing = release.transport.close("release");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(release.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release.child.kill).toHaveBeenCalledTimes(1);
    expect(release.child.kill).toHaveBeenCalledWith("SIGKILL");
    await closing;
  });

  test("maps spawn errors process exits closure reasons and emits exit once", () => {
    const spawnErrorEmitter = new EventEmitter();
    const spawnError = Object.assign(spawnErrorEmitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    }) as HerdrControlChild;
    const spawnFn = vi.fn<HerdrControlSpawn>(() => spawnError);
    const transport = new HerdrControlTransport({
      invocation,
      terminalId: "missing",
      cols: 80,
      rows: 24,
      spawnFn,
    });
    const spawnExits: unknown[] = [];
    transport.onExit((event) => spawnExits.push(event));
    spawnErrorEmitter.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    spawnErrorEmitter.emit("exit", -2, null);
    expect(spawnExits).toEqual([
      expect.objectContaining({ reason: "spawn-error" }),
    ]);

    const processExit = setup();
    processExit.child.emit("exit", 1, "SIGTERM");
    expect(processExit.exits).toEqual([
      expect.objectContaining({ reason: "process-exit" }),
    ]);

    const mappings = [
      ["detached", "released"],
      ["terminal attach taken over", "takeover"],
      ["not found", "pane-exited"],
      ["server restart", "server-stopped"],
    ] as const;
    for (const [closedReason, expected] of mappings) {
      const mapped = setup();
      mapped.child.stdout.write(
        `${JSON.stringify({ type: "terminal.closed", reason: closedReason })}\n`,
      );
      mapped.child.emit("exit", 0, null);
      expect(mapped.exits).toEqual([{ reason: expected }]);
    }
  });

  test("ignores stdin EPIPE after terminal closure while releasing", async () => {
    const { child, transport, exits } = setup();
    child.stdout.write(
      `${JSON.stringify({ type: "terminal.closed", reason: "not found" })}\n`,
    );

    const closing = transport.close("release");
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => child.stdin.emit("error", error)).not.toThrow();

    child.emit("exit", 0, null);
    await closing;
    expect(exits).toEqual([{ reason: "pane-exited" }]);
  });

  test("reports stdin EPIPE as a protocol error while active", () => {
    const { child, exits } = setup();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    expect(() => child.stdin.emit("error", error)).not.toThrow();
    expect(exits).toEqual([
      expect.objectContaining({
        reason: "protocol-error",
        message: expect.stringContaining("write EPIPE"),
      }),
    ]);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("guards empty input and shutdown releases then kills immediately", async () => {
    const { child, transport } = setup();
    expect(() => transport.write("")).toThrow(/non-empty/i);
    await transport.close("shutdown");
    expect(commands(child)).toEqual([{ type: "terminal.release" }]);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
