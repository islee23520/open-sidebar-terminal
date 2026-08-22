import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ptyMock from "../test/mocks/node-pty";
import type { HostMessage, WebviewMessage } from "../types";
import * as vscode from "../test/mocks/vscode";
import { TerminalManager } from "../terminals/TerminalManager";
import { TerminalProvider } from "./TerminalProvider";

vi.mock("node-pty", async () => vi.importActual("../test/mocks/node-pty"));

const nodePty = await vi.importActual<typeof ptyMock>("../test/mocks/node-pty");
const extensionUri = vscode.Uri.file("/extension") as unknown as import("vscode").Uri;

interface TestWebview {
  html: string;
  options: unknown;
  readonly cspSource: string;
  readonly postMessage: ReturnType<typeof vi.fn>;
  asWebviewUri(uri: unknown): unknown;
  onDidReceiveMessage(listener: (message: WebviewMessage) => void): vscode.Disposable;
  send(message: WebviewMessage): void;
}


function lastResult<T>(results: readonly { value: T }[]) {
  return results[results.length - 1];
}
function createView(): { readonly view: unknown; readonly webview: TestWebview } {
  const messageEmitter = new vscode.EventEmitter<WebviewMessage>();
  const disposeEmitter = new vscode.EventEmitter<void>();
  const webview: TestWebview = {
    html: "",
    options: undefined,
    cspSource: "vscode-webview:",
    postMessage: vi.fn(async (_message: HostMessage) => true),
    asWebviewUri: (uri) => uri,
    onDidReceiveMessage: messageEmitter.event,
    send: (message) => messageEmitter.fire(message),
  };
  return {
    view: {
      webview,
      onDidDispose: disposeEmitter.event,
    },
    webview,
  };
}

describe("TerminalProvider", () => {
  beforeEach(() => vscode.resetMocks());

  it("starts one shell from ready and forwards the terminal contract", () => {
    const manager = new TerminalManager();
    const createSpy = vi.spyOn(manager, "createTerminal");
    const writeSpy = vi.spyOn(manager, "write");
    const resizeSpy = vi.spyOn(manager, "resize");
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();

    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 90, rows: 28 });
    webview.send({ type: "input", data: "pwd\r" });
    webview.send({ type: "resize", cols: 100, rows: 30 });

    expect(createSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledWith("sidebar-shell", 90, 28);
    expect(writeSpy).toHaveBeenCalledWith("sidebar-shell", "pwd\r");
    expect(resizeSpy).toHaveBeenCalledWith("sidebar-shell", 100, 30);
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "config", fontSize: 14 }),
    );
    expect(webview.postMessage).toHaveBeenCalledWith({ type: "focus" });
    expect(webview.html).toContain('id="terminal-container"');
  });

  it("forwards PTY output and exit without pane or session metadata", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const process = lastResult(nodePty.spawn.mock.results)
      ?.value as ptyMock.MockPtyProcess;

    process.emitData("hello");
    process.emitExit(0);

    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "output",
      data: "hello",
    });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "exit",
      code: 0,
      signal: undefined,
    });
  });

  it("copies drag-selected terminal text through the host clipboard", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);

    webview.send({ type: "copy", text: "selected output" });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      "selected output",
    );
  });

  it("ignores empty drag selections", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);

    webview.send({ type: "copy", text: "" });

    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("saves pasted images and posts their path to the terminal", async () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });

    webview.send({
      type: "imagePasted",
      data: "data:image/png;base64,ZmFrZQ==",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "clipboardImage" }),
    );
  });

  it("rejects oversized images", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const largeBase64 = Buffer.alloc(6 * 1024 * 1024).toString("base64");

    webview.send({
      type: "imagePasted",
      data: `data:image/png;base64,${largeBase64}`,
    });

    expect(webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "clipboardImage" }),
    );
  });

  it("rejects malformed image data", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });

    webview.send({ type: "imagePasted", data: "not-a-data-url" });

    expect(webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "clipboardImage" }),
    );
  });

  it("kills the native shell when disposed", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const killSpy = vi.spyOn(manager, "kill");

    provider.dispose();

    expect(killSpy).toHaveBeenCalledWith("sidebar-shell");
  });

  it("reuses the existing shell and reacts to terminal settings", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const create = vi.spyOn(manager, "createTerminal");
    const resize = vi.spyOn(manager, "resize");
    vscode.setConfiguration({ "ulw.fontSize": 18 });

    webview.send({ type: "ready", cols: 120, rows: 40 });
    vscode.fireConfigurationChange("editor");
    vscode.fireConfigurationChange("ulw");

    expect(create).not.toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith("sidebar-shell", 120, 40);
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "config", fontSize: 18 }),
    );
  });

  it("filters unrelated PTY events and disconnects a disposed view", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    const count = webview.postMessage.mock.calls.length;

    manager["dataEmitter"].fire({ id: "other", data: "ignored" });
    manager["exitEmitter"].fire({ id: "other", code: 1 });
    (view as { onDidDispose: (listener: () => void) => vscode.Disposable })
      .onDidDispose(() => undefined);
    provider["view"] = undefined;
    provider["postMessage"]({ type: "focus" });

    expect(webview.postMessage).toHaveBeenCalledTimes(count);
  });

  it("opens an editor-group terminal surface with its own html and message bridge", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });

    provider.toggleEditorLocation();

    expect(provider.isEditorLocation()).toBe(true);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      "ulw.terminalEditor",
      "ULW Terminal",
      vscode.ViewColumn.Beside,
      expect.objectContaining({
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [expect.objectContaining({ fsPath: "/extension" })],
      }),
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.closeAuxiliaryBar",
    );

    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    expect(panel.webview.html).toContain('id="terminal-container"');
    expect(panel.webview.html).not.toBe(webview.html);
  });

  it("routes editor ready/input/resize and PTY output through the editor surface", () => {
    const manager = new TerminalManager();
    const createSpy = vi.spyOn(manager, "createTerminal");
    const writeSpy = vi.spyOn(manager, "write");
    const resizeSpy = vi.spyOn(manager, "resize");
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;

    panel.webview.send({ type: "ready", cols: 120, rows: 40 });
    panel.webview.send({ type: "input", data: "ls\r" });
    panel.webview.send({ type: "resize", cols: 130, rows: 42 });

    expect(createSpy).toHaveBeenCalledWith("sidebar-shell", 120, 40);
    expect(writeSpy).toHaveBeenCalledWith("sidebar-shell", "ls\r");
    expect(resizeSpy).toHaveBeenCalledWith("sidebar-shell", 130, 42);
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "config", fontSize: 14 }),
    );
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "focus" });

    const process = lastResult(nodePty.spawn.mock.results)
      ?.value as ptyMock.MockPtyProcess;
    process.emitData("editor-out");

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "output",
      data: "editor-out",
    });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "output",
      data: "editor-out",
    });
  });

  it("ignores ready and resize from the inactive sidebar while editor mode is active", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const resizeSpy = vi.spyOn(manager, "resize");
    const createSpy = vi.spyOn(manager, "createTerminal");

    provider.toggleEditorLocation();
    webview.send({ type: "ready", cols: 10, rows: 10 });
    webview.send({ type: "resize", cols: 11, rows: 11 });

    expect(createSpy).not.toHaveBeenCalled();
    expect(resizeSpy).not.toHaveBeenCalled();
  });

  it("returns to the sidebar surface when toggled again", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    expect(provider.isEditorLocation()).toBe(true);

    provider.toggleEditorLocation();

    expect(provider.isEditorLocation()).toBe(false);
    expect(panel.dispose).toHaveBeenCalledOnce();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.view.extension.ulwContainer",
    );
    expect(webview.postMessage).toHaveBeenCalledWith({ type: "focus" });
  });

  it("returns to sidebar when the editor panel is closed by the workbench", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    expect(provider.isEditorLocation()).toBe(true);

    (panel.dispose as unknown as () => void)();

    expect(provider.isEditorLocation()).toBe(false);
    expect(webview.postMessage).toHaveBeenCalledWith({ type: "focus" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.view.extension.ulwContainer",
    );
  });

  it("replays scrollback when the editor surface becomes ready", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const process = lastResult(nodePty.spawn.mock.results)
      ?.value as ptyMock.MockPtyProcess;
    process.emitData("prior output");

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    panel.webview.postMessage.mockClear();
    panel.webview.send({ type: "ready", cols: 100, rows: 30 });

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "output",
      data: "prior output",
    });
  });

  it("mirrors live PTY output to both surfaces so the inactive one keeps running session text", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    panel.webview.send({ type: "ready", cols: 100, rows: 30 });

    webview.postMessage.mockClear();
    panel.webview.postMessage.mockClear();

    const process = lastResult(nodePty.spawn.mock.results)
      ?.value as ptyMock.MockPtyProcess;
    process.emitData("agent still running\r\n");

    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: "output",
      data: "agent still running\r\n",
    });
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: "output",
      data: "agent still running\r\n",
    });
  });

  it("ignores input from the inactive sidebar while editor mode is active", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const writeSpy = vi.spyOn(manager, "write");

    provider.toggleEditorLocation();
    writeSpy.mockClear();
    webview.send({ type: "input", data: "ghost\r" });

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("reads ulw.defaultLocation as editor by default and sidebar on request", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);

    expect(provider.getDefaultLocation()).toBe("editor");
    vscode.setConfiguration({ "ulw.defaultLocation": "sidebar" });
    expect(provider.getDefaultLocation()).toBe("sidebar");
    vscode.setConfiguration({ "ulw.defaultLocation": "weird" });
    expect(provider.getDefaultLocation()).toBe("editor");
  });

  it("openAtConfiguredLocation opens the editor by default and only stays sidebar when configured", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);

    provider.openAtConfiguredLocation();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(provider.isEditorLocation()).toBe(true);

    vscode.window.createWebviewPanel.mockClear();
    vscode.setConfiguration({ "ulw.defaultLocation": "sidebar" });
    provider.openAtConfiguredLocation();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("starts the shell from editor ready without a sidebar surface", () => {
    const manager = new TerminalManager();
    const createSpy = vi.spyOn(manager, "createTerminal");
    const writeSpy = vi.spyOn(manager, "write");
    const provider = new TerminalProvider(extensionUri, manager);

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;

    expect(panel.webview.html).toContain('id="terminal-container"');
    expect(panel.webview.html).toContain("webview.js");

    panel.webview.send({ type: "ready", cols: 90, rows: 28 });
    panel.webview.send({ type: "input", data: "echo hi\r" });

    expect(createSpy).toHaveBeenCalledWith("sidebar-shell", 90, 28);
    expect(writeSpy).toHaveBeenCalledWith("sidebar-shell", "echo hi\r");
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "config" }),
    );
    expect(provider.isRunning()).toBe(true);
  });

  it("initializes a newly mounted sidebar even while editor mode is active", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });
    const process = lastResult(nodePty.spawn.mock.results)
      ?.value as ptyMock.MockPtyProcess;
    process.emitData("history");

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    panel.webview.send({ type: "ready", cols: 100, rows: 30 });

    const secondView = createView();
    provider.resolveWebviewView(secondView.view as never);
    secondView.webview.postMessage.mockClear();
    secondView.webview.send({ type: "ready", cols: 40, rows: 12 });

    expect(secondView.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "config", fontSize: 14 }),
    );
    expect(secondView.webview.postMessage).toHaveBeenCalledWith({
      type: "output",
      data: "history",
    });
  });

  it("dispose suppresses the workbench restore side effect", () => {
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    provider.toggleEditorLocation();
    vscode.commands.executeCommand.mockClear();

    provider.dispose();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.view.extension.ulwContainer",
    );
  });

  describe("characterization: current one-PTY provider behavior", () => {
    it("creates or resizes from ready and posts config before focus", () => {
      const manager = new TerminalManager();
      const createSpy = vi.spyOn(manager, "createTerminal");
      const resizeSpy = vi.spyOn(manager, "resize");
      const provider = new TerminalProvider(extensionUri, manager);
      const { view, webview } = createView();

      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 90, rows: 28 });
      webview.send({ type: "ready", cols: 100, rows: 30 });

      expect(createSpy).toHaveBeenCalledWith("sidebar-shell", 90, 28);
      expect(resizeSpy).toHaveBeenCalledWith("sidebar-shell", 100, 30);
      expect(nodePty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cols: 90, rows: 28 }),
      );
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "config", fontSize: 14 }),
      );
      expect(webview.postMessage).toHaveBeenCalledWith({ type: "focus" });
    });

    it("ignores input and resize from the inactive surface", () => {
      const manager = new TerminalManager();
      const provider = new TerminalProvider(extensionUri, manager);
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      const writeSpy = vi.spyOn(manager, "write");
      const resizeSpy = vi.spyOn(manager, "resize");

      provider.toggleEditorLocation();
      writeSpy.mockClear();
      resizeSpy.mockClear();
      webview.send({ type: "input", data: "ghost\r" });
      webview.send({ type: "resize", cols: 11, rows: 11 });

      expect(writeSpy).not.toHaveBeenCalled();
      expect(resizeSpy).not.toHaveBeenCalled();
    });

    it("replays scrollback to a freshly read surface, caps it, and clears on exit", () => {
      const manager = new TerminalManager();
      const provider = new TerminalProvider(extensionUri, manager);
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      const process = lastResult(nodePty.spawn.mock.results)
        ?.value as ptyMock.MockPtyProcess;
      const large = "x".repeat(500_100);
      process.emitData(large);

      provider.toggleEditorLocation();
      const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
        ?.value as vscode.MockWebviewPanel;
      panel.webview.postMessage.mockClear();
      panel.webview.send({ type: "ready", cols: 100, rows: 30 });

      expect(panel.webview.postMessage).toHaveBeenCalledWith({
        type: "output",
        data: large.slice(-500_000),
      });
      expect(panel.webview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "output", data: large }),
      );

      panel.webview.postMessage.mockClear();
      process.emitExit(0);
      panel.webview.send({ type: "ready", cols: 100, rows: 30 });

      expect(webview.postMessage).toHaveBeenCalledWith({
        type: "exit",
        code: 0,
        signal: undefined,
      });
      expect(panel.webview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "output", data: large.slice(-1) }),
      );
    });

    it("posts exit banner payload and resets scrollback on exit", () => {
      const manager = new TerminalManager();
      const provider = new TerminalProvider(extensionUri, manager);
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      const process = lastResult(nodePty.spawn.mock.results)
        ?.value as ptyMock.MockPtyProcess;
      process.emitData("before-exit");
      process.emitExit(12, 9);

      expect(webview.postMessage).toHaveBeenCalledWith({
        type: "exit",
        code: 12,
        signal: 9,
      });

      provider.toggleEditorLocation();
      const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
        ?.value as vscode.MockWebviewPanel;
      panel.webview.postMessage.mockClear();
      panel.webview.send({ type: "ready", cols: 100, rows: 30 });

      expect(panel.webview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "output", data: "before-exit" }),
      );
    });

    it("keeps the same PTY alive across surface switching", () => {
      const manager = new TerminalManager();
      const createSpy = vi.spyOn(manager, "createTerminal");
      const provider = new TerminalProvider(extensionUri, manager);
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });

      expect(provider.terminalCount()).toBe(1);
      provider.toggleEditorLocation();
      expect(provider.terminalCount()).toBe(1);
      provider.toggleEditorLocation();
      expect(provider.terminalCount()).toBe(1);
      expect(createSpy).toHaveBeenCalledOnce();
      expect(nodePty.spawn).toHaveBeenCalledOnce();
    });
  });
});
