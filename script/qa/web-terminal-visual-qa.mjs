import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    title: { type: "string", default: "ULW herdr attached" },
    command: { type: "string" },
    input: { type: "string", default: "{Enter}" },
    "evidence-dir": { type: "string" },
    herdr: { type: "string", default: "/Users/ilseoblee/.local/bin/herdr" },
  },
  strict: true,
});

if (!values.command || !values["evidence-dir"]) {
  console.error("Usage: node script/qa/web-terminal-visual-qa.mjs --title <title> --command <pane-command> --input <keys> --evidence-dir <dir>");
  process.exit(1);
}

const title = values.title;
const markerCommand = values.command;
const visualFixtureRequested = markerCommand.includes("--visual-fixture");
const fixturePaneCommand =
  "printf 'ULW_VISUAL_READY 가나다 \\033[38;2;255;95;31mULW_TRUECOLOR\\033[0m\\n'; exec /bin/sh";
const paneCommand = visualFixtureRequested ? fixturePaneCommand : markerCommand;
const inputKeys = values.input;
const evidenceDir = path.resolve(values["evidence-dir"]);
const herdr = path.resolve(values.herdr);
const webviewJsPath = path.resolve("dist/webview.js");
const commandTimeoutMs = 10_000;
fs.mkdirSync(evidenceDir, { recursive: true });

const chromeExecutable = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Chrome",
].find((candidate) => fs.existsSync(candidate));

if (!fs.existsSync(herdr)) {
  console.error(`Herdr binary not found: ${herdr}`);
  process.exit(1);
}
if (!fs.existsSync(webviewJsPath)) {
  console.error("Missing dist/webview.js. Run npm run compile first.");
  process.exit(1);
}
if (!chromeExecutable) {
  console.error("Chrome not found");
  process.exit(1);
}

const transcript = [];
const childProcesses = new Set();
let scratchDir;
let workspaceId;
let paneId;
let terminalId;
let scratchProcessIds = [];
let processInspection = {
  processIds: [],
  inspectionFailed: false,
};
let chromeProfileDir;
let chrome;
let bridge;
let bridgeReleased = false;
let visualAssertions;

const log = (event, detail = {}) => {
  const entry = { at: new Date().toISOString(), event, ...detail };
  transcript.push(entry);
  console.log(JSON.stringify(entry));
};

const runBounded = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childProcesses.add(child);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, options.timeoutMs ?? commandTimeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      childProcesses.delete(child);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      childProcesses.delete(child);
      if (code === 0) {
        resolve({ stdout, stderr, code, signal });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal}): ${stderr || stdout}`));
      }
    });
  });

const parseResult = (stdout) => {
  const parsed = JSON.parse(stdout);
  if (!parsed?.result) throw new Error(`Herdr response had no result: ${stdout}`);
  return parsed.result;
};

const inspectProcesses = async (targetPaneId) => {
  try {
    const result = parseResult((await runBounded(herdr, ["pane", "process-info", "--pane", targetPaneId])).stdout);
    const info = result.process_info ?? {};
    return {
      processIds: [...new Set([info.shell_pid, ...(info.foreground_processes ?? []).map((entry) => entry.pid)].filter(Number.isInteger))],
      inspectionFailed: false,
    };
  } catch (error) {
    return {
      processIds: [],
      inspectionFailed: true,
      error: String(error?.message ?? error),
    };
  }
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const waitFor = (subscribe, description, timeoutMs = commandTimeoutMs) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);
    const dispose = subscribe((value) => {
      clearTimeout(timeout);
      dispose();
      resolve(value);
    });
  });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });

const httpJson = (port, method, requestPath) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: requestPath, method },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Non-JSON CDP response: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

const decodeInputKeys = (value) => {
  const replacements = {
    "{Enter}": "\r",
    "{Tab}": "\t",
    "{Escape}": "\u001b",
    "{Space}": " ",
  };
  return Object.entries(replacements).reduce(
    (decoded, [token, replacement]) => decoded.split(token).join(replacement),
    value,
  );
};

const htmlPath = path.join(evidenceDir, "harness.html");
fs.writeFileSync(
  htmlPath,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title.replaceAll("<", "&lt;")}</title>
<style>
:root { --vscode-terminal-background:#17191f; --vscode-terminal-foreground:#e5e7eb; --vscode-badge-background:#2563eb; --vscode-badge-foreground:#fff; }
html,body,#terminal-container { width:100%; height:100%; margin:0; overflow:hidden; background:#17191f; }
body { border-left:1px solid #303642; box-sizing:border-box; }
</style>
<script>
window.__ulwRenderer = "dom";
window.__hostMessages = [];
window.acquireVsCodeApi = () => ({
  postMessage(message) { window.__hostMessages.push(message); },
  getState() { return undefined; },
  setState() {}
});
window.__rows = () => Array.from(document.querySelectorAll(".xterm-rows > div")).map((row) => row.textContent || "").join("\\n");
</script>
</head>
<body><div id="terminal-container"></div><script src="file://${webviewJsPath}"></script></body>
</html>`,
);

const startBridge = (cols, rows) => {
  bridge = spawn(
    herdr,
    ["terminal", "session", "control", terminalId, "--takeover", "--cols", String(cols), "--rows", String(rows)],
    { stdio: ["pipe", "pipe", "pipe"], env: process.env },
  );
  childProcesses.add(bridge);
  let stdoutBuffer = "";
  let stderr = "";
  const records = [];
  const listeners = new Set();
  bridge.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const record = JSON.parse(line);
      records.push(record);
      log("bridge.record", { record: record.type === "terminal.frame" ? { ...record, bytes: `<${record.bytes.length} base64 chars>` } : record });
      for (const listener of [...listeners]) listener(record);
    }
  });
  bridge.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    log("bridge.stderr", { data: chunk.toString("utf8") });
  });
  bridge.on("exit", (code, signal) => {
    childProcesses.delete(bridge);
    log("bridge.exit", { code, signal, stderr });
  });
  return {
    records,
    send(command) {
      log("bridge.command", { command });
      bridge.stdin.write(`${JSON.stringify(command)}\n`);
    },
    onRecord(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

async function cleanup() {
  for (const child of childProcesses) {
    try { child.kill("SIGKILL"); } catch {}
  }
  if (chrome) {
    try { chrome.kill("SIGKILL"); } catch {}
  }
  if (paneId) {
    processInspection = await inspectProcesses(paneId);
    scratchProcessIds = [...new Set([...scratchProcessIds, ...processInspection.processIds])];
  }
  let closeResponse;
  let workspaceAbsent = workspaceId === undefined;
  if (workspaceId) {
    try {
      closeResponse = JSON.parse((await runBounded(herdr, ["workspace", "close", workspaceId])).stdout);
    } catch (error) {
      closeResponse = { error: String(error?.message ?? error) };
    }
    try {
      const listed = parseResult((await runBounded(herdr, ["workspace", "list"])).stdout);
      workspaceAbsent = !(listed.workspaces ?? []).some((entry) => entry.workspace_id === workspaceId);
    } catch {
      workspaceAbsent = false;
    }
  }
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
  if (chromeProfileDir) fs.rmSync(chromeProfileDir, { recursive: true, force: true });
  const liveProcessIds = scratchProcessIds.filter(processAlive);
  const cleanupReceipt = {
    workspaceId,
    paneId,
    closeResponse,
    workspaceAbsent,
    processInspection,
    checkedProcessIds: scratchProcessIds,
    liveProcessIds,
    noLeftoverChildren: !processInspection.inspectionFailed && liveProcessIds.length === 0,
    scratchDir,
    scratchDirRemoved: scratchDir ? !fs.existsSync(scratchDir) : true,
    chromeProfileDir,
    chromeProfileRemoved: chromeProfileDir ? !fs.existsSync(chromeProfileDir) : true,
    bridgeReleased,
  };
  fs.writeFileSync(path.join(evidenceDir, "visual-cleanup.json"), `${JSON.stringify(cleanupReceipt, null, 2)}\n`);
  return cleanupReceipt;
}

async function main() {
  const deviation = {
    literalPlanInvocationUsed: visualFixtureRequested,
    requestedPlanCommand: 'npm run test:e2e:herdr -- --visual-fixture',
    suppliedCommand: markerCommand,
    actualCommandMeaning: paneCommand,
    fixtureMode: visualFixtureRequested ? "internal-live-herdr-cycle" : "generic-marker-command",
    justification: visualFixtureRequested
      ? "The literal plan command selects the script's internal live-Herdr fixture cycle. The npm command is not executed inside the pane; the script creates an isolated workspace and emits the visual markers before driving the real bridge and production webview bundle."
      : "Generic mode executes the supplied marker command in the isolated pane and expects it to emit ULW_VISUAL_READY, CJK, and truecolor fixture text.",
  };

  const version = await runBounded(herdr, ["--version"]);
  if (!/^herdr 0\.8\./.test(version.stdout)) {
    throw new Error(`Herdr 0.8.x required, got ${version.stdout.trim()}`);
  }
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ulw-visual-herdr-"));
  const createdJson = JSON.parse((await runBounded(herdr, ["workspace", "create", "--cwd", scratchDir, "--label", "ulw-e2e", "--no-focus"])).stdout);
  workspaceId = createdJson?.result?.workspace?.workspace_id;
  paneId = createdJson?.result?.root_pane?.pane_id;
  terminalId = createdJson?.result?.root_pane?.terminal_id;
  if (!workspaceId || !paneId || !terminalId) throw new Error("workspace create did not return required IDs");
  log("scratch.created", { workspaceId, paneId, terminalId, scratchDir });

  await runBounded(herdr, ["pane", "wait-output", paneId, "--regex", ".+", "--source", "visible", "--lines", "20", "--timeout", "5000", "--raw"]);
  await runBounded(herdr, ["pane", "run", paneId, paneCommand]);
  await runBounded(herdr, ["pane", "wait-output", paneId, "--match", "ULW_VISUAL_READY", "--source", "recent-unwrapped", "--lines", "100", "--timeout", "5000", "--raw"]);
  processInspection = await inspectProcesses(paneId);
  if (processInspection.inspectionFailed) {
    throw new Error(`Scratch process inspection failed: ${processInspection.error}`);
  }
  scratchProcessIds = [...processInspection.processIds];

  const port = await freePort();
  chromeProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ulw-vqa-profile-"));
  chrome = spawn(chromeExecutable, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${chromeProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--window-size=900,700",
    "about:blank",
  ]);
  childProcesses.add(chrome);
  chrome.on("exit", () => childProcesses.delete(chrome));

  let versionEndpoint;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      versionEndpoint = await httpJson(port, "GET", "/json/version");
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!versionEndpoint) throw new Error("Chrome DevTools endpoint did not become ready");
  await httpJson(port, "PUT", "/json/new?about:blank");
  const targets = await httpJson(port, "GET", "/json/list");
  const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!target) throw new Error("Chrome page target unavailable");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `file://${htmlPath}` });

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };

  const hostReady = await waitFor(
    (resolve) => {
      const interval = setInterval(async () => {
        const messages = await evaluate("window.__hostMessages || []");
        const ready = messages.find((message) => message?.type === "ready");
        if (ready) resolve(ready);
      }, 50);
      return () => clearInterval(interval);
    },
    "webview ready",
  );
  const bridgeDriver = startBridge(hostReady.cols, hostReady.rows);
  const firstFrame = await waitFor(
    (resolve) => bridgeDriver.onRecord((record) => {
      if (record.type === "terminal.frame" && record.full === true) resolve(record);
    }),
    "first full Herdr frame",
  );
  await evaluate(`window.postMessage(${JSON.stringify({ type: "reset" })}, "*")`);
  await evaluate(`window.postMessage(${JSON.stringify({ type: "sourceState", source: "herdr", phase: "attached", label: "ulw-e2e" })}, "*")`);
  await evaluate(`window.postMessage(${JSON.stringify({ type: "output", data: Buffer.from(firstFrame.bytes, "base64").toString("utf8") })}, "*")`);

  const forwardedFrames = new Set([firstFrame.seq]);
  const disposeFrameForwarder = bridgeDriver.onRecord(async (record) => {
    if (record.type !== "terminal.frame" || forwardedFrames.has(record.seq)) return;
    forwardedFrames.add(record.seq);
    if (record.full) await evaluate(`window.postMessage(${JSON.stringify({ type: "reset" })}, "*")`);
    await evaluate(`window.postMessage(${JSON.stringify({ type: "output", data: Buffer.from(record.bytes, "base64").toString("utf8") })}, "*")`);
  });

  let pumpingHostMessages = false;
  const hostInputInterval = setInterval(async () => {
    if (pumpingHostMessages) return;
    pumpingHostMessages = true;
    try {
      const messages = await evaluate("window.__hostMessages.splice(0)");
      for (const message of messages) {
        if (message.type === "input") bridgeDriver.send({ type: "terminal.input", bytes: Buffer.from(message.data, "utf8").toString("base64") });
        if (message.type === "resize") bridgeDriver.send({ type: "terminal.resize", cols: message.cols, rows: message.rows });
      }
    } finally {
      pumpingHostMessages = false;
    }
  }, 25);
  const disposeHostInput = () => clearInterval(hostInputInterval);

  await waitFor(
    (resolve) => {
      const interval = setInterval(async () => {
        const rows = await evaluate("window.__rows()");
        if (rows.includes("ULW_VISUAL_READY") && rows.includes("가나다") && rows.includes("ULW_TRUECOLOR")) resolve(rows);
      }, 50);
      return () => clearInterval(interval);
    },
    "rendered live marker, CJK, and truecolor text",
  );

  const inputPayload = `printf 'ULW_VISUAL_INPUT\\n'${decodeInputKeys(inputKeys)}`;
  await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await cdp.send("Input.insertText", { text: inputPayload });
  await waitFor(
    (resolve) => {
      const interval = setInterval(async () => {
        if ((await evaluate("window.__rows()")).includes("ULW_VISUAL_INPUT")) resolve(true);
      }, 50);
      return () => clearInterval(interval);
    },
    "rendered input round-trip",
  );

  await evaluate(`(() => { const row = [...document.querySelectorAll('.xterm-rows > div')].find((entry) => (entry.textContent || '').includes('ULW_VISUAL_READY')); const range = document.createRange(); range.selectNodeContents(row); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
  const selectedText = await evaluate("document.querySelector('.xterm-rows > div:nth-child(3)')?.textContent || ''");
  const selectionRangeCount = await evaluate("window.getSelection().rangeCount");

  const attachedBadgeText = await evaluate("document.querySelector('.ulw-status-badge')?.textContent || ''");
  const attachedShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(evidenceDir, "attached-with-badge.png"), Buffer.from(attachedShot.data, "base64"));

  bridgeDriver.send({ type: "terminal.release" });
  await waitFor(
    (resolve) => bridgeDriver.onRecord((record) => {
      if (record.type === "terminal.closed") resolve(record);
    }),
    "terminal.closed after release",
  );
  bridgeReleased = true;
  disposeFrameForwarder();
  disposeHostInput();
  await evaluate(`window.postMessage(${JSON.stringify({ type: "sourceState", source: "shell", phase: "error", message: "visual detach receipt" })}, "*")`);
  const errorShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(evidenceDir, "post-detach-error.png"), Buffer.from(errorShot.data, "base64"));

  const rowsOutput = await evaluate("window.__rows()");
  const badgeText = await evaluate("document.querySelector('.ulw-status-badge')?.textContent || ''");
  const truecolorSpan = await evaluate(`(() => { const spans = [...document.querySelectorAll('.xterm-rows span')]; const span = spans.find((entry) => (entry.textContent || '').trim() === 'ULW_TRUECOLOR'); return span ? getComputedStyle(span).color : ''; })()`);
  visualAssertions = {
    passed: true,
    liveMarkerVisible: rowsOutput.includes("ULW_VISUAL_READY"),
    inputRoundTripVisible: rowsOutput.includes("ULW_VISUAL_INPUT"),
    cjkVisible: rowsOutput.includes("가나다"),
    truecolorMarkerVisible: rowsOutput.includes("ULW_TRUECOLOR"),
    truecolorComputedColor: truecolorSpan,
    truecolorApplied: /255\s*,\s*95\s*,\s*31/.test(truecolorSpan),
    selectionContainsMarker: selectedText.includes("ULW_VISUAL_READY") && selectionRangeCount > 0,
    selectionRangeCount,
    attachedBadgeCaptured: fs.existsSync(path.join(evidenceDir, "attached-with-badge.png")),
    attachedBadgeText,
    attachedBadgeVisible: attachedBadgeText === "Attached: ulw-e2e",
    postDetachOrErrorCaptured: fs.existsSync(path.join(evidenceDir, "post-detach-error.png")),
    finalBadgeText: badgeText,
    finalErrorBadgeVisible: badgeText === "Error: visual detach receipt",
    bridgeReleased,
    title,
    inputKeys,
    rowsOutput,
    deviation,
  };
  visualAssertions.passed = Object.entries(visualAssertions)
    .filter(([key]) => ["liveMarkerVisible", "inputRoundTripVisible", "cjkVisible", "truecolorMarkerVisible", "truecolorApplied", "selectionContainsMarker", "attachedBadgeCaptured", "attachedBadgeVisible", "postDetachOrErrorCaptured", "finalErrorBadgeVisible", "bridgeReleased"].includes(key))
    .every(([, value]) => value === true);
  fs.writeFileSync(path.join(evidenceDir, "assertions.json"), `${JSON.stringify(visualAssertions, null, 2)}\n`);
  const dom = await evaluate("document.documentElement.outerHTML");
  fs.writeFileSync(path.join(evidenceDir, "rendered-dom.html"), dom);
  socket.close();
  if (!visualAssertions.passed) throw new Error("Visual assertions failed");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  log("failure", { message: String(error?.stack ?? error) });
  if (!visualAssertions) {
    visualAssertions = { passed: false, error: String(error?.message ?? error) };
    fs.writeFileSync(path.join(evidenceDir, "assertions.json"), `${JSON.stringify(visualAssertions, null, 2)}\n`);
  }
} finally {
  const cleanupReceipt = await cleanup();
  fs.writeFileSync(path.join(evidenceDir, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`);
  if (cleanupReceipt.processInspection.inspectionFailed || !cleanupReceipt.workspaceAbsent || !cleanupReceipt.noLeftoverChildren || !cleanupReceipt.scratchDirRemoved || !cleanupReceipt.chromeProfileRemoved) exitCode = 1;
}

if (exitCode === 0) console.log("Visual QA script passed.");
process.exit(exitCode);
