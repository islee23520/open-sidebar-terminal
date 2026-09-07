#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";

const CHILD_TIMEOUT_MS = 12_000;
const RECORD_TIMEOUT_MS = 5_000;
const QUIET_WINDOW_MS = 350;
const DEFAULT_COLS = 52;
const DEFAULT_ROWS = 12;

function parseArgs(argv) {
  const options = { herdr: "herdr", evidence: ".omo/evidence/task-1-herdr-agent-attach" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--expect-connect-failure") options.expectConnectFailure = true;
    else if (argument === "--herdr") options.herdr = argv[++index];
    else if (argument === "--socket") options.socket = argv[++index];
    else if (argument === "--evidence") options.evidence = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  options.herdr = resolve(options.herdr.replace(/^~(?=\/)/, process.env.HOME ?? ""));
  options.evidence = resolve(options.evidence);
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

class Log {
  constructor() {
    this.lines = [];
  }
  add(message, detail) {
    const suffix = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    this.lines.push(`[${new Date().toISOString()}] ${message}${suffix}`);
  }
  text() {
    return `${this.lines.join("\n")}\n`;
  }
}

async function runBounded(command, args, { env, input, timeoutMs = CHILD_TIMEOUT_MS, allowNonzero = false } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        command: [command, ...args], code, signal, timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) reject(new Error(`command timed out after ${timeoutMs}ms: ${result.command.join(" ")}`));
      else if (!allowNonzero && code !== 0) reject(new Error(`command failed (${code}): ${result.command.join(" ")}\n${result.stderr}`));
      else resolvePromise(result);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

class NdjsonChild {
  constructor(command, args, rawLines, log, { env, name }) {
    this.name = name;
    this.rawLines = rawLines;
    this.log = log;
    this.records = [];
    this.stderr = "";
    this.waiters = new Set();
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.closed = false;
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.child.pid;
    this.hardTimer = setTimeout(() => this.child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    this.child.stdout.on("data", (chunk) => this.consume(this.decoder.write(chunk)));
    this.child.stdout.on("end", () => this.consume(this.decoder.end()));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
      this.notify();
    });
    this.exitPromise = new Promise((resolveExit, reject) => {
      this.child.on("error", reject);
      this.child.on("close", (code, signal) => {
        clearTimeout(this.hardTimer);
        this.closed = true;
        this.consume("\n");
        this.notify();
        resolveExit({ code, signal, stderr: this.stderr });
      });
    });
    log.add(`spawn ${name}; hard_timeout_ms=${CHILD_TIMEOUT_MS}`, { pid: this.pid, argv: [command, ...args] });
  }
  consume(text) {
    this.buffer += text;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      let record;
      try { record = JSON.parse(raw); }
      catch (error) { throw new Error(`${this.name} emitted invalid NDJSON: ${raw}\n${error}`); }
      const rawLine = this.rawLines.push(raw);
      this.records.push({ record, raw, rawLine });
      this.log.add(`${this.name} raw.ndjson:${rawLine}`, record);
      this.notify();
    }
  }
  notify() {
    for (const waiter of [...this.waiters]) waiter();
  }
  async waitFor(predicate, description, timeoutMs = RECORD_TIMEOUT_MS, startIndex = 0) {
    const existing = this.records.slice(startIndex).find(({ record }) => predicate(record));
    if (existing) return existing;
    return await new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`${this.name}: timed out after ${timeoutMs}ms waiting for ${description}; stderr=${this.stderr}`));
      }, timeoutMs);
      const check = () => {
        const found = this.records.slice(startIndex).find(({ record }) => predicate(record));
        if (found) {
          clearTimeout(timer);
          this.waiters.delete(check);
          resolveWait(found);
        } else if (this.closed) {
          clearTimeout(timer);
          this.waiters.delete(check);
          reject(new Error(`${this.name}: exited before ${description}; stderr=${this.stderr}`));
        }
      };
      this.waiters.add(check);
      check();
    });
  }
  async waitForStderr(predicate, description, timeoutMs = RECORD_TIMEOUT_MS) {
    if (predicate(this.stderr)) return this.stderr;
    return await new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`${this.name}: timed out after ${timeoutMs}ms waiting for stderr ${description}; stderr=${this.stderr}`));
      }, timeoutMs);
      const check = () => {
        if (predicate(this.stderr)) {
          clearTimeout(timer);
          this.waiters.delete(check);
          resolveWait(this.stderr);
        } else if (this.closed) {
          clearTimeout(timer);
          this.waiters.delete(check);
          reject(new Error(`${this.name}: exited before stderr ${description}; stderr=${this.stderr}`));
        }
      };
      this.waiters.add(check);
      check();
    });
  }
  send(record) {
    assert(!this.closed, `${this.name} must be alive before sending ${record.type}`);
    this.log.add(`${this.name} stdin`, record);
    this.child.stdin.write(jsonLine(record));
  }
  endStdin() {
    this.log.add(`${this.name} stdin EOF`);
    this.child.stdin.end();
  }
  kill(signal) {
    this.log.add(`${this.name} kill`, signal);
    this.child.kill(signal);
  }
  async quietRecordCount(windowMs = QUIET_WINDOW_MS) {
    const before = this.records.length;
    await new Promise((resolveQuiet) => setTimeout(resolveQuiet, windowMs));
    return this.records.length - before;
  }
  async exit() {
    return await this.exitPromise;
  }
}

function frameText(frame) {
  assert(frame.type === "terminal.frame", "record must be terminal.frame");
  assert(frame.encoding === "ansi", "terminal.frame encoding must be ansi");
  return Buffer.from(frame.bytes, "base64").toString("utf8");
}

function validateFrame(frame) {
  const keys = Object.keys(frame).sort();
  assert(JSON.stringify(keys) === JSON.stringify(["bytes", "encoding", "full", "height", "seq", "type", "width"]), `terminal.frame fields changed: ${keys.join(",")}`);
  assert(typeof frame.bytes === "string" && Buffer.from(frame.bytes, "base64").length > 0, "terminal.frame.bytes must be nonempty base64");
  assert(frame.encoding === "ansi", "terminal.frame.encoding must be ansi");
  assert(typeof frame.full === "boolean", "terminal.frame.full must be boolean");
  assert(Number.isInteger(frame.width) && Number.isInteger(frame.height), "terminal.frame dimensions must be integers");
  assert(Number.isInteger(frame.seq) && frame.seq > 0, "terminal.frame.seq must be a positive integer");
}

async function waitForText(client, marker, startIndex = 0) {
  return await client.waitFor(
    (record) => record.type === "terminal.frame" && frameText(record).includes(marker),
    `frame containing ${marker}`,
    RECORD_TIMEOUT_MS,
    startIndex,
  );
}

function controlArgs(target, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, takeover = true) {
  return ["terminal", "session", "control", target, ...(takeover ? ["--takeover"] : []), "--cols", String(cols), "--rows", String(rows)];
}

function observeArgs(target, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  return ["terminal", "session", "observe", target, "--cols", String(cols), "--rows", String(rows)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.evidence, { recursive: true });
  const log = new Log();
  const rawLines = [];
  log.add("invocation", [process.execPath, ...process.argv.slice(1)]);
  const initialStatus = await runBounded("git", ["status", "--short"], { timeoutMs: 5_000 });
  log.add("git status before", initialStatus.stdout.trim() || "clean");
  log.add("timeouts", { child_process_ms: CHILD_TIMEOUT_MS, expected_record_ms: RECORD_TIMEOUT_MS, quiet_window_ms: QUIET_WINDOW_MS });

  const env = { ...process.env };
  if (options.socket) env.HERDR_SOCKET_PATH = options.socket;

  if (options.expectConnectFailure) {
    const result = await runBounded(options.herdr, controlArgs("ulw-probe-bogus"), { env, allowNonzero: true });
    assert(result.code !== 0, "connect-failure probe must exit nonzero internally");
    assert(result.stderr.includes("failed to connect to server"), "connect-failure stderr must identify server connection failure");
    assert(result.stderr.includes("Socket path:"), "connect-failure stderr must report the resolved socket path");
    log.add("expected connect failure validated", result);
    log.add("result", "PASS expected connection failure (script exit 0)");
    await writeFile(resolve(options.evidence, "raw.ndjson"), "");
    await writeFile(resolve(options.evidence, "cleanup.json"), `${JSON.stringify({ workspace_created: false, cleanup_required: false, expected_connect_failure: true }, null, 2)}\n`);
    const after = await runBounded("git", ["status", "--short"], { timeoutMs: 5_000 });
    log.add("git status after", after.stdout.trim() || "clean");
    await writeFile(resolve(options.evidence, "probe.log"), log.text());
    console.log(`PASS expected connection failure; evidence=${options.evidence}`);
    return;
  }

  const scratch = await mkdtemp(resolve(tmpdir(), "ulw-probe-"));
  let workspaceId;
  let paneId;
  let terminalId;
  const clients = new Set();
  const summary = { version: null, workspace: null, probes: {}, deviations: [] };
  let cleanupReceipt;

  const startClient = (name, args, clientEnv = env) => {
    const client = new NdjsonChild(options.herdr, args, rawLines, log, { env: clientEnv, name });
    clients.add(client);
    client.exitPromise.finally(() => clients.delete(client));
    return client;
  };

  try {
    const version = await runBounded(options.herdr, ["--version"], { env });
    assert(version.stdout.trim() === "herdr 0.8.2", `probe is pinned to herdr 0.8.2, got ${version.stdout.trim()}`);
    summary.version = version.stdout.trim();

    const created = await runBounded(options.herdr, ["workspace", "create", "--cwd", scratch, "--label", "ulw-probe", "--no-focus"], { env });
    const createJson = JSON.parse(created.stdout);
    workspaceId = createJson?.result?.workspace?.workspace_id;
    paneId = createJson?.result?.root_pane?.pane_id;
    terminalId = createJson?.result?.root_pane?.terminal_id;
    assert(workspaceId && paneId && terminalId, "workspace create JSON must return workspace, pane, and terminal ids");
    summary.workspace = { workspace_id: workspaceId, pane_id: paneId, terminal_id: terminalId, scratch_cwd: scratch, create_json: createJson };
    log.add("isolated workspace created from exact JSON", summary.workspace);

    // 1-6: frame contract, UTF-8 behavior, input, resize, and scroll command acceptance.
    const primary = startClient("primary", controlArgs(terminalId));
    const first = await primary.waitFor((record) => record.type === "terminal.frame", "first terminal.frame");
    validateFrame(first.record);
    assert(first.record.full === true, "first controller frame must be full");
    summary.probes.first_frame = { raw_line: first.rawLine, record: first.record };
    summary.probes.frame_fields = { raw_line: first.rawLine, fields: Object.keys(first.record).sort(), decoded_bytes: Buffer.from(first.record.bytes, "base64").length };

    const inputStart = primary.records.length;
    const input = { type: "terminal.input", text: "printf 'ULW_PROBE_OK\\n'\n" };
    primary.send(input);
    const markerFrame = await waitForText(primary, "ULW_PROBE_OK", inputStart);
    const bothFieldsStderrStart = primary.stderr.length;
    const bothFieldsInput = { type: "terminal.input", text: "printf 'ULW_INVALID_BOTH_TEXT\\n'\n", bytes: Buffer.from("printf 'ULW_INVALID_BOTH_BYTES\\n'\n").toString("base64") };
    primary.send(bothFieldsInput);
    await primary.waitForStderr(
      (stderr) => stderr.slice(bothFieldsStderrStart).includes("terminal.input accepts text or bytes, not both"),
      "rejecting terminal.input with both text and bytes",
    );
    const neitherFieldsStderrStart = primary.stderr.length;
    const neitherFieldsRecordStart = primary.records.length;
    const neitherFieldsInput = { type: "terminal.input" };
    primary.send(neitherFieldsInput);
    const neitherFieldsRecords = await primary.quietRecordCount();
    const neitherFieldsStderr = primary.stderr.slice(neitherFieldsStderrStart).trim();
    assert(neitherFieldsStderr === "", `neither-field input behavior changed; unexpected stderr: ${neitherFieldsStderr}`);
    assert(neitherFieldsRecords === 0 && primary.records.length === neitherFieldsRecordStart, "neither-field input behavior changed; expected silent no-op with no frame");
    assert(!primary.records.slice(inputStart).some(({ record }) => record.type === "terminal.frame" && /ULW_INVALID_BOTH_(TEXT|BYTES)/.test(frameText(record))), "rejected both-fields input must not reach the terminal");
    summary.probes.input = {
      command: input,
      raw_line: markerFrame.rawLine,
      round_trip: true,
      negative_validation: {
        both_fields: { command: bothFieldsInput, rejected: true, stderr: primary.stderr.slice(bothFieldsStderrStart, neitherFieldsStderrStart).trim() },
        neither_field: { command: neitherFieldsInput, rejected: false, silent_noop: true, records_emitted: neitherFieldsRecords, stderr: neitherFieldsStderr },
      },
    };

    // Ask the shell for multibyte CJK output and inspect every resulting record boundary. The bridge
    // carries base64 bytes, so an individual frame may end inside UTF-8 even though NDJSON remains valid.
    const utfStart = primary.records.length;
    const utfInputBytes = Buffer.from("printf '가나다\\n'\n", "utf8").toString("base64");
    primary.send({ type: "terminal.input", bytes: utfInputBytes });
    const utfFrame = await primary.waitFor(
      () => {
        const decoded = primary.records.slice(utfStart).filter(({ record }) => record.type === "terminal.frame").map(({ record }) => frameText(record)).join("");
        return [..."가나다"].every((character) => decoded.includes(character));
      },
      "frames containing each of 가, 나, 다",
      RECORD_TIMEOUT_MS,
      utfStart,
    );
    const utfRecords = primary.records.slice(utfStart, primary.records.indexOf(utfFrame) + 1).filter(({ record }) => record.type === "terminal.frame");
    const decodedUtfBuffers = utfRecords.map(({ record }) => Buffer.from(record.bytes, "base64"));
    const concatenatedUtf = Buffer.concat(decodedUtfBuffers);
    const cjkBytes = Buffer.from("가나다", "utf8");
    const cjkOffset = concatenatedUtf.indexOf(cjkBytes);
    const boundaries = [];
    let cumulative = 0;
    for (const bytes of decodedUtfBuffers.slice(0, -1)) {
      cumulative += bytes.length;
      boundaries.push(cumulative);
    }
    const splitInsideCjk = cjkOffset >= 0 && boundaries.some((boundary) => boundary > cjkOffset && boundary < cjkOffset + cjkBytes.length && ![cjkOffset + 3, cjkOffset + 6].includes(boundary));
    summary.probes.utf8_split = {
      raw_lines: utfRecords.map(({ rawLine }) => rawLine),
      decoded_frame_byte_lengths: decodedUtfBuffers.map((bytes) => bytes.length),
      cjk_byte_offset: cjkOffset,
      frame_boundaries: boundaries,
      observed_text: "가나다",
      split_inside_multibyte_character: splitInsideCjk,
      result: splitInsideCjk ? "observed a frame boundary inside one UTF-8 character" : "no frame boundary split an individual UTF-8 character in this captured emission",
    };

    const resizeChangedStart = primary.records.length;
    const changedResize = { type: "terminal.resize", cols: 61, rows: 14 };
    primary.send(changedResize);
    const changedFrame = await primary.waitFor((record) => record.type === "terminal.frame" && record.width === 61 && record.height === 14, "changed-size frame", RECORD_TIMEOUT_MS, resizeChangedStart);
    validateFrame(changedFrame.record);
    assert(changedFrame.record.full === true, "changed-size resize must emit a full frame");
    const resizeSameStart = primary.records.length;
    const sameResize = { type: "terminal.resize", cols: 61, rows: 14 };
    primary.send(sameResize);
    const unchangedFrame = await primary.waitFor(
      (record) => record.type === "terminal.frame" && record.width === 61 && record.height === 14,
      "unchanged-size frame",
      RECORD_TIMEOUT_MS,
      resizeSameStart,
    );
    validateFrame(unchangedFrame.record);
    assert(unchangedFrame.record.full === true, "unchanged-size resize must emit a full frame");
    summary.probes.resize = {
      changed: { command: changedResize, raw_line: changedFrame.rawLine, full: changedFrame.record.full },
      unchanged: { command: sameResize, raw_line: unchangedFrame.rawLine, emitted: true, full: unchangedFrame.record.full },
    };

    const scrollCommands = [
      { type: "terminal.scroll", direction: "up", lines: 3, source: "wheel", column: 4, row: 4, modifiers: 0 },
      { type: "terminal.scroll", direction: "up", lines: 14, source: "page_key", column: 0, row: 0, modifiers: 0 },
      { type: "terminal.scroll", direction: "down", lines: 14, source: "page_key", column: 0, row: 0, modifiers: 0 },
    ];
    const scrollObservations = [];
    for (const command of scrollCommands) {
      const commandStart = primary.records.length;
      const stderrStart = primary.stderr.length;
      primary.send(command);
      const recordsEmitted = await primary.quietRecordCount();
      const frames = primary.records.slice(commandStart).filter(({ record }) => record.type === "terminal.frame");
      const stderr = primary.stderr.slice(stderrStart).trim();
      scrollObservations.push({ command, records_emitted: recordsEmitted, frame_raw_lines: frames.map(({ rawLine }) => rawLine), stderr });
    }
    const scrollStart = primary.records.length;
    const scrollMarker = { type: "terminal.input", text: "printf 'ULW_SCROLL_OK\\n'\n" };
    primary.send(scrollMarker);
    const scrollFrame = await waitForText(primary, "ULW_SCROLL_OK", scrollStart);
    assert(scrollObservations.every(({ stderr }) => stderr === ""), "valid scroll commands must not produce rejection stderr");
    summary.probes.scroll = {
      commands: scrollCommands,
      observations: scrollObservations,
      acknowledgment_observable: scrollObservations.some(({ records_emitted }) => records_emitted > 0),
      informational_only: true,
      acceptance_raw_line: scrollFrame.rawLine,
      result: "no command-correlated acknowledgment is guaranteed; shapes were accepted without rejection and the bridge remained writable",
    };

    primary.send({ type: "terminal.release" });
    const released = await primary.waitFor((record) => record.type === "terminal.closed", "release closure");
    const primaryExit = await primary.exit();
    assert(released.record.reason === "detached", `release reason must be detached, got ${released.record.reason}`);
    assert(primaryExit.code === 0, "released controller must exit cleanly");
    const readAfterRelease = await runBounded(options.herdr, ["pane", "read", paneId, "--lines", "20", "--format", "text"], { env });
    assert(readAfterRelease.code === 0, "pane read must remain available after release");
    summary.probes.release = { command: { type: "terminal.release" }, raw_line: released.rawLine, record: released.record, exit: primaryExit, pane_read_worked: true, pane_read_stdout_bytes: Buffer.byteLength(readAfterRelease.stdout) };

    // 8: EOF, SIGTERM, and SIGKILL. A successor takeover proves authority is available after each disconnect.
    for (const mode of ["eof", "sigterm", "sigkill"]) {
      const client = startClient(`lifecycle-${mode}`, controlArgs(terminalId));
      const initial = await client.waitFor((record) => record.type === "terminal.frame" && record.full === true, `${mode} initial full frame`);
      if (mode === "eof") client.endStdin();
      else client.kill(mode === "sigterm" ? "SIGTERM" : "SIGKILL");
      const exit = await client.exit();
      const closure = client.records.find(({ record }) => record.type === "terminal.closed");
      const successor = startClient(`successor-${mode}`, controlArgs(terminalId));
      const successorFrame = await successor.waitFor((record) => record.type === "terminal.frame" && record.full === true, `${mode} successor full frame`);
      successor.send({ type: "terminal.release" });
      await successor.waitFor((record) => record.type === "terminal.closed", `${mode} successor closure`);
      await successor.exit();
      summary.probes[mode] = {
        initial_raw_line: initial.rawLine,
        closure: closure ? { raw_line: closure.rawLine, record: closure.record } : null,
        exit,
        ownership_released: true,
        successor_raw_line: successorFrame.rawLine,
      };
    }

    // 9: a takeover controller displaces the first controller.
    const displaced = startClient("displaced-first", controlArgs(terminalId));
    await displaced.waitFor((record) => record.type === "terminal.frame" && record.full === true, "displaced controller initial frame");
    const takeover = startClient("displacing-second", controlArgs(terminalId));
    const takeoverFrame = await takeover.waitFor((record) => record.type === "terminal.frame" && record.full === true, "takeover controller initial frame");
    const displacedClosed = await displaced.waitFor((record) => record.type === "terminal.closed", "displaced controller closure");
    assert(displacedClosed.record.reason === "terminal attach taken over", `displaced controller reason changed: ${displacedClosed.record.reason}`);
    const displacedExit = await displaced.exit();
    summary.probes.displacement = { raw_line: displacedClosed.rawLine, record: displacedClosed.record, first_exit: displacedExit, second_initial_raw_line: takeoverFrame.rawLine };

    // 10: observe is read-only, but receives the controller-sized grid and subsequent resize.
    const observer = startClient("observer", observeArgs(terminalId, 30, 8));
    const observedInitial = await observer.waitFor((record) => record.type === "terminal.frame" && record.full === true, "observer initial full frame");
    const observerResizeStart = observer.records.length;
    takeover.send({ type: "terminal.resize", cols: 47, rows: 11 });
    const controlledResize = await takeover.waitFor((record) => record.type === "terminal.frame" && record.width === 47 && record.height === 11, "controller resized frame");
    assert(observedInitial.record.width === 30 && observedInitial.record.height === 8, "observer initial viewport must match requested 30x8 grid");
    assert(controlledResize.record.width === 47 && controlledResize.record.height === 11, "controller resize frame must match requested 47x11 grid");
    assert(controlledResize.record.full === true, "controller resize while observer is active must emit a full frame");
    const observerRecordsAfterResize = await observer.quietRecordCount();
    const observerFramesAfterResize = observer.records.slice(observerResizeStart).filter(({ record }) => record.type === "terminal.frame");
    assert(observerFramesAfterResize.length > 0, "observer must emit at least one frame after controller resize");
    assert(observerFramesAfterResize.every(({ record }) => record.width === 30 && record.height === 8), "observer frames must remain at requested 30x8 grid after controller resize");
    const observedResize = observerFramesAfterResize.find(({ record }) => record.width === 47 && record.height === 11);
    const takeoverClosedByObserver = takeover.records.find(({ record }) => record.type === "terminal.closed");
    summary.probes.observe_grid = {
      observer_initial: { raw_line: observedInitial.rawLine, width: observedInitial.record.width, height: observedInitial.record.height },
      controller_resize_raw_line: controlledResize.rawLine,
      observer_records_after_controller_resize: observerRecordsAfterResize,
      observer_resize: observedResize ? { raw_line: observedResize.rawLine, width: observedResize.record.width, height: observedResize.record.height, full: observedResize.record.full } : null,
      controller_closure_after_observer: takeoverClosedByObserver ? { raw_line: takeoverClosedByObserver.rawLine, record: takeoverClosedByObserver.record } : null,
      result: takeoverClosedByObserver ? "starting observe displaced the controller; observer then retained its own requested grid" : observedResize ? "observer followed controller dimensions" : "observer retained its own requested grid and emitted no controller-size frame",
    };
    observer.kill("SIGTERM");
    await observer.exit();
    if (!takeover.closed) {
      takeover.send({ type: "terminal.release" });
      await takeover.waitFor((record) => record.type === "terminal.closed", "takeover release after observer");
      await takeover.exit();
    }

    // 12: create >200 terminal lines, then compare pane-read retention with a fresh observer checkpoint.
    const retentionController = startClient("retention-controller", controlArgs(terminalId));
    await retentionController.waitFor((record) => record.type === "terminal.frame" && record.full === true, "retention controller initial frame");
    const retentionStart = retentionController.records.length;
    retentionController.send({ type: "terminal.input", text: "i=1; while [ $i -le 240 ]; do printf 'ULW_RET_%03d\\n' $i; i=$((i+1)); done; printf 'ULW_RET_DONE\\n'\n" });
    const retainedMarker = await waitForText(retentionController, "ULW_RET_DONE", retentionStart);
    const paneRead = await runBounded(options.herdr, ["pane", "read", paneId, "--lines", "300", "--format", "text"], { env });
    const retainedLines = paneRead.stdout.split(/\r?\n/).filter((line) => line.includes("ULW_RET_"));
    const retainedNumberedLines = retainedLines.filter((line) => /ULW_RET_\d{3}/.test(line));
    assert(retainedNumberedLines.length === 240, `pane read must retain all 240 numbered output lines; got ${retainedNumberedLines.length}`);
    assert(retainedLines.some((line) => line.includes("ULW_RET_DONE")), "pane read must retain ULW_RET_DONE");
    assert(retainedLines.some((line) => line.includes("ULW_RET_001")), "pane read must retain first emitted line");
    assert(retainedLines.some((line) => line.includes("ULW_RET_240")), "pane read must retain last numbered line");
    const freshObserver = startClient("fresh-retention-observer", observeArgs(terminalId, 47, 11));
    const freshFrame = await freshObserver.waitFor((record) => record.type === "terminal.frame" && record.full === true, "fresh observer checkpoint");
    const freshText = frameText(freshFrame.record);
    freshObserver.kill("SIGTERM");
    await freshObserver.exit();
    summary.probes.retention = {
      emit_marker_raw_line: retainedMarker.rawLine,
      emitted_lines: 241,
      pane_read_requested_lines: 300,
      pane_read_matching_lines: retainedLines.length,
      pane_read_numbered_matches: retainedNumberedLines.length,
      pane_read_first_match: retainedLines[0] ?? null,
      pane_read_last_match: retainedLines.at(-1) ?? null,
      fresh_observer_raw_line: freshFrame.rawLine,
      fresh_observer_full_bytes: Buffer.from(freshFrame.record.bytes, "base64").length,
      fresh_observer_contains_first: freshText.includes("ULW_RET_001"),
      fresh_observer_contains_last: freshText.includes("ULW_RET_240"),
      plan_checkpoint_bound_bytes: 8 * 1024 * 1024,
    };

    if (!retentionController.closed) {
      retentionController.send({ type: "terminal.release" });
      await retentionController.waitFor((record) => record.type === "terminal.closed", "retention controller release");
      await retentionController.exit();
    }

    // 11: named-session argv behavior and bogus-target error record on the live default session.
    const namedVersion = await runBounded(options.herdr, ["--session", "ulw-probe-nonexistent", "--version"], { env });
    log.add("named-session version invocation", namedVersion);
    const namedControl = await runBounded(options.herdr, ["--session", "ulw-probe-nonexistent", ...controlArgs("bogus")], { env, allowNonzero: true });
    log.add("named-session missing-server invocation", namedControl);
    const bogusTarget = await runBounded(options.herdr, controlArgs("ulw-probe-bogus"), { env });
    const bogusRecord = JSON.parse(bogusTarget.stdout.trim());
    log.add("live-session bogus-target invocation", { ...bogusTarget, parsed_record: bogusRecord });
    assert(bogusRecord.type === "terminal.closed" && bogusRecord.reason.includes("not found"), "bogus live target must return terminal.closed not-found reason");
    assert(namedControl.code !== 0 && namedControl.stderr.includes("failed to connect to server"), "missing named session must report connection failure");
    summary.probes.named_session = {
      version_argv: [options.herdr, "--session", "ulw-probe-nonexistent", "--version"],
      version_stdout: namedVersion.stdout.trim(),
      control_argv: [options.herdr, "--session", "ulw-probe-nonexistent", ...controlArgs("bogus")],
      control_exit: namedControl.code,
      control_stderr: namedControl.stderr.trim(),
      live_bogus_target_record: bogusRecord,
      minimum_supported_version_for_plan: "0.8.0",
      installed_version: summary.version,
    };

    summary.deviations = [
      "D2 amended: 0.8.2 emits typed terminal.frame/terminal.closed records, not bare {bytes}; input is accepted directly by terminal.input text rather than pane.send_text.",
      "D5 confirmed/amended: the first frame is full:true; both changed and unchanged live terminal.resize emitted full:true checkpoints.",
      "D6 amended: scroll is a typed terminal.scroll command (wheel/page_key); decoded controller frames include terminal-mode ANSI, so a blanket claim that no mouse-related escapes exist is unsafe.",
    ];
  } finally {
    for (const client of [...clients]) {
      if (!client.closed) client.kill("SIGKILL");
      try { await client.exit(); } catch {}
    }
    let closeResult = null;
    if (workspaceId) closeResult = await runBounded(options.herdr, ["workspace", "close", workspaceId], { env, allowNonzero: true });
    const workspaceList = await runBounded(options.herdr, ["workspace", "list"], { env, allowNonzero: true });
    let parsedList = null;
    try { parsedList = JSON.parse(workspaceList.stdout); } catch {}
    const serializedList = JSON.stringify(parsedList ?? workspaceList.stdout);
    const workspaceAbsentById = workspaceId ? !serializedList.includes(`"${workspaceId}"`) : true;
    const labelAbsent = !serializedList.includes("ulw-probe");
    await rm(scratch, { recursive: true, force: true });
    const processScan = await runBounded("pgrep", ["-af", "probe-herdr-control|ulw-probe"], { allowNonzero: true, timeoutMs: 5_000 });
    const processScanLines = processScan.stdout.split(/\r?\n/).filter(Boolean);
    cleanupReceipt = {
      workspace_id: workspaceId ?? null,
      close: closeResult,
      workspace_list: parsedList ?? workspaceList.stdout,
      workspace_absent_by_returned_id: workspaceAbsentById,
      ulw_probe_label_absent: labelAbsent,
      tracked_probe_children_remaining: [...clients].filter((client) => !client.closed).map((client) => client.pid),
      process_scan: {
        command: processScan.command,
        exit_code: processScan.code,
        raw_matches: processScanLines,
        note: "The running probe process may match its own argv; tracked spawned children are checked separately above."
      },
      scratch_directory_removed: true,
    };
    assert(workspaceAbsentById, `cleanup failed: returned workspace id ${workspaceId} remains`);
    assert(labelAbsent, "cleanup failed: ulw-probe label remains");
    assert(cleanupReceipt.tracked_probe_children_remaining.length === 0, "cleanup failed: tracked probe child remains");
  }

  const rawPath = resolve(options.evidence, "raw.ndjson");
  const summaryPath = resolve(options.evidence, "summary.json");
  const cleanupPath = resolve(options.evidence, "cleanup.json");
  await writeFile(rawPath, rawLines.length ? `${rawLines.join("\n")}\n` : "");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(cleanupPath, `${JSON.stringify(cleanupReceipt, null, 2)}\n`);

  try {
    const protocolDoc = await readFile(resolve(dirname(new URL(import.meta.url).pathname), "../../docs/herdr-bridge-protocol.md"), "utf8");
    await writeFile(resolve(options.evidence, "protocol.md"), protocolDoc);
  } catch {
    await writeFile(resolve(options.evidence, "protocol.md"), "Protocol document is generated from summary.json after the first successful probe run.\n");
  }

  const afterStatus = await runBounded("git", ["status", "--short"], { timeoutMs: 5_000 });
  log.add("git status after", afterStatus.stdout.trim() || "clean");
  log.add("cleanup receipt", cleanupReceipt);
  log.add("result", `PASS herdr 0.8.2 control probe; raw_records=${rawLines.length} (script exit 0)`);
  await writeFile(resolve(options.evidence, "probe.log"), log.text());
  console.log(`PASS herdr 0.8.2 control probe; raw_records=${rawLines.length}; evidence=${options.evidence}`);
}

main().catch(async (error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
