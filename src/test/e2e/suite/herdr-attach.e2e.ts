import * as assert from "assert";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

interface SourceState {
  readonly source: "shell" | "herdr";
  readonly phase: "shell" | "attaching" | "attached" | "detaching" | "error";
  readonly label?: string;
  readonly message?: string;
}

interface SurfaceSnapshot {
  readonly sourceState: SourceState;
  readonly renderedText: string;
}

interface UlwExtensionApi {
  readonly onTerminalStart: vscode.Event<number>;
  readonly onTerminalData: vscode.Event<string>;
  readonly onTerminalExit: vscode.Event<number>;
  readonly onSourceState: vscode.Event<SourceState>;
  isTerminalRunning(): boolean;
  terminalCount(): number;
  writeToTerminal(data: string): void;
  toggleEditorLocation(): void;
  attachToHerdr(target: { terminalId: string; label?: string }): Promise<void>;
  detachHerdr(): Promise<void>;
  resizeTerminal(cols: number, rows: number): void;
  getSurfaceSnapshot(): SurfaceSnapshot;
}

interface ScratchWorkspace {
  readonly tempDir: string;
  readonly workspaceId: string;
  readonly rootPaneId: string;
  readonly rootTerminalId: string;
  readonly deadPaneId: string;
  readonly deadTerminalId: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ProcessInspection {
  readonly processIds: readonly number[];
  readonly inspectionFailed: boolean;
  readonly error?: string;
}

const HERDR = process.env.ULW_E2E_HERDR ?? "/Users/ilseoblee/.local/bin/herdr";
const EVIDENCE_DIR = path.resolve(
  ".omo/evidence/task-10-herdr-agent-attach",
);
const COMMAND_TIMEOUT_MS = 10_000;
const EVENT_TIMEOUT_MS = 10_000;

function runHerdr(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      HERDR,
      [...args],
      { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${HERDR} ${args.join(" ")} failed: ${stderr || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseResult(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
  assert.ok(parsed.result, `Herdr response had no result: ${stdout}`);
  return parsed.result;
}

function waitForEvent<T>(
  event: vscode.Event<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const subscription = event((value) => {
      if (!predicate(value)) {
        return;
      }
      timeout.removeEventListener("abort", onAbort);
      subscription.dispose();
      resolve(value);
    });
    const onAbort = () => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for ${description}`));
    };
    timeout.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForOutput(
  event: vscode.Event<string>,
  expected: string,
): Promise<string> {
  let output = "";
  return waitForEvent(
    event,
    (chunk) => {
      output += chunk;
      return output.includes(expected);
    },
    `terminal output ${expected}; output was ${output}`,
  ).then(() => output);
}

async function inspectProcesses(paneId: string): Promise<ProcessInspection> {
  try {
    const result = parseResult(
      (await runHerdr(["pane", "process-info", "--pane", paneId])).stdout,
    );
    const processInfo = result.process_info as
      | {
          shell_pid?: number;
          foreground_processes?: Array<{ pid?: number }>;
        }
      | undefined;
    const ids = [
      processInfo?.shell_pid,
      ...(processInfo?.foreground_processes ?? []).map((entry) => entry.pid),
    ];
    return {
      processIds: [
        ...new Set(ids.filter((id): id is number => Number.isInteger(id))),
      ],
      inspectionFailed: false,
    };
  } catch (error) {
    return {
      processIds: [],
      inspectionFailed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertPhaseOrder(
  phases: readonly SourceState["phase"][],
  first: SourceState["phase"],
  second: SourceState["phase"],
): void {
  const firstIndex = phases.indexOf(first);
  const secondIndex = phases.indexOf(second);
  assert.ok(firstIndex >= 0, `Expected phase ${first}; observed ${phases.join(", ")}`);
  assert.ok(
    secondIndex > firstIndex,
    `Expected ${first} before ${second}; observed ${phases.join(", ")}`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

suite("Live Herdr terminal attach", () => {
  let scratch: ScratchWorkspace | undefined;
  const scratchProcessIds = new Set<number>();

  suiteSetup(async function () {
    this.timeout(20_000);
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });

    const version = await runHerdr(["--version"]);
    assert.match(
      version.stdout,
      /^herdr 0\.8\./,
      `Live suite requires Herdr 0.8.x, got ${version.stdout.trim()}`,
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ulw-e2e-"));
    const created = parseResult(
      (
        await runHerdr([
          "workspace",
          "create",
          "--cwd",
          tempDir,
          "--label",
          "ulw-e2e",
          "--no-focus",
        ])
      ).stdout,
    );
    const workspace = created.workspace as { workspace_id?: string };
    const rootPane = created.root_pane as {
      pane_id?: string;
      terminal_id?: string;
    };
    assert.ok(workspace.workspace_id, "workspace create must return workspace_id");
    assert.ok(rootPane.pane_id, "workspace create must return root pane_id");
    assert.ok(rootPane.terminal_id, "workspace create must return root terminal_id");

    await runHerdr([
      "pane",
      "wait-output",
      rootPane.pane_id,
      "--regex",
      ".+",
      "--source",
      "visible",
      "--lines",
      "20",
      "--timeout",
      "5000",
      "--raw",
    ]);

    const split = parseResult(
      (
        await runHerdr([
          "pane",
          "split",
          rootPane.pane_id,
          "--direction",
          "right",
          "--cwd",
          tempDir,
          "--no-focus",
        ])
      ).stdout,
    );
    const deadPane = split.pane as { pane_id?: string; terminal_id?: string };
    assert.ok(deadPane.pane_id, "pane split must return pane_id");
    assert.ok(deadPane.terminal_id, "pane split must return terminal_id");

    await runHerdr([
      "pane",
      "run",
      rootPane.pane_id,
      "printf 'ULW_E2E_READY'; exec /bin/sh",
    ]);
    await runHerdr([
      "pane",
      "wait-output",
      rootPane.pane_id,
      "--match",
      "ULW_E2E_READY",
      "--source",
      "recent-unwrapped",
      "--lines",
      "50",
      "--timeout",
      "5000",
      "--raw",
    ]);

    scratch = {
      tempDir,
      workspaceId: workspace.workspace_id,
      rootPaneId: rootPane.pane_id,
      rootTerminalId: rootPane.terminal_id,
      deadPaneId: deadPane.pane_id,
      deadTerminalId: deadPane.terminal_id,
    };
    const rootInspection = await inspectProcesses(rootPane.pane_id);
    const deadInspection = await inspectProcesses(deadPane.pane_id);
    assert.strictEqual(
      rootInspection.inspectionFailed,
      false,
      `Root pane process inspection failed: ${rootInspection.error ?? "unknown error"}`,
    );
    assert.strictEqual(
      deadInspection.inspectionFailed,
      false,
      `Dead-target pane process inspection failed: ${deadInspection.error ?? "unknown error"}`,
    );
    for (const pid of [...rootInspection.processIds, ...deadInspection.processIds]) {
      scratchProcessIds.add(pid);
    }
  });

  test("attaches, streams input, resizes, detaches, and restores shell on a dead target", async function () {
    this.timeout(20_000);
    assert.ok(scratch, "Scratch workspace should be created by suite setup");

    const extension = vscode.extensions.getExtension<UlwExtensionApi>(
      "islee23520.opencode-sidebar-tui",
    );
    assert.ok(extension, "Extension should be available in the test host");
    const api = await extension.activate();
    const sourceStates: SourceState[] = [];
    const sourceStateSubscription = api.onSourceState((state) => {
      sourceStates.push(state);
    });

    const shellStarted = api.isTerminalRunning()
      ? Promise.resolve(1)
      : waitForEvent(
          api.onTerminalStart,
          (pid) => pid > 0,
          "the retained local shell to start",
        );
    await vscode.commands.executeCommand("workbench.view.extension.ulwContainer");
    await shellStarted;

    const shellPrimed = waitForOutput(api.onTerminalData, "ULW_E2E_SHELL");
    api.writeToTerminal("printf 'ULW_E2E_SHELL\\n'\r");
    await shellPrimed;

    const happyAttachPhaseStart = sourceStates.length;
    const attached = waitForEvent(
      api.onSourceState,
      (state) => state.phase === "attached",
      "sourceState attached",
    );
    await api.attachToHerdr({
      terminalId: scratch.rootTerminalId,
      label: "ulw-e2e",
    });
    assert.strictEqual((await attached).source, "herdr");
    assertPhaseOrder(
      sourceStates.slice(happyAttachPhaseStart).map((state) => state.phase),
      "attaching",
      "attached",
    );
    assert.match(api.getSurfaceSnapshot().renderedText, /ULW_E2E_READY/);

    const inputRoundTrip = waitForOutput(api.onTerminalData, "ULW_E2E_IN2");
    api.writeToTerminal("printf 'ULW_E2E_IN2\\n'\r");
    await inputRoundTrip;
    assert.match(api.getSurfaceSnapshot().renderedText, /ULW_E2E_IN2/);

    const resized = waitForEvent(
      api.onTerminalData,
      () => true,
      "a Herdr frame after resize",
    );
    api.resizeTerminal(90, 30);
    await resized;
    const resizedSnapshot = api.getSurfaceSnapshot();
    assert.strictEqual(resizedSnapshot.sourceState.phase, "attached");
    assert.strictEqual(resizedSnapshot.sourceState.source, "herdr");

    const detachPhaseStart = sourceStates.length;
    const detached = waitForEvent(
      api.onSourceState,
      (state) => state.phase === "shell",
      "sourceState shell after detach",
    );
    await api.detachHerdr();
    await detached;
    assertPhaseOrder(
      sourceStates.slice(detachPhaseStart).map((state) => state.phase),
      "detaching",
      "shell",
    );
    assert.match(api.getSurfaceSnapshot().renderedText, /ULW_E2E_SHELL/);

    const shellAfterDetach = waitForOutput(
      api.onTerminalData,
      "ULW_E2E_SHELL_AFTER_DETACH",
    );
    api.writeToTerminal("printf 'ULW_E2E_SHELL_AFTER_DETACH\\n'\r");
    await shellAfterDetach;

    const terminalExits: number[] = [];
    const terminalExitSubscription = api.onTerminalExit((code) => {
      terminalExits.push(code);
    });
    await runHerdr(["pane", "close", scratch.deadPaneId]);
    const attachError = waitForEvent(
      api.onSourceState,
      (state) => state.phase === "error",
      "sourceState error for a dead Herdr terminal",
    );
    await api.attachToHerdr({
      terminalId: scratch.deadTerminalId,
      label: "dead-ulw-e2e",
    });
    const errorState = await attachError;
    assert.strictEqual(errorState.source, "shell");
    assert.strictEqual(api.getSurfaceSnapshot().sourceState.phase, "shell");

    const shellAfterError = waitForOutput(
      api.onTerminalData,
      "ULW_E2E_SHELL_AFTER_ERROR",
    );
    api.writeToTerminal("printf 'ULW_E2E_SHELL_AFTER_ERROR\\n'\r");
    await shellAfterError;
    terminalExitSubscription.dispose();
    sourceStateSubscription.dispose();
    assert.deepStrictEqual(terminalExits, [], "The retained shell must not exit");
    assert.strictEqual(api.isTerminalRunning(), true);
    assert.strictEqual(api.terminalCount(), 1);
    assert.match(
      api.getSurfaceSnapshot().renderedText,
      /ULW_E2E_SHELL_AFTER_ERROR/,
    );
  });

  suiteTeardown(async function () {
    this.timeout(20_000);
    if (!scratch) {
      return;
    }

    const finalProcessInspection = await inspectProcesses(scratch.rootPaneId);
    for (const pid of finalProcessInspection.processIds) {
      scratchProcessIds.add(pid);
    }

    const close = await runHerdr([
      "workspace",
      "close",
      scratch.workspaceId,
    ]);
    const listed = parseResult((await runHerdr(["workspace", "list"])).stdout);
    const workspaces = (listed.workspaces ?? []) as Array<{
      workspace_id?: string;
    }>;
    const workspaceAbsent = !workspaces.some(
      (entry) => entry.workspace_id === scratch?.workspaceId,
    );
    await fs.rm(scratch.tempDir, { recursive: true, force: true });
    const tempDirRemoved = await fs.access(scratch.tempDir).then(
      () => false,
      () => true,
    );
    const liveProcessIds = [...scratchProcessIds].filter(isProcessAlive);

    const receipt = {
      workspaceId: scratch.workspaceId,
      rootPaneId: scratch.rootPaneId,
      deadPaneId: scratch.deadPaneId,
      closeResponse: JSON.parse(close.stdout),
      workspaceAbsent,
      processInspection: finalProcessInspection,
      checkedProcessIds: [...scratchProcessIds],
      liveProcessIds,
      noLeftoverChildren:
        !finalProcessInspection.inspectionFailed && liveProcessIds.length === 0,
      tempDir: scratch.tempDir,
      tempDirRemoved,
    };
    await fs.writeFile(
      path.join(EVIDENCE_DIR, "cleanup.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );

    assert.strictEqual(workspaceAbsent, true, "Scratch workspace must be absent");
    assert.strictEqual(
      finalProcessInspection.inspectionFailed,
      false,
      `Final process inspection failed: ${finalProcessInspection.error ?? "unknown error"}`,
    );
    assert.deepStrictEqual(liveProcessIds, [], "Scratch children must be gone");
    assert.strictEqual(tempDirRemoved, true, "Scratch temp directory must be removed");
  });
});
