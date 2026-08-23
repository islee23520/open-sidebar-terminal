import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ptyMock from "../test/mocks/node-pty";
import type { HostMessage, WebviewMessage } from "../types";
import * as vscode from "../test/mocks/vscode";
import {
  HerdrAttachController,
  type HerdrAttachPresenter,
} from "../herdr/HerdrAttachController";
import { TerminalManager } from "../terminals/TerminalManager";
import type {
  TerminalTransport,
  TerminalTransportExitReason,
} from "../terminals/TerminalTransport";
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

class FakeHerdrTransport implements TerminalTransport {
  public readonly kind = "herdr-control" as const;
  private readonly outputEmitter = new vscode.EventEmitter<{
    data: string;
    replay: "append" | "replace";
  }>();
  private readonly exitEmitter = new vscode.EventEmitter<{
    reason: TerminalTransportExitReason;
    message?: string;
  }>();
  public readonly onOutput = this.outputEmitter.event;
  public readonly onExit = this.exitEmitter.event;
  public readonly write = vi.fn();
  public readonly resize = vi.fn();
  public readonly close = vi.fn(async () => undefined);

  public output(data: string, replay: "append" | "replace"): void {
    this.outputEmitter.fire({ data, replay });
  }

  public exit(reason: TerminalTransportExitReason, message?: string): void {
    this.exitEmitter.fire(message ? { reason, message } : { reason });
  }
}

function createAttachHarness(): {
  readonly manager: TerminalManager;
  readonly provider: TerminalProvider;
  readonly controller: HerdrAttachController;
  readonly transports: FakeHerdrTransport[];
} {
  const manager = new TerminalManager();
  const transports: FakeHerdrTransport[] = [];
  let provider!: TerminalProvider;
  const presenter: HerdrAttachPresenter = {
    postReset: () => provider.postReset(),
    postOutput: (data) => provider.postOutput(data),
    postSourceState: (state) => provider.postSourceState(state),
  };
  const controller = new HerdrAttachController({
    manager,
    terminalId: "sidebar-shell",
    transportFactory: () => {
      const transport = new FakeHerdrTransport();
      transports.push(transport);
      return transport;
    },
    presenter,
  });
  provider = new TerminalProvider(extensionUri, manager, controller);
  return { manager, provider, controller, transports };
}

async function attach(
  controller: HerdrAttachController,
  transports: FakeHerdrTransport[],
  label = "Agent A",
): Promise<FakeHerdrTransport> {
  const attaching = controller.attach(
    { terminalId: "herdr-terminal", label },
    { cols: 80, rows: 24 },
  );
  const transport = transports[0];
  transport.output("HERDR FULL", "replace");
  await attaching;
  return transport;
}

function posted(webview: { readonly postMessage: ReturnType<typeof vi.fn> }): unknown[] {
  return webview.postMessage.mock.calls.map(([message]) => message);
}

describe("TerminalProvider", () => {
  beforeEach(() => {
    vscode.resetMocks();
    vscode.setConfiguration({ "ulw.sidebar.enabled": true });
  });

  describe("Herdr controller integration", () => {
    it("mirrors attach output to both mounted surfaces while badge and reset target the active surface", async () => {
      const { provider, controller, transports } = createAttachHarness();
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      provider.toggleEditorLocation();
      const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
        ?.value as vscode.MockWebviewPanel;
      panel.webview.send({ type: "ready", cols: 100, rows: 30 });
      webview.postMessage.mockClear();
      panel.webview.postMessage.mockClear();

      await attach(controller, transports);

      expect(posted(panel.webview)).toEqual([
        {
          type: "sourceState",
          source: "herdr",
          phase: "attaching",
          label: "Agent A",
        },
        { type: "reset" },
        { type: "output", data: "HERDR FULL" },
        {
          type: "sourceState",
          source: "herdr",
          phase: "attached",
          label: "Agent A",
        },
      ]);
      expect(posted(webview)).toEqual([
        { type: "output", data: "HERDR FULL" },
      ]);
      expect(posted(webview)).toContainEqual({
        type: "output",
        data: "HERDR FULL",
      });
      expect(posted(webview)).not.toContainEqual(
        expect.objectContaining({ type: "sourceState" }),
      );
      expect(posted(webview)).not.toContainEqual({ type: "reset" });
      expect(posted(panel.webview)).toContainEqual({
        type: "output",
        data: "HERDR FULL",
      });
      expect(posted(panel.webview)).toContainEqual({
        type: "sourceState",
        source: "herdr",
        phase: "attached",
        label: "Agent A",
      });
    });

    it("posts reset immediately before live replacement output", async () => {
      const { provider, controller, transports } = createAttachHarness();
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      const transport = await attach(controller, transports);
      webview.postMessage.mockClear();

      transport.output("HERDR REPLACEMENT", "replace");

      expect(posted(webview)).toEqual([
        { type: "reset" },
        { type: "output", data: "HERDR REPLACEMENT" },
      ]);
    });

    it("rehydrates attached source and current badge on every surface ready", async () => {
      const { manager, provider, controller, transports } = createAttachHarness();
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      await attach(controller, transports);
      transports[0].output(" + DELTA", "append");
      const ensureLocalShell = vi.spyOn(manager, "ensureLocalShell");

      provider.toggleEditorLocation();
      const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
        ?.value as vscode.MockWebviewPanel;
      panel.webview.postMessage.mockClear();
      panel.webview.send({ type: "ready", cols: 100, rows: 30 });

      expect(posted(panel.webview)).toEqual([
        expect.objectContaining({ type: "config", fontSize: 14 }),
        {
          type: "sourceState",
          source: "herdr",
          phase: "attached",
          label: "Agent A",
        },
        { type: "reset" },
        { type: "output", data: "HERDR FULL + DELTA" },
        { type: "focus" },
      ]);
      expect(ensureLocalShell).not.toHaveBeenCalled();
      expect(manager.activeSource("sidebar-shell")).toBe("herdr-control");
    });

    it("rehydrates a switched surface mid-attach without replacing the attachment", async () => {
      const { manager, provider, controller, transports } = createAttachHarness();
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      const shell = lastResult(nodePty.spawn.mock.results)
        ?.value as ptyMock.MockPtyProcess;
      shell.emitData("shell history");
      const ensureLocalShell = vi.spyOn(manager, "ensureLocalShell");
      const attaching = controller.attach(
        { terminalId: "herdr-terminal", label: "Agent A" },
        { cols: 80, rows: 24 },
      );

      provider.toggleEditorLocation();
      const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
        ?.value as vscode.MockWebviewPanel;
      panel.webview.postMessage.mockClear();
      panel.webview.send({ type: "ready", cols: 100, rows: 30 });

      expect(posted(panel.webview)).toEqual([
        expect.objectContaining({ type: "config", fontSize: 14 }),
        {
          type: "sourceState",
          source: "herdr",
          phase: "attaching",
          label: "Agent A",
        },
        { type: "reset" },
        { type: "output", data: "shell history" },
        { type: "focus" },
      ]);
      expect(ensureLocalShell).not.toHaveBeenCalled();

      transports[0].output("HERDR FULL", "replace");
      await attaching;
      expect(manager.activeSource("sidebar-shell")).toBe("herdr-control");
    });

    it("rejects inactive input and routes active input and provider writes to Herdr", async () => {
      const { provider, controller, transports } = createAttachHarness();
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      const transport = await attach(controller, transports);
      provider.toggleEditorLocation();
      const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
        ?.value as vscode.MockWebviewPanel;
      panel.webview.send({ type: "ready", cols: 100, rows: 30 });
      transport.write.mockClear();

      webview.send({ type: "input", data: "inactive\r" });
      panel.webview.send({ type: "input", data: "active\r" });
      provider.write("selection-or-file");

      expect(transport.write.mock.calls).toEqual([
        ["active\r"],
        ["selection-or-file"],
      ]);
    });

    it("restores shell without shell-exit banner when bridge closes", async () => {
      const { provider, controller, transports } = createAttachHarness();
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      const shell = lastResult(nodePty.spawn.mock.results)
        ?.value as ptyMock.MockPtyProcess;
      shell.emitData("shell replay");
      const transport = await attach(controller, transports);
      webview.postMessage.mockClear();

      transport.exit("takeover", "taken elsewhere");
      await Promise.resolve();
      await Promise.resolve();

      expect(posted(webview)).toEqual([
        {
          type: "sourceState",
          source: "shell",
          phase: "error",
          message: "taken elsewhere",
        },
        { type: "sourceState", source: "shell", phase: "shell" },
      ]);
      expect(posted(webview)).not.toContainEqual(
        expect.objectContaining({ type: "exit" }),
      );
    });

    it("leaves shell display untouched when attach fails before the first frame", async () => {
      const { provider, controller, transports } = createAttachHarness();
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });
      webview.postMessage.mockClear();

      const attaching = controller.attach(
        { terminalId: "herdr-terminal", label: "Agent A" },
        { cols: 80, rows: 24 },
      );
      transports[0].exit("protocol-error", "bad first frame");
      await attaching;

      expect(posted(webview)).toEqual([
        {
          type: "sourceState",
          source: "herdr",
          phase: "attaching",
          label: "Agent A",
        },
        {
          type: "sourceState",
          source: "shell",
          phase: "error",
          message: "bad first frame",
        },
        { type: "sourceState", source: "shell", phase: "shell" },
      ]);
      expect(posted(webview)).not.toContainEqual({ type: "reset" });
    });
  });

  it("starts one shell from ready and forwards the terminal contract", () => {
    const manager = new TerminalManager();
    const ensureSpy = vi.spyOn(manager, "ensureLocalShell");
    const writeSpy = vi.spyOn(manager, "write");
    const resizeSpy = vi.spyOn(manager, "resize");
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();

    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 90, rows: 28 });
    webview.send({ type: "input", data: "pwd\r" });
    webview.send({ type: "resize", cols: 100, rows: 30 });

    expect(ensureSpy).toHaveBeenCalledOnce();
    expect(ensureSpy).toHaveBeenCalledWith("sidebar-shell", 90, 28);
    expect(writeSpy).toHaveBeenCalledWith("sidebar-shell", "pwd\r");
    expect(resizeSpy).toHaveBeenCalledWith("sidebar-shell", 100, 30);
    expect(posted(webview)).toEqual([
      expect.objectContaining({ type: "config", fontSize: 14 }),
      { type: "sourceState", source: "shell", phase: "shell" },
      { type: "reset" },
      { type: "focus" },
    ]);
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
    let resolveClipboard!: () => void;
    const clipboardPosted = new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    });
    webview.postMessage.mockImplementation(async (message: HostMessage) => {
      if (message.type === "clipboardImage") {
        resolveClipboard();
      }
      return true;
    });

    webview.send({
      type: "imagePasted",
      data: "data:image/png;base64,ZmFrZQ==",
    });

    await clipboardPosted;
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

    manager["dataEmitter"].fire({
      id: "other",
      data: "ignored",
      replay: "append",
    });
    manager["exitEmitter"].fire({
      id: "other",
      code: 1,
      reason: "process-exit",
    });
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
    const ensureSpy = vi.spyOn(manager, "ensureLocalShell");
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

    expect(ensureSpy).toHaveBeenCalledWith("sidebar-shell", 120, 40);
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

  it("keeps the editor panel when sidebar ULW is disabled", () => {
    vscode.setConfiguration({ "ulw.sidebar.enabled": false });
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    const { view, webview } = createView();
    provider.resolveWebviewView(view as never);
    webview.send({ type: "ready", cols: 80, rows: 24 });

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    vscode.commands.executeCommand.mockClear();

    provider.toggleEditorLocation();

    expect(provider.isEditorLocation()).toBe(true);
    expect(panel.dispose).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.view.extension.ulwContainer",
    );
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

  it("stays in editor mode when the panel is closed and sidebar ULW is disabled", () => {
    vscode.setConfiguration({ "ulw.sidebar.enabled": false });
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;
    vscode.commands.executeCommand.mockClear();

    (panel.dispose as unknown as () => void)();

    expect(provider.isEditorLocation()).toBe(true);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
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

    expect(posted(panel.webview)).toEqual([
      expect.objectContaining({ type: "config", fontSize: 14 }),
      { type: "sourceState", source: "shell", phase: "shell" },
      { type: "reset" },
      { type: "output", data: "prior output" },
      { type: "focus" },
    ]);
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
    vscode.setConfiguration({
      "ulw.defaultLocation": "sidebar",
      "ulw.sidebar.enabled": true,
    });
    provider.openAtConfiguredLocation();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("opens the editor even when defaultLocation is sidebar if sidebar ULW is disabled", () => {
    vscode.setConfiguration({
      "ulw.defaultLocation": "sidebar",
      "ulw.sidebar.enabled": false,
    });
    const manager = new TerminalManager();
    const provider = new TerminalProvider(extensionUri, manager);
    provider.openAtConfiguredLocation();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(provider.isEditorLocation()).toBe(true);
  });

  it("starts the shell from editor ready without a sidebar surface", () => {
    const manager = new TerminalManager();
    const ensureSpy = vi.spyOn(manager, "ensureLocalShell");
    const writeSpy = vi.spyOn(manager, "write");
    const provider = new TerminalProvider(extensionUri, manager);

    provider.toggleEditorLocation();
    const panel = lastResult(vscode.window.createWebviewPanel.mock.results)
      ?.value as vscode.MockWebviewPanel;

    expect(panel.webview.html).toContain('id="terminal-container"');
    expect(panel.webview.html).toContain("webview.js");

    panel.webview.send({ type: "ready", cols: 90, rows: 28 });
    panel.webview.send({ type: "input", data: "echo hi\r" });

    expect(ensureSpy).toHaveBeenCalledWith("sidebar-shell", 90, 28);
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
    const { view } = createView();
    provider.resolveWebviewView(view as never);
    provider.toggleEditorLocation();
    vscode.commands.executeCommand.mockClear();

    provider.dispose();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.view.extension.ulwContainer",
    );
  });

  describe("characterization: current one-PTY provider behavior", () => {
    it("ensures or resizes from ready and posts config before focus", () => {
      const manager = new TerminalManager();
      const ensureSpy = vi.spyOn(manager, "ensureLocalShell");
      const resizeSpy = vi.spyOn(manager, "resize");
      const provider = new TerminalProvider(extensionUri, manager);
      const { view, webview } = createView();

      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 90, rows: 28 });
      webview.send({ type: "ready", cols: 100, rows: 30 });

      expect(ensureSpy).toHaveBeenCalledWith("sidebar-shell", 90, 28);
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
      const ensureSpy = vi.spyOn(manager, "ensureLocalShell");
      const provider = new TerminalProvider(extensionUri, manager);
      const { view, webview } = createView();
      provider.resolveWebviewView(view as never);
      webview.send({ type: "ready", cols: 80, rows: 24 });

      expect(provider.terminalCount()).toBe(1);
      provider.toggleEditorLocation();
      expect(provider.terminalCount()).toBe(1);
      provider.toggleEditorLocation();
      expect(provider.terminalCount()).toBe(1);
      expect(ensureSpy).toHaveBeenCalledOnce();
      expect(nodePty.spawn).toHaveBeenCalledOnce();
    });
  });
});
