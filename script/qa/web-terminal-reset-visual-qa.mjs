import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "evidence-dir": { type: "string" },
  },
  strict: false,
});

if (!values["evidence-dir"]) {
  console.error("Missing --evidence-dir");
  process.exit(1);
}

const evidenceDir = path.resolve(values["evidence-dir"]);
fs.mkdirSync(evidenceDir, { recursive: true });

const chromePaths = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Chrome",
];

const chromeExecutable = chromePaths.find((p) => fs.existsSync(p));
if (!chromeExecutable) {
  console.error(`BLOCKED: Chrome not found at ${chromePaths.join(" or ")}`);
  process.exit(1);
}

const webviewJsPath = path.resolve("dist/webview.js");
if (!fs.existsSync(webviewJsPath)) {
  console.error("Missing dist/webview.js. Did you run npm run compile?");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Harness HTML: the real dist/webview.js bundle in a plain page.
// The sequence is driven by real timers inside Chrome; the script keeps
// re-posting messages until they are observed in the LIVE rendered DOM, then
// writes a single #qa-results node with the assertions.
// ---------------------------------------------------------------------------
const htmlPath = path.resolve(evidenceDir, "harness.html");

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ULW Terminal Reset Visual QA</title>
  <style>
    :root {
      --vscode-terminal-background: #1e1e1e;
      --vscode-terminal-foreground: #d4d4d4;
    }
    html, body, #terminal-container {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--vscode-terminal-background);
      color: var(--vscode-terminal-foreground);
    }
    #terminal-container { position: relative; }
  </style>
  <script>
    // Force the DOM renderer so rendered rows are queryable from the DOM.
    window.__ulwRenderer = "dom";
    window.acquireVsCodeApi = () => {
      window.__sent = [];
      return {
        postMessage: (msg) => { window.__sent.push(msg); },
        getState: () => undefined,
        setState: () => {}
      };
    };

    let assertionsWritten = false;
    const writeAssertions = (assertions) => {
      if (assertionsWritten) return;
      assertionsWritten = true;
      const node = document.createElement("div");
      node.id = "qa-results";
      node.textContent = JSON.stringify(assertions);
      document.body.appendChild(node);
      document.title = "DONE";
    };

    const readRows = () =>
      Array.from(document.querySelectorAll(".xterm-rows > div"))
        .map((el) => el.textContent)
        .join("\\n");

    // Poll until predicate(rows) holds, re-posting a message while waiting so
    // a single lost render pass cannot stall the sequence. Always resolves.
    const pollUntil = (predicate, opts) => {
      const maxWait = (opts && opts.maxWait) || 3000;
      const repost = opts && opts.repost;
      const repostEvery = (opts && opts.repostEvery) || 300;
      return new Promise((resolve) => {
        const start = Date.now();
        let lastPost = start;
        const poll = setInterval(() => {
          const rows = readRows();
          const now = Date.now();
          if (predicate(rows)) {
            clearInterval(poll);
            resolve(rows);
            return;
          }
          if (repost && now - lastPost >= repostEvery) {
            lastPost = now;
            repost();
          }
          if (now - start > maxWait) {
            clearInterval(poll);
            resolve(rows);
          }
        }, 50);
      });
    };

    const runSequence = async () => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));

      // Let xterm finish its initial open/fit pass.
      await delay(300);

      // 1) Old shell sentinel must actually render before we reset.
      const postSentinel = () =>
        window.postMessage({ type: "output", data: "ULW_SENTINEL_OLD\\r\\n" }, "*");
      postSentinel();
      const sentinelRows = await pollUntil(
        (rows) => rows.includes("ULW_SENTINEL_OLD"),
        { repost: postSentinel },
      );

      // 2) Reset: anti-stale probe — sentinel must vanish from the LIVE DOM.
      window.postMessage({ type: "reset" }, "*");
      await pollUntil((rows) => !rows.includes("ULW_SENTINEL_OLD"), { maxWait: 2000 });
      await delay(150);

      // 3) Replacement frame + attached badge.
      const postReplacement = () =>
        window.postMessage({ type: "output", data: "ULW_FRAME_NEW 가나다\\r\\n" }, "*");
      postReplacement();
      window.postMessage(
        { type: "sourceState", source: "herdr", phase: "attached", label: "probe" },
        "*"
      );
      await pollUntil((rows) => rows.includes("ULW_FRAME_NEW 가나다"), {
        maxWait: 3000,
        repost: postReplacement,
      });

      // 4) Assertions read the live DOM at this moment — never pre-seeded values.
      await delay(200);
      const rows = readRows();
      const badge = document.querySelector(".ulw-status-badge");
      const badgeText = badge ? (badge.textContent || "") : "";
      writeAssertions({
        sentinelAbsent: !rows.includes("ULW_SENTINEL_OLD"),
        replacementPresent: rows.includes("ULW_FRAME_NEW 가나다"),
        badgePresent: !!badge,
        badgeTextPresent: badgeText.length > 0,
        badgeText: badgeText,
        rowsOutput: rows,
        sentinelRendered: sentinelRows.includes("ULW_SENTINEL_OLD"),
      });
    };

    const checkReady = setInterval(() => {
      if (window.__sent && window.__sent.some((m) => m && m.type === "ready")) {
        clearInterval(checkReady);
        runSequence().catch((err) => {
          writeAssertions({
            sentinelAbsent: false,
            replacementPresent: false,
            badgePresent: false,
            badgeTextPresent: false,
            badgeText: "",
            rowsOutput: readRows(),
            error: String((err && err.message) || err),
          });
        });
      }
    }, 25);

    setTimeout(() => {
      clearInterval(checkReady);
      writeAssertions({
        sentinelAbsent: false,
        replacementPresent: false,
        badgePresent: false,
        badgeTextPresent: false,
        badgeText: "",
        rowsOutput: readRows(),
        error: "Timed out waiting for ready message",
      });
    }, 15000);
  </script>
</head>
<body>
  <div id="terminal-container"></div>
  <script src="file://${webviewJsPath}"></script>
</body>
</html>
`;

fs.writeFileSync(htmlPath, htmlContent);

// ---------------------------------------------------------------------------
// Drive Chrome over the DevTools protocol with real time, so xterm's
// rAF-driven render loop runs normally. No new npm dependencies: Node >= 22
// ships a global WebSocket client.
// ---------------------------------------------------------------------------
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

const httpJson = (port, method, urlPath) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Non-JSON response from ${urlPath}: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function main() {
  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ulw-vqa-profile-"));
  const chrome = spawn(chromeExecutable, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--window-size=800,600",
    "about:blank",
  ]);

  let chromeDead = false;
  chrome.on("exit", () => (chromeDead = true));

  const killChrome = () => {
    try {
      chrome.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    // Wait for the DevTools endpoint.
    let version = null;
    for (let i = 0; i < 100; i++) {
      if (chromeDead) throw new Error("Chrome exited before DevTools was ready");
      try {
        version = await httpJson(port, "GET", "/json/version");
        break;
      } catch {
        await sleep(100);
      }
    }
    if (!version) throw new Error("DevTools endpoint never became ready");

    // Open a fresh tab and grab its WebSocket URL.
    await httpJson(port, "PUT", "/json/new?about:blank");
    let target = null;
    for (let i = 0; i < 50; i++) {
      const list = await httpJson(port, "GET", "/json/list");
      target = list.find((t) => t.type === "page");
      if (target && target.webSocketDebuggerUrl) break;
      await sleep(100);
    }
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error("No page target with a debugger URL");
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const cdp = new Cdp(ws);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: `file://${htmlPath}` });

    // Poll the live DOM until the harness writes its assertions (bounded).
    let assertionsText = null;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (chromeDead) throw new Error("Chrome exited mid-run");
      const result = await cdp.send("Runtime.evaluate", {
        expression:
          '(() => { const n = document.getElementById("qa-results"); return n ? n.textContent : null; })()',
        returnByValue: true,
      });
      if (result && result.result && typeof result.result.value === "string") {
        assertionsText = result.result.value;
        break;
      }
      await sleep(150);
    }
    if (assertionsText === null) {
      throw new Error("Harness never wrote #qa-results within the deadline");
    }

    const assertions = JSON.parse(assertionsText.replace(/&quot;/g, '"'));

    // Screenshot AFTER the sequence completed, so the PNG shows final state.
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(evidenceDir, "screenshot.png"), Buffer.from(shot.data, "base64"));

    // DOM snapshot transcript (equivalent of --dump-dom, taken at the end).
    const dom = await cdp.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });
    fs.writeFileSync(path.join(evidenceDir, "transcript.txt"), dom.result.value);

    fs.writeFileSync(path.join(evidenceDir, "assertions.json"), JSON.stringify(assertions, null, 2));
    console.log("Assertions:", JSON.stringify(assertions));

    try {
      ws.close();
    } catch {}

    const pass =
      assertions.sentinelAbsent === true &&
      assertions.replacementPresent === true &&
      assertions.badgePresent === true &&
      assertions.badgeTextPresent === true &&
      assertions.badgeText === "Attached: probe";

    killChrome();
    if (!pass) {
      console.error("Assertions failed.");
      process.exit(1);
    }
    console.log("Visual QA script passed.");
    process.exit(0);
  } catch (err) {
    console.error(`Visual QA failed: ${err && err.message ? err.message : err}`);
    killChrome();
    process.exit(1);
  }
}

main();
