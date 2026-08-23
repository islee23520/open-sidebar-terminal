import * as assert from "assert";
import * as vscode from "vscode";

interface UlwExtensionApi {
  readonly onTerminalStart: vscode.Event<number>;
  readonly onTerminalData: vscode.Event<string>;
  isTerminalRunning(): boolean;
  terminalCount(): number;
  writeToTerminal(data: string): void;
}

function waitForEvent<T>(
  event: vscode.Event<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const subscription = event((value) => {
      clearTimeout(timeout);
      subscription.dispose();
      resolve(value);
    });
  });
}

function waitForOutput(
  event: vscode.Event<string>,
  expected: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Did not observe ${expected}; output was ${output}`));
    }, timeoutMs);
    const subscription = event((chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timeout);
        subscription.dispose();
        resolve(output);
      }
    });
  });
}

suite("Native sidebar terminal", () => {
  test("opens one PTY and executes shell input", async () => {
    const extension = vscode.extensions.getExtension<UlwExtensionApi>(
      "islee23520.opencode-sidebar-tui",
    );
    assert.ok(extension, "Extension should be available in the test host");
    const api = await extension.activate();

    const started = waitForEvent(api.onTerminalStart, 10000);
    const output = waitForOutput(api.onTerminalData, "__ULW_E2E_OK__", 10000);
    await vscode.commands.executeCommand(
      "workbench.view.extension.ulwContainer",
    );
    const pid = await started;
    api.writeToTerminal("printf '__ULW_E2E_OK__\\n'\r");

    assert.ok(pid > 0, "PTY should expose a process id");
    assert.ok((await output).includes("__ULW_E2E_OK__"));
    assert.strictEqual(api.isTerminalRunning(), true);
    assert.strictEqual(api.terminalCount(), 1);
  });

  test("registers Herdr explorer commands after activate", async () => {
    const extension = vscode.extensions.getExtension<UlwExtensionApi>(
      "islee23520.opencode-sidebar-tui",
    );
    assert.ok(extension, "Extension should be available in the test host");
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("ulw.herdr.refreshExplorer"),
      "ulw.herdr.refreshExplorer must be registered after activate",
    );
    assert.ok(
      commands.includes("ulw.herdr.openAgent"),
      "ulw.herdr.openAgent must be registered after activate",
    );
  });
});
