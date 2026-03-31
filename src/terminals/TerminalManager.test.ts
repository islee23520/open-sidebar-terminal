import { describe, it, expect, beforeEach, vi } from "vitest";
import { TerminalManager } from "./TerminalManager";
import type * as nodePtyTypes from "../test/mocks/node-pty";
import type * as vscodeTypes from "../test/mocks/vscode";

const nodePty = await vi.importActual<typeof nodePtyTypes>(
  "../test/mocks/node-pty",
);
const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

vi.mock("node-pty", async () => {
  const actual = await vi.importActual("../test/mocks/node-pty");
  return actual;
});

describe("TerminalManager", () => {
  let manager: TerminalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new TerminalManager();
  });

  describe("createTerminal", () => {
    it("should create a terminal with given id", () => {
      const terminal = manager.createTerminal("test-id");

      expect(terminal).toBeDefined();
      expect(terminal.id).toBe("test-id");
    });

    it("should kill existing terminal with same id", () => {
      const killSpy = vi.spyOn(manager, "killTerminal");

      manager.createTerminal("test-id");
      manager.createTerminal("test-id");

      expect(killSpy).toHaveBeenCalledWith("test-id");
    });

    it("should create terminal with command", () => {
      manager.createTerminal("test-id", "opencode -c");

      expect(manager.getTerminal("test-id")).toBeDefined();
    });

    it("should emit data events", () => {
      const dataHandler = vi.fn();
      manager.onData(dataHandler);

      manager.createTerminal("test-id");

      expect(dataHandler).not.toHaveBeenCalled();
    });

    it("should emit exit events", () => {
      const exitHandler = vi.fn();
      manager.onExit(exitHandler);

      manager.createTerminal("test-id");

      expect(exitHandler).not.toHaveBeenCalled();
    });

    it("should pass custom environment variables to process", () => {
      const customEnv = {
        _EXTENSION_OPENCODE_PORT: "8080",
        OPENCODE_CALLER: "vscode",
      };

      manager.createTerminal("test-id", undefined, customEnv);

      expect(nodePty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            _EXTENSION_OPENCODE_PORT: "8080",
            OPENCODE_CALLER: "vscode",
            TERM: "xterm-256color",
          }),
        }),
      );
    });

    it("should preserve existing env vars when adding custom ones", () => {
      const customEnv = {
        _EXTENSION_OPENCODE_PORT: "9090",
      };

      manager.createTerminal("test-id", undefined, customEnv);

      const spawnCall = vi.mocked(nodePty.spawn).mock.calls[0];
      const envArg = spawnCall[2].env;

      expect(envArg).toHaveProperty("TERM", "xterm-256color");
      expect(envArg).toHaveProperty("_EXTENSION_OPENCODE_PORT", "9090");
    });

    it("should track port in terminal interface", () => {
      const customEnv = {
        _EXTENSION_OPENCODE_PORT: "7070",
      };

      const terminal = manager.createTerminal(
        "test-id",
        undefined,
        customEnv,
        7070,
      );

      expect(terminal.port).toBe(7070);
    });

    it("should work without custom env (backward compatibility)", () => {
      const terminal = manager.createTerminal("test-id", "opencode -c");

      expect(terminal).toBeDefined();
      expect(terminal.id).toBe("test-id");
      expect(terminal.port).toBeUndefined();

      expect(nodePty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            TERM: "xterm-256color",
          }),
        }),
      );
    });

    it("should allow custom env to override TERM", () => {
      const customEnv = {
        TERM: "vt100",
        _EXTENSION_OPENCODE_PORT: "3000",
      };

      manager.createTerminal("test-id", undefined, customEnv);

      const spawnCall = vi.mocked(nodePty.spawn).mock.calls[0];
      const envArg = spawnCall[2].env;

      expect(envArg).toHaveProperty("TERM", "vt100");
    });
  });

  describe("getTerminal", () => {
    it("should return undefined for non-existent terminal", () => {
      const terminal = manager.getTerminal("non-existent");

      expect(terminal).toBeUndefined();
    });

    it("should return terminal for existing id", () => {
      manager.createTerminal("test-id");

      const terminal = manager.getTerminal("test-id");

      expect(terminal).toBeDefined();
      expect(terminal?.id).toBe("test-id");
    });
  });

  describe("writeToTerminal", () => {
    it("should write data to existing terminal", () => {
      const terminal = manager.createTerminal("test-id");
      const writeSpy = vi.spyOn(terminal.process, "write");

      manager.writeToTerminal("test-id", "test data");

      expect(writeSpy).toHaveBeenCalledWith("test data");
    });

    it("should not throw for non-existent terminal", () => {
      expect(() => {
        manager.writeToTerminal("non-existent", "test");
      }).not.toThrow();
    });
  });

  describe("resizeTerminal", () => {
    it("should resize existing terminal", () => {
      const terminal = manager.createTerminal("test-id");
      const resizeSpy = vi.spyOn(terminal.process, "resize");

      manager.resizeTerminal("test-id", 100, 50);

      expect(resizeSpy).toHaveBeenCalledWith(100, 50);
    });

    it("should not throw for non-existent terminal", () => {
      expect(() => {
        manager.resizeTerminal("non-existent", 80, 24);
      }).not.toThrow();
    });
  });

  describe("killTerminal", () => {
    it("should kill and remove terminal", () => {
      const terminal = manager.createTerminal("test-id");
      const killSpy = vi.spyOn(terminal.process, "kill");

      manager.killTerminal("test-id");

      expect(killSpy).toHaveBeenCalled();
      expect(manager.getTerminal("test-id")).toBeUndefined();
    });

    it("should dispose event emitters", () => {
      const terminal = manager.createTerminal("test-id");
      const disposeDataSpy = vi.spyOn(terminal.onData, "dispose");
      const disposeExitSpy = vi.spyOn(terminal.onExit, "dispose");

      manager.killTerminal("test-id");

      expect(disposeDataSpy).toHaveBeenCalled();
      expect(disposeExitSpy).toHaveBeenCalled();
    });

    it("should not throw for non-existent terminal", () => {
      expect(() => {
        manager.killTerminal("non-existent");
      }).not.toThrow();
    });

    it("should ignore stale onExit from killed process when terminal is recreated with same id", () => {
      const exitHandler = vi.fn();
      manager.onExit(exitHandler);

      const oldTerminal = manager.createTerminal("test-id");
      const oldProcess = oldTerminal.process;

      manager.killTerminal("test-id");

      const newTerminal = manager.createTerminal("test-id");
      expect(manager.getTerminal("test-id")).toBe(newTerminal);

      (oldProcess as unknown as nodePtyTypes.MockPtyProcess)._simulateExit(0);

      expect(exitHandler).not.toHaveBeenCalled();
      expect(manager.getTerminal("test-id")).toBe(newTerminal);
    });
  });

  describe("dispose", () => {
    it("should kill all terminals", () => {
      const killSpy = vi.spyOn(manager, "killTerminal");

      manager.createTerminal("id1");
      manager.createTerminal("id2");
      manager.dispose();

      expect(killSpy).toHaveBeenCalledWith("id1");
      expect(killSpy).toHaveBeenCalledWith("id2");
    });
  });

  describe("shell configuration", () => {
    it("should use VS Code default shell when no override", () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "shellPath") return "";
          if (key === "shellArgs") return [];
          return undefined;
        }),
        update: vi.fn(),
      } as any);

      manager.createTerminal("test-id");

      expect(manager.getTerminal("test-id")).toBeDefined();
    });

    it("should use custom shell path when configured", () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "shellPath") return "/custom/shell";
          if (key === "shellArgs") return [];
          return undefined;
        }),
        update: vi.fn(),
      } as any);

      manager.createTerminal("test-id");

      expect(manager.getTerminal("test-id")).toBeDefined();
    });

    it("should use custom shell args when configured", () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string) => {
          if (key === "shellPath") return "";
          if (key === "shellArgs") return ["-l", "-i"];
          return undefined;
        }),
        update: vi.fn(),
      } as any);

      manager.createTerminal("test-id");

      expect(manager.getTerminal("test-id")).toBeDefined();
    });
  });
});
