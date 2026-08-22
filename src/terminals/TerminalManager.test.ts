import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ptyMock from "../test/mocks/node-pty";
import * as vscode from "../test/mocks/vscode";

vi.mock("node-pty", async () =>
  vi.importActual<typeof ptyMock>("../test/mocks/node-pty"),
);

const nodePty = await vi.importActual<typeof ptyMock>(
  "../test/mocks/node-pty",
);
const { TerminalManager } = await import("./TerminalManager");

describe("TerminalManager", () => {
  beforeEach(() => {
    vscode.resetMocks();
    nodePty.spawn.mockClear();
  });

  it("spawns one configured interactive shell in the workspace", () => {
    vscode.setConfiguration({
      "ulw.shellPath": "/bin/zsh",
      "ulw.shellArgs": ["-l"],
    });
    const manager = new TerminalManager();

    const first = manager.createTerminal("shell", 120, 40);
    const second = manager.createTerminal("shell", 80, 24);

    expect(first).toBe(second);
    expect(nodePty.spawn).toHaveBeenCalledOnce();
    expect(nodePty.spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: expect.objectContaining({
          TERM: "xterm-256color",
          LANG: expect.stringMatching(/UTF-8/i),
          LC_CTYPE: expect.stringMatching(/UTF-8/i),
        }),
      }),
    );
  });

  it("forwards input output resize and exit", () => {
    const manager = new TerminalManager();
    const data = vi.fn();
    const exit = vi.fn();
    manager.onData(data);
    manager.onExit(exit);
    const process = manager.createTerminal(
      "shell",
      80,
      24,
    ) as unknown as ptyMock.MockPtyProcess;

    manager.write("shell", "echo hi\r");
    manager.resize("shell", 100, 30);
    process.emitData("hi\r\n");
    process.emitExit(7, 15);

    expect(process.write).toHaveBeenCalledWith("echo hi\r");
    expect(process.resize).toHaveBeenCalledWith(100, 30);
    expect(data).toHaveBeenCalledWith({ id: "shell", data: "hi\r\n" });
    expect(exit).toHaveBeenCalledWith({ id: "shell", code: 7, signal: 15 });
    expect(manager.hasTerminal("shell")).toBe(false);
  });

  it("kills the shell during disposal", () => {
    const manager = new TerminalManager();
    const process = manager.createTerminal(
      "shell",
      80,
      24,
    ) as unknown as ptyMock.MockPtyProcess;

    manager.dispose();

    expect(process.kill).toHaveBeenCalledOnce();
    expect(manager.terminalCount()).toBe(0);
  });

  it("ignores invalid resize and missing terminal operations", () => {
    const manager = new TerminalManager();
    const process = manager.createTerminal(
      "shell",
      0,
      -1,
    ) as unknown as ptyMock.MockPtyProcess;

    manager.resize("shell", 0, 24);
    manager.resize("missing", 80, 24);
    manager.write("missing", "ignored");
    manager.kill("missing");

    expect(nodePty.spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
    expect(process.resize).not.toHaveBeenCalled();
  });

  it("falls back to the system shell and home directory", () => {
    const folders = vscode.workspace.workspaceFolders;
    const shell = vscode.env.shell;
    vscode.workspace.workspaceFolders = [];
    vscode.env.shell = "";
    const previousShell = process.env.SHELL;
    process.env.SHELL = "/bin/system-shell";
    const manager = new TerminalManager();

    manager.createTerminal("shell", 80, 24);

    expect(nodePty.spawn).toHaveBeenCalledWith(
      "/bin/system-shell",
      [],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    vscode.workspace.workspaceFolders = folders;
    vscode.env.shell = shell;
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
  });

  it("drops stale PTY callbacks after a terminal is killed", () => {
    const manager = new TerminalManager();
    const data = vi.fn();
    const exit = vi.fn();
    manager.onData(data);
    manager.onExit(exit);
    const process = manager.createTerminal(
      "shell",
      80,
      24,
    ) as unknown as ptyMock.MockPtyProcess;

    manager.kill("shell");
    process.emitData("stale");
    process.emitExit(0);

    expect(data).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  describe("characterization: current one-PTY lifecycle", () => {
    it("returns the same pty instance for an existing terminal id", () => {
      const manager = new TerminalManager();

      const first = manager.createTerminal("shell", 120, 40);
      const second = manager.createTerminal("shell", 80, 24);

      expect(first).toBe(second);
      expect(nodePty.spawn).toHaveBeenCalledOnce();
    });

    it("drops stale onData and onExit after kill", () => {
      const manager = new TerminalManager();
      const data = vi.fn();
      const exit = vi.fn();
      manager.onData(data);
      manager.onExit(exit);
      const process = manager.createTerminal(
        "shell",
        80,
        24,
      ) as unknown as ptyMock.MockPtyProcess;

      manager.kill("shell");
      process.emitData("stale");
      process.emitExit(0, 9);

      expect(data).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(manager.hasTerminal("shell")).toBe(false);
    });
  });
});
