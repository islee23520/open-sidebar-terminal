import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscodeApi from "vscode";
import type * as vscodeTypes from "../test/mocks/vscode";
import type { MessageRouterProviderBridge } from "./MessageRouter";
import { MessageRouter } from "./MessageRouter";
import { OutputChannelService } from "../services/OutputChannelService";
import type { TerminalManager } from "../terminals/TerminalManager";
import type { OutputCaptureManager } from "../services/OutputCaptureManager";

const mockWriteFile = vi.hoisted(() => vi.fn(async () => undefined));
const mockUnlink = vi.hoisted(() => vi.fn(async () => undefined));
const mockNormalize = vi.hoisted(() =>
  vi.fn((value: string) => value.replace(/\\/g, "/")),
);
const mockJoin = vi.hoisted(() =>
  vi.fn((...parts: string[]) => parts.join("/")),
);
const mockTmpdir = vi.hoisted(() => vi.fn(() => "/tmp/opencode-tests"));
const mockRandomUUID = vi.hoisted(() => vi.fn(() => "uuid-1234"));

vi.mock("fs", () => ({
  promises: {
    writeFile: mockWriteFile,
    unlink: mockUnlink,
  },
}));

vi.mock("path", () => ({
  join: mockJoin,
  normalize: mockNormalize,
}));

vi.mock("os", () => ({
  tmpdir: mockTmpdir,
}));

vi.mock("crypto", () => ({
  randomUUID: mockRandomUUID,
}));

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

type MockTerminal = {
  name: string;
  show: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  shellIntegration?: { cwd?: { fsPath?: string } };
};

describe("MessageRouter", () => {
  let context: vscodeApi.ExtensionContext;
  let logger: OutputChannelService;
  let provider: MessageRouterProviderBridge;
  let terminalManager: Pick<
    TerminalManager,
    "writeToTerminal" | "resizeTerminal"
  >;
  let captureManager: Pick<OutputCaptureManager, "startCapture">;
  let router: MessageRouter;

  function createProviderBridge(): MessageRouterProviderBridge {
    return {
      startOpenCode: vi.fn(async () => undefined),
      switchToTmuxSession: vi.fn(async () => undefined),
      killTmuxSession: vi.fn(async () => undefined),
      createTmuxSession: vi.fn(async () => "tmux-new"),
      createTmuxWindow: vi.fn(async () => undefined),
      navigateTmuxWindow: vi.fn(async () => undefined),
      navigateTmuxSession: vi.fn(async () => undefined),
      toggleDashboard: vi.fn(),
      switchToNativeShell: vi.fn(async () => undefined),
      pasteText: vi.fn(),
      getActiveInstanceId: vi.fn(() => "instance-1"),
      setLastKnownTerminalSize: vi.fn(),
      getLastKnownTerminalSize: vi.fn(() => ({ cols: 120, rows: 40 })),
      isStarted: vi.fn(() => false),
      resizeActiveTerminal: vi.fn(),
      postWebviewMessage: vi.fn(),
      routeDroppedTextToTmuxPane: vi.fn(async () => false),
      formatDroppedFiles: vi.fn(
        (paths: string[], useAtSyntax: boolean) =>
          `${useAtSyntax ? "@" : ""}${paths.join(" ")}`,
      ),
      formatPastedImage: vi.fn((tempPath: string) => `@img:${tempPath}`),
      launchAiTool: vi.fn(async () => undefined),
      showAiToolSelector: vi.fn(async () => undefined),
      splitTmuxPane: vi.fn(async () => "pane-2"),
      zoomTmuxPane: vi.fn(async () => undefined),
      killTmuxPane: vi.fn(async () => undefined),
      getSelectedTmuxSessionId: vi.fn(() => "tmux-selected"),
    };
  }

  function createMockTerminal(name: string, cwd?: string): MockTerminal {
    return {
      name,
      show: vi.fn(),
      sendText: vi.fn(),
      shellIntegration: cwd ? { cwd: { fsPath: cwd } } : undefined,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    OutputChannelService.resetInstance();
    vi.useRealTimers();

    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);
    mockNormalize
      .mockReset()
      .mockImplementation((value: string) => value.replace(/\\/g, "/"));
    mockJoin
      .mockReset()
      .mockImplementation((...parts: string[]) => parts.join("/"));
    mockTmpdir.mockReset().mockReturnValue("/tmp/opencode-tests");
    mockRandomUUID.mockReset().mockReturnValue("uuid-1234");

    Object.defineProperty(vscode, "Range", {
      configurable: true,
      value: class Range {
        public start: { line: number; character: number };
        public end: { line: number; character: number };

        public constructor(
          startLine: number,
          startChar: number,
          endLine: number,
          endChar: number,
        ) {
          this.start = { line: startLine, character: startChar };
          this.end = { line: endLine, character: endChar };
        }
      },
    });

    context =
      new vscode.ExtensionContext() as unknown as vscodeApi.ExtensionContext;
    logger = OutputChannelService.getInstance();
    provider = createProviderBridge();
    terminalManager = {
      writeToTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
    };
    captureManager = {
      startCapture: vi.fn(() => ({
        success: true,
        filePath: "/tmp/capture.log",
      })),
    };

    vscode.window.terminals = [];
    vscode.workspace.workspaceFolders = [
      {
        uri: vscode.Uri.file("/workspace"),
        name: "workspace",
        index: 0,
      },
    ];
    vi.mocked(vscode.window.showTextDocument).mockResolvedValue({} as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);

    router = new MessageRouter(
      provider,
      context,
      terminalManager as TerminalManager,
      captureManager as OutputCaptureManager,
      undefined,
      {} as never,
      logger,
      undefined,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    OutputChannelService.resetInstance();
  });

  it("ignores invalid raw messages and routes terminal lifecycle dispatches", async () => {
    await router.handleMessage(undefined);
    await router.handleMessage("bad-payload");

    await router.handleMessage({ type: "terminalInput", data: "pwd\n" });
    await router.handleMessage({ type: "terminalResize", cols: 100, rows: 30 });
    await router.handleMessage({ type: "ready", cols: 80, rows: 25 });

    expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
      "instance-1",
      "pwd\n",
    );
    expect(provider.setLastKnownTerminalSize).toHaveBeenCalledWith(100, 30);
    expect(terminalManager.resizeTerminal).toHaveBeenCalledWith(
      "instance-1",
      100,
      30,
    );
    expect(provider.startOpenCode).toHaveBeenCalledTimes(1);
    expect(provider.postWebviewMessage).toHaveBeenCalledWith({
      type: "platformInfo",
      platform: process.platform,
    });
  });

  it("routes handleMessage cases for provider bridge actions and clipboard operations", async () => {
    vi.mocked(vscode.env.clipboard.readText).mockResolvedValue(
      "clipboard text",
    );

    await router.handleMessage({ type: "openUrl", url: "https://example.com" });
    await router.handleMessage({ type: "listTerminals" });
    await router.handleMessage({ type: "getClipboard" });
    await router.handleMessage({ type: "setClipboard", text: "copied" });
    await router.handleMessage({ type: "triggerPaste" });
    await router.handleMessage({ type: "switchSession", sessionId: "tmux-a" });
    await router.handleMessage({ type: "killSession", sessionId: "tmux-b" });
    await router.handleMessage({ type: "createTmuxSession" });
    await router.handleMessage({
      type: "navigateTmuxSession",
      direction: "next",
    });
    await router.handleMessage({ type: "switchNativeShell" });
    await router.handleMessage({
      type: "launchAiTool",
      sessionId: "tmux-c",
      tool: "claude",
      savePreference: true,
      targetPaneId: "%1",
    });
    await router.handleMessage({
      type: "sendTmuxPromptChoice",
      choice: "tmux",
    });
    await router.handleMessage({
      type: "sendTmuxPromptChoice",
      choice: "shell",
    });
    await router.handleMessage({ type: "requestAiToolSelector" });
    await router.handleMessage({ type: "toggleDashboard" });
    await router.handleMessage({
      type: "openFile",
      path: "src/providers/MessageRouter.ts",
    });

    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: "https" }),
    );
    expect(provider.postWebviewMessage).toHaveBeenCalledWith({
      type: "clipboardContent",
      text: "clipboard text",
    });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("copied");
    expect(provider.pasteText).toHaveBeenCalledWith("clipboard text");
    expect(provider.switchToTmuxSession).toHaveBeenCalledWith("tmux-a");
    expect(provider.killTmuxSession).toHaveBeenCalledWith("tmux-b");
    expect(provider.createTmuxSession).toHaveBeenCalledTimes(2);
    expect(provider.navigateTmuxSession).toHaveBeenCalledWith("next");
    expect(provider.switchToNativeShell).toHaveBeenCalledTimes(2);
    expect(provider.launchAiTool).toHaveBeenCalledWith(
      "tmux-c",
      "claude",
      true,
      "%1",
    );
    expect(provider.showAiToolSelector).toHaveBeenCalledWith(
      "tmux-selected",
      "tmux-selected",
      true,
    );
    expect(provider.toggleDashboard).toHaveBeenCalledTimes(1);
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("routes terminalAction variants and ignores missing payloads", async () => {
    const externalTerminal = createMockTerminal("External", "/workspace/app");
    vscode.window.terminals = [externalTerminal];

    await router.handleMessage({
      type: "terminalAction",
      action: "focus",
      terminalName: "External",
    });
    await router.handleMessage({
      type: "terminalAction",
      action: "sendCommand",
      terminalName: "External",
      command: "npm test",
    });
    await router.handleMessage({
      type: "terminalAction",
      action: "capture",
      terminalName: "External",
    });
    await router.handleMessage({
      type: "terminalAction",
      action: "sendCommand",
      terminalName: "External",
    });
    await router.handleMessage({
      type: "terminalAction",
      action: "focus",
    });

    expect(externalTerminal.show).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Allow OpenCode to send commands to external terminals?",
      "Yes",
      "Yes, don't ask again",
      "No",
    );
    expect(captureManager.startCapture).toHaveBeenCalledWith(externalTerminal);
  });

  it("routes filesDropped with shift and pane fallback or direct terminal writes", async () => {
    vi.mocked(vscode.workspace.asRelativePath).mockImplementation(
      (value: string) => value,
    );

    provider.routeDroppedTextToTmuxPane = vi
      .fn<MessageRouterProviderBridge["routeDroppedTextToTmuxPane"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    router.handleFilesDropped(
      [
        "file:///workspace/src/index.ts",
        "file:///workspace/src/index.ts",
        "/workspace/notes.md",
      ],
      true,
      { col: 4, row: 2 },
    );
    await Promise.resolve();

    router.handleFilesDropped(["/workspace/README.md"], true);
    router.handleFilesDropped(["/workspace/docs/guide.md"], false);

    expect(provider.formatDroppedFiles).toHaveBeenNthCalledWith(
      1,
      ["/workspace/src/index.ts", "/workspace/notes.md"],
      true,
    );
    expect(provider.routeDroppedTextToTmuxPane).toHaveBeenCalledWith(
      "@/workspace/src/index.ts /workspace/notes.md ",
      { col: 4, row: 2 },
    );
    expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
      "instance-1",
      "@/workspace/src/index.ts /workspace/notes.md ",
    );
    expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
      "instance-1",
      "@/workspace/README.md ",
    );
    expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
      "instance-1",
      "/workspace/docs/guide.md ",
    );
  });

  it("handles image paste success and cleanup scheduling", async () => {
    vi.useFakeTimers();

    await router.handleImagePasted("data:image/png;base64,aGVsbG8=");

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/opencode-tests/opencode-clipboard-uuid-1234.png",
      expect.any(Buffer),
      { flag: "wx", mode: 0o600 },
    );
    expect(provider.formatPastedImage).toHaveBeenCalledWith(
      "/tmp/opencode-tests/opencode-clipboard-uuid-1234.png",
    );
    expect(provider.pasteText).toHaveBeenCalledWith(
      "@img:/tmp/opencode-tests/opencode-clipboard-uuid-1234.png",
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(mockUnlink).toHaveBeenCalledWith(
      "/tmp/opencode-tests/opencode-clipboard-uuid-1234.png",
    );
  });

  it("rejects invalid image payload variants and write failures", async () => {
    mockWriteFile.mockRejectedValueOnce(new Error("disk full"));

    await router.handleImagePasted("not-a-data-url");
    await router.handleImagePasted("data:image/svg+xml;base64,aGVsbG8=");
    await router.handleImagePasted(
      `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64")}`,
    );
    await router.handleImagePasted("data:image/png;base64,aGVsbG8=");

    expect(provider.pasteText).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it("opens files directly, blocks traversal, and falls back to fuzzy matches", async () => {
    const matchedUri = vscode.Uri.file(
      "/workspace/src/providers/MessageRouter.ts",
    );
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([matchedUri]);
    vi.mocked(vscode.window.showTextDocument)
      .mockRejectedValueOnce(new Error("missing file"))
      .mockResolvedValue({} as never);

    await router.handleOpenFile("../secrets.txt");
    await router.handleOpenFile("src/providers/MessageRouter.ts", 5, 8, 3);
    await router.handleOpenFile("missing/file.ts", 2);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Invalid file path: Path traversal detected",
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: "/workspace/src/providers/MessageRouter.ts",
      }),
      {
        selection: {
          start: { line: 4, character: 2 },
          end: { line: 7, character: 9999 },
        },
        preview: true,
      },
    );
    expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
      "**/MessageRouter.ts*",
      null,
      100,
    );
  });

  it("reports open file failures when fuzzy matching cannot recover", async () => {
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
    vi.mocked(vscode.window.showTextDocument).mockRejectedValue(
      new Error("cannot open"),
    );

    await router.handleOpenFile("missing/file.ts");

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to open file: missing/file.ts",
    );
  });

  it("lists terminals, skipping the sidebar terminal and handling missing cwd", async () => {
    const integratedTerminal = createMockTerminal("External A", "/workspace/a");
    const hiddenCwdTerminal = createMockTerminal("External B");
    const sidebarTerminal = createMockTerminal(
      "Open AI Sidebar Terminal",
      "/workspace/sidebar",
    );
    Object.defineProperty(hiddenCwdTerminal, "shellIntegration", {
      get() {
        throw new Error("cwd unavailable");
      },
    });

    vscode.window.terminals = [
      integratedTerminal,
      sidebarTerminal,
      hiddenCwdTerminal,
    ];

    const entries = await router.getTerminalEntries();
    await router.handleListTerminals();

    expect(entries).toEqual([
      { name: "External A", cwd: "/workspace/a" },
      { name: "External B", cwd: "" },
    ]);
    expect(provider.postWebviewMessage).toHaveBeenCalledWith({
      type: "terminalList",
      terminals: entries,
    });
  });

  it("handles sendCommandToTerminal permission flows", async () => {
    const terminal = createMockTerminal("External");

    vi.mocked(context.globalState.get).mockReturnValueOnce(true);
    await router.sendCommandToTerminal(terminal as never, "npm test");

    vi.mocked(context.globalState.get).mockReturnValueOnce(undefined);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      "Yes" as never,
    );
    await router.sendCommandToTerminal(terminal as never, "npm lint");

    vi.mocked(context.globalState.get).mockReturnValueOnce(undefined);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      "Yes, don't ask again" as never,
    );
    await router.sendCommandToTerminal(terminal as never, "npm build");

    vi.mocked(context.globalState.get).mockReturnValueOnce(undefined);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(
      "No" as never,
    );
    await router.sendCommandToTerminal(terminal as never, "npm denied");

    expect(terminal.sendText).toHaveBeenNthCalledWith(1, "npm test");
    expect(terminal.sendText).toHaveBeenNthCalledWith(2, "npm lint");
    expect(terminal.sendText).toHaveBeenNthCalledWith(3, "npm build");
    expect(context.globalState.update).toHaveBeenCalledWith(
      "opencodeTui.allowTerminalCommands",
      true,
    );
    expect(terminal.sendText).toHaveBeenCalledTimes(3);
  });

  it("starts terminal capture with success and failure feedback", () => {
    const terminal = createMockTerminal("CaptureMe");

    router.startTerminalCapture(terminal as never, "CaptureMe");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Started capturing terminal: CaptureMe",
    );

    captureManager.startCapture = vi.fn(() => ({
      success: false,
      error: "script missing",
    }));
    router = new MessageRouter(
      provider,
      context,
      terminalManager as TerminalManager,
      captureManager as OutputCaptureManager,
      undefined,
      {} as never,
      logger,
      undefined,
    );

    router.startTerminalCapture(terminal as never, "CaptureMe");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to start capture: script missing",
    );
  });

  it("creates selections for single-line and multi-line requests", () => {
    expect(router.createSelection()).toBeUndefined();
    expect(router.createSelection(3, undefined, 2)).toEqual({
      start: { line: 2, character: 1 },
      end: { line: 2, character: 1 },
    });
    expect(router.createSelection(3, 6, 2)).toEqual({
      start: { line: 2, character: 1 },
      end: { line: 5, character: 9999 },
    });
  });

  it("fuzzy matches files, prefers exact suffixes, and handles workspace or search failures", async () => {
    const deeper = vscode.Uri.file("/workspace/src/providers/MessageRouter.ts");
    const nearby = vscode.Uri.file("/workspace/MessageRouter.ts.backup");
    vi.mocked(vscode.workspace.findFiles).mockResolvedValue([nearby, deeper]);

    const match = await router.fuzzyMatchFile("src/providers/MessageRouter.ts");
    expect(match).toEqual(deeper);

    vscode.workspace.workspaceFolders = undefined;
    expect(
      await router.fuzzyMatchFile("src/providers/MessageRouter.ts"),
    ).toBeNull();

    vscode.workspace.workspaceFolders = [
      {
        uri: vscode.Uri.file("/workspace"),
        name: "workspace",
        index: 0,
      },
    ];
    vi.mocked(vscode.workspace.findFiles).mockRejectedValueOnce(
      new Error("search failed"),
    );

    expect(
      await router.fuzzyMatchFile("src/providers/MessageRouter.ts"),
    ).toBeNull();
  });

  it("handles ready for started sessions and invalid resize or paste errors", async () => {
    provider.isStarted = vi.fn(() => true);
    provider.getLastKnownTerminalSize = vi.fn(() => ({ cols: 132, rows: 44 }));
    vi.mocked(vscode.env.clipboard.readText).mockRejectedValueOnce(
      new Error("clipboard down"),
    );
    vi.mocked(vscode.env.clipboard.writeText).mockRejectedValueOnce(
      new Error("write denied"),
    );

    router.handleTerminalInput(undefined);
    router.handleTerminalResize(undefined, 24);
    router.handleReady(undefined, undefined);
    await router.handlePaste();
    await router.handleSetClipboard("x");
    await router.handleGetClipboard();

    expect(provider.resizeActiveTerminal).toHaveBeenCalledWith(132, 44);
    expect(terminalManager.writeToTerminal).not.toHaveBeenCalled();
    expect(terminalManager.resizeTerminal).not.toHaveBeenCalled();
    expect(provider.postWebviewMessage).toHaveBeenCalledWith({
      type: "platformInfo",
      platform: process.platform,
    });
  });

  it("logs bridge errors for tmux actions and ignores invalid directions", async () => {
    provider.createTmuxWindow = vi.fn(async () => {
      throw new Error("window boom");
    });
    provider.navigateTmuxWindow = vi.fn(async () => {
      throw new Error("nav boom");
    });
    provider.splitTmuxPane = vi.fn(async () => {
      throw new Error("split boom");
    });
    provider.zoomTmuxPane = vi.fn(async () => {
      throw new Error("zoom boom");
    });
    provider.killTmuxPane = vi.fn(async () => {
      throw new Error("kill boom");
    });

    const errorSpy = vi.spyOn(logger, "error");

    await router.handleMessage({ type: "createTmuxWindow" });
    await router.handleMessage({
      type: "navigateTmuxWindow",
      direction: "next",
    });
    await router.handleMessage({
      type: "navigateTmuxWindow",
      direction: "bad",
    });
    await router.handleMessage({ type: "splitTmuxPane", direction: "h" });
    await router.handleMessage({ type: "splitTmuxPane", direction: "x" });
    await router.handleMessage({ type: "zoomTmuxPane" });
    await router.handleMessage({ type: "killTmuxPane" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("createTmuxWindow failed: window boom"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("navigateTmuxWindow failed: nav boom"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("splitTmuxPane failed: split boom"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("zoomTmuxPane failed: zoom boom"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("killTmuxPane failed: kill boom"),
    );
  });

  it("warns when terminal actions target unknown terminals", async () => {
    const warnSpy = vi.spyOn(logger, "warn");

    await router.handleTerminalAction("focus", "Missing");

    expect(warnSpy).toHaveBeenCalledWith("Terminal not found: Missing");
  });
});
