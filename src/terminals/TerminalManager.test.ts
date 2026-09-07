import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ptyMock from "../test/mocks/node-pty";
import * as vscode from "../test/mocks/vscode";
import type { TerminalTransport } from "./TerminalTransport";

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

  describe("transport seam", () => {
    class FakeTerminalTransport implements TerminalTransport {
      public readonly kind = "herdr-control" as const;
      private readonly outputEmitter = new vscode.EventEmitter<{
        data: string;
        replay: "append" | "replace";
      }>();
      private readonly exitEmitter = new vscode.EventEmitter<{
        reason: "released" | "protocol-error";
        message?: string;
      }>();

      public readonly onOutput = this.outputEmitter.event;
      public readonly onExit = this.exitEmitter.event;
      public readonly write = vi.fn<(data: string) => void>();
      public readonly scroll = vi.fn();
      public readonly resize = vi.fn<(cols: number, rows: number) => void>();
      public readonly close = vi.fn(async (_reason: "release" | "shutdown") => undefined);

      public emitOutput(data: string, replay: "append" | "replace"): void {
        this.outputEmitter.fire({ data, replay });
      }

      public emitExit(reason: "released" | "protocol-error", message?: string): void {
        this.exitEmitter.fire({ reason, message });
      }
    }

    it("switches one slot to an attached transport and restores shell replay", () => {
      const manager = new TerminalManager();
      const data = vi.fn();
      manager.onData(data);
      const shell = manager.createTerminal(
        "shell",
        80,
        24,
      ) as unknown as ptyMock.MockPtyProcess;
      shell.emitData("shell-A");
      const attached = new FakeTerminalTransport();

      manager.attach("shell", () => attached);
      manager.write("shell", "attached-input");
      manager.resize("shell", 120, 40);
      shell.emitData("shell-B");

      expect(manager.activeSource("shell")).toBe("herdr-control");
      expect(attached.write).toHaveBeenCalledWith("attached-input");
      expect(attached.resize).toHaveBeenCalledWith(120, 40);
      expect(shell.write).not.toHaveBeenCalled();
      expect(shell.resize).not.toHaveBeenCalled();
      expect(shell.kill).not.toHaveBeenCalled();
      expect(data).toHaveBeenCalledTimes(1);
      expect(data.mock.calls[0][0].replay).toBe("append");

      manager.detach("shell");
      manager.write("shell", "shell-input");
      manager.resize("shell", 100, 30);

      expect(manager.activeSource("shell")).toBe("local-shell");
      expect(manager.replay("shell")).toBe("shell-Ashell-B");
      expect(shell.write).toHaveBeenCalledWith("shell-input");
      expect(shell.resize).toHaveBeenCalledWith(100, 30);
      expect(shell.kill).not.toHaveBeenCalled();
      expect(attached.close).toHaveBeenCalledWith("release");
    });

    it("retains the latest full frame and following deltas for attached replay", () => {
      const manager = new TerminalManager();
      const data = vi.fn();
      manager.onData(data);
      manager.createTerminal("shell", 80, 24);
      const attached = new FakeTerminalTransport();
      manager.attach("shell", () => attached);

      attached.emitOutput("A", "replace");
      attached.emitOutput("B", "append");
      attached.emitOutput("C", "append");

      expect(manager.replay("shell")).toBe("ABC");
      expect(data.mock.calls.map(([event]) => [event.data, event.replay])).toEqual([
        ["A", "replace"],
        ["B", "append"],
        ["C", "append"],
      ]);

      attached.emitOutput("D", "replace");

      expect(manager.replay("shell")).toBe("D");
      expect(data.mock.calls[3][0].replay).toBe("replace");
    });

    it("ignores stale attached output and enforces replay bounds", () => {
      const manager = new TerminalManager();
      const data = vi.fn();
      const exit = vi.fn();
      manager.onData(data);
      manager.onExit(exit);
      const shell = manager.createTerminal(
        "shell",
        80,
        24,
      ) as unknown as ptyMock.MockPtyProcess;
      shell.emitData("shell-replay");
      const attached = new FakeTerminalTransport();
      manager.attach("shell", () => attached);

      attached.emitOutput("x".repeat(8 * 1024 * 1024 + 1), "replace");

      expect(exit).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "shell",
          reason: "protocol-error",
          message: expect.stringContaining("8 MiB"),
        }),
      );
      expect(manager.activeSource("shell")).toBe("local-shell");
      expect(manager.replay("shell")).toBe("shell-replay");
      expect(shell.kill).not.toHaveBeenCalled();
      expect(attached.close).toHaveBeenCalledWith("release");

      data.mockClear();
      exit.mockClear();
      attached.emitOutput("stale", "append");
      attached.emitExit("protocol-error", "stale exit");

      expect(data).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });

    it("suppresses stale attached output after detach", () => {
      const manager = new TerminalManager();
      const data = vi.fn();
      const exit = vi.fn();
      manager.onData(data);
      manager.onExit(exit);
      manager.createTerminal("shell", 80, 24);
      const attached = new FakeTerminalTransport();
      manager.attach("shell", () => attached);

      manager.detach("shell");
      attached.emitOutput("stale", "append");
      attached.emitExit("protocol-error", "stale exit");

      expect(data).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(manager.replay("shell")).toBe("");
      expect(manager.activeSource("shell")).toBe("local-shell");
    });

    it("keeps createTerminal as an idempotent single-spawn adapter", () => {
      const manager = new TerminalManager();

      const first = manager.createTerminal("shell", 120, 40);
      const second = manager.createTerminal("shell", 80, 24);

      expect(first).toBe(second);
      expect(nodePty.spawn).toHaveBeenCalledOnce();
    });
  });

  it("counts attached-only Herdr sessions as running terminals", () => {
    const manager = new TerminalManager();
    const transport: TerminalTransport = {
      kind: "herdr-control",
      write: vi.fn(),
      scroll: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(async () => undefined),
      onOutput: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
    };

    manager.attach("herdr:term-a", () => transport, "frame");
    manager.attach("herdr:term-b", () => transport, "frame");

    expect(manager.terminalCount()).toBe(2);
    expect(manager.hasTerminal("herdr:term-a")).toBe(true);
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
