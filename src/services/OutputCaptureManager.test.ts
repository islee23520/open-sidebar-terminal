import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OutputCaptureManager } from "./OutputCaptureManager";
import { OutputChannelService } from "./OutputChannelService";

vi.mock("vscode");
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock("os", () => ({
  platform: vi.fn(),
  tmpdir: vi.fn(),
}));
vi.mock("path", () => ({
  join: vi.fn(),
}));

describe("OutputCaptureManager", () => {
  let manager: OutputCaptureManager;
  let originalPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    OutputChannelService.resetInstance();
    originalPath = process.env.PATH;

    manager = new OutputCaptureManager();

    vi.mocked(os.platform).mockReturnValue("darwin");
    vi.mocked(os.tmpdir).mockReturnValue("/tmp/opencode");
    vi.mocked(path.join).mockImplementation((...parts: string[]) =>
      parts.join("/"),
    );
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  function createTerminal(): vscode.Terminal {
    return {
      sendText: vi.fn(),
    } as unknown as vscode.Terminal;
  }

  it("returns an unsupported error on Windows", () => {
    vi.mocked(os.platform).mockReturnValue("win32");

    const terminal = createTerminal();
    const result = manager.startCapture(terminal);

    expect(result).toEqual({
      success: false,
      error: "Output capture is not supported on Windows.",
    });
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("returns an installation error when script is unavailable", () => {
    process.env.PATH = "";

    const terminal = createTerminal();
    const result = manager.startCapture(terminal);

    process.env.PATH = originalPath;

    expect(result).toEqual({
      success: false,
      error:
        "The 'script' command is not available. Please install util-linux or bsdutils package.",
    });
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("starts capture and stores the generated temp file path", () => {
    vi.spyOn(Date, "now").mockReturnValue(1712345678901);

    const terminal = createTerminal();
    const result = manager.startCapture(terminal);

    const expectedFilePath =
      "/tmp/opencode/opencode-capture-" + process.pid + "-1712345678901.log";

    expect(path.join).toHaveBeenCalledWith(
      "/tmp/opencode",
      `opencode-capture-${process.pid}-1712345678901.log`,
    );
    expect(terminal.sendText).toHaveBeenCalledWith(
      `script -q "${expectedFilePath}"`,
    );
    expect(result).toEqual({ success: true, filePath: expectedFilePath });
  });

  it("returns a start error when sending the capture command fails", () => {
    const terminal = createTerminal();
    vi.mocked(terminal.sendText).mockImplementation(() => {
      throw new Error("terminal disconnected");
    });

    const result = manager.startCapture(terminal);

    expect(result).toEqual({
      success: false,
      error: "Failed to start capture: terminal disconnected",
    });
  });

  it("stops an active capture by exiting the nested script shell", () => {
    const terminal = createTerminal();

    manager.startCapture(terminal);
    manager.stopCapture(terminal);

    expect(terminal.sendText).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^script -q "/),
    );
    expect(terminal.sendText).toHaveBeenNthCalledWith(2, "exit");
  });

  it("ignores stop requests for terminals without an active capture", () => {
    const terminal = createTerminal();

    manager.stopCapture(terminal);

    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it("returns an empty string when no capture path exists", () => {
    const terminal = createTerminal();

    expect(manager.readCapture(terminal)).toBe("");
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it("returns an empty string when the capture file is missing", () => {
    const terminal = createTerminal();

    manager.startCapture(terminal);

    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(manager.readCapture(terminal)).toBe("");
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("reads capture contents and strips ANSI escape codes", () => {
    const terminal = createTerminal();

    manager.startCapture(terminal);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      "plain text\n\u001b[31mred line\u001b[0m\n\u001b[2Kdone",
    );

    expect(manager.readCapture(terminal)).toBe("plain text\nred line\ndone");
    expect(fs.readFileSync).toHaveBeenCalledWith(expect.any(String), "utf-8");
  });

  it("logs and returns an empty string when reading a capture file fails", () => {
    const logger = { error: vi.fn() } as Pick<
      OutputChannelService,
      "error"
    > as OutputChannelService;
    vi.spyOn(OutputChannelService, "getInstance").mockReturnValue(logger);

    const terminal = createTerminal();
    manager.startCapture(terminal);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("read failed");
    });

    expect(manager.readCapture(terminal)).toBe("");
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to read capture file: read failed",
    );
  });

  it("deletes the temp file during cleanup and removes the capture mapping", () => {
    const terminal = createTerminal();
    vi.spyOn(Date, "now").mockReturnValue(1712345678902);

    manager.startCapture(terminal);

    const expectedFilePath =
      "/tmp/opencode/opencode-capture-" + process.pid + "-1712345678902.log";

    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => {
      return String(filePath) === expectedFilePath;
    });

    manager.cleanup(terminal);

    expect(fs.unlinkSync).toHaveBeenCalledWith(expectedFilePath);
    expect(manager.readCapture(terminal)).toBe("");
  });

  it("logs cleanup failures and still clears the capture mapping", () => {
    const logger = { error: vi.fn() } as Pick<
      OutputChannelService,
      "error"
    > as OutputChannelService;
    vi.spyOn(OutputChannelService, "getInstance").mockReturnValue(logger);

    const terminal = createTerminal();
    manager.startCapture(terminal);

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error("permission denied");
    });

    manager.cleanup(terminal);

    expect(logger.error).toHaveBeenCalledWith(
      "Failed to delete capture file: permission denied",
    );
    expect(manager.readCapture(terminal)).toBe("");
  });

  it("cleans up capture state even when the temp file no longer exists", () => {
    const terminal = createTerminal();

    manager.startCapture(terminal);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    manager.cleanup(terminal);

    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(manager.readCapture(terminal)).toBe("");
    manager.stopCapture(terminal);
    expect(terminal.sendText).toHaveBeenCalledTimes(1);
  });
});
