import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { InstanceDiscoveryService } from "./InstanceDiscoveryService";
import { OpenCodeApiClient } from "./OpenCodeApiClient";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

describe("InstanceDiscoveryService", () => {
  let service: InstanceDiscoveryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new InstanceDiscoveryService();
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockExecOutput(stdout: string): void {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1] as ExecFileCallback;
      callback?.(null, stdout, "");
      return {} as any;
    });
  }

  it("Test 1: Scanning returns potential OpenCode processes", async () => {
    const windowsProcessList = JSON.stringify([
      {
        ProcessId: 101,
        Name: "opencode.exe",
        CommandLine: "opencode -c --port 17001",
      },
      {
        ProcessId: 202,
        Name: "node.exe",
        CommandLine: "node server.js",
      },
    ]);

    mockExecOutput(windowsProcessList);
    vi.spyOn(service as any, "getPlatform").mockReturnValue("win32");

    const instances = await (service as any).scanProcesses();

    expect(instances).toEqual([
      {
        pid: 101,
        port: 17001,
      },
    ]);
  });

  it("Test 2: Health check filters non-OpenCode processes", async () => {
    vi.spyOn(service as any, "scanProcesses").mockResolvedValue([
      { pid: 111, port: 18001 },
      { pid: 222, port: 18002 },
    ]);
    vi.spyOn(service as any, "healthCheck")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.spyOn(service as any, "getWorkspacePath").mockResolvedValue(undefined);

    const instances = await service.discoverInstances();

    expect(instances).toEqual([
      { pid: 111, port: 18001, workspacePath: undefined },
    ]);
  });

  it("Test 3: Workspace matching validates correct instance", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace/current" } },
    ];

    vi.spyOn(service as any, "scanProcesses").mockResolvedValue([
      { pid: 1, port: 19001 },
      { pid: 2, port: 19002 },
    ]);
    vi.spyOn(service as any, "healthCheck").mockResolvedValue(true);
    vi.spyOn(service as any, "getWorkspacePath")
      .mockResolvedValueOnce("/workspace/current")
      .mockResolvedValueOnce("/workspace/other");

    const instances = await service.discoverInstances();

    expect(instances).toEqual([
      {
        pid: 1,
        port: 19001,
        workspacePath: "/workspace/current",
      },
    ]);
  });

  it("Test 4: Auto-spawn creates new instance when enabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "enableAutoSpawn") {
          return true;
        }
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);

    vi.spyOn(service as any, "scanProcesses").mockResolvedValue([]);
    vi.spyOn(service as any, "spawnOpenCode").mockResolvedValue({
      pid: 300,
      port: 20001,
      workspacePath: "/workspace/new",
    });

    const instances = await service.discoverInstances();

    expect(instances).toEqual([
      {
        pid: 300,
        port: 20001,
        workspacePath: "/workspace/new",
      },
    ]);
  });

  it("Test 5: Platform detection works correctly", async () => {
    mockExecOutput("[]");

    vi.spyOn(service as any, "getPlatform").mockReturnValue("win32");
    await (service as any).scanProcesses();

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "powershell.exe",
      expect.any(Array),
      expect.any(Function),
    );

    vi.mocked(execFile).mockClear();

    vi.spyOn(service as any, "getPlatform").mockReturnValue("linux");
    await (service as any).scanProcesses();

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "ps",
      expect.any(Array),
      expect.any(Function),
    );
  });

  it("Test 6: Proper disposal of resources", async () => {
    vi.spyOn(service as any, "scanProcesses").mockResolvedValue([
      { pid: 11, port: 21001 },
    ]);
    vi.spyOn(service as any, "healthCheck").mockResolvedValue(true);
    vi.spyOn(service as any, "getWorkspacePath").mockResolvedValue(
      "/workspace/a",
    );

    await service.discoverInstances();
    service.dispose();

    const scanSpy = vi.spyOn(service as any, "scanProcesses");
    scanSpy.mockClear();
    const instances = await service.discoverInstances();

    expect(instances).toEqual([]);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it("uses Unix process scanning and port extraction patterns", async () => {
    mockExecOutput(
      [
        "777 opencode -c --http-port 22001",
        "888 opencode --port 22002",
        "999 opencode _EXTENSION_OPENCODE_PORT=22003",
      ].join("\n"),
    );

    vi.spyOn(service as any, "getPlatform").mockReturnValue("linux");

    const instances = await (service as any).scanProcesses();

    expect(instances).toEqual([
      { pid: 777, port: 22001 },
      { pid: 888, port: 22002 },
      { pid: 999, port: 22003 },
    ]);
  });

  it("returns false when OpenCode health check fails", async () => {
    vi.spyOn(OpenCodeApiClient.prototype, "healthCheck").mockResolvedValue(
      false,
    );

    const isHealthy = await (service as any).healthCheck(23001);

    expect(isHealthy).toBe(false);
  });

  it("reads workspace path from health payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ workspacePath: "/workspace/api" }),
    } as any);

    const workspacePath = await (service as any).getWorkspacePath(24001);

    expect(workspacePath).toBe("/workspace/api");
  });

  it("handles workspace path fetch errors safely", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("connection failed"));

    const workspacePath = await (service as any).getWorkspacePath(24002);

    expect(workspacePath).toBeUndefined();
  });

  it("does not auto-spawn when feature is disabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "enableAutoSpawn") {
          return false;
        }
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);

    service = new InstanceDiscoveryService();

    vi.spyOn(service as any, "scanProcesses").mockResolvedValue([]);
    const spawnSpy = vi
      .spyOn(service as any, "spawnOpenCode")
      .mockResolvedValue(undefined);

    const instances = await service.discoverInstances();

    expect(instances).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("returns spawned instance with pid and ephemeral port", async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        callback(null, "", "");
      }

      const child = {
        pid: 4321,
        on: vi.fn((event: string, handler: (code?: number) => void) => {
          if (event === "exit") {
            queueMicrotask(() => handler(0));
          }
          return child;
        }),
      };

      return child as any;
    });
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace/spawn" } },
    ];
    vi.spyOn(service as any, "waitForSpawnReadiness").mockResolvedValue(true);
    vi.spyOn(service as any, "getWorkspacePath").mockResolvedValue(
      "/workspace/spawn",
    );

    const spawned = await (service as any).spawnOpenCode();

    expect(spawned.pid).toBe(4321);
    expect(spawned.workspacePath).toBe("/workspace/spawn");
    expect(spawned.port).toBeGreaterThanOrEqual(16384);
    expect(spawned.port).toBeLessThanOrEqual(65535);
  });

  it("parses quoted command and args for auto-spawn", () => {
    const parsed = (service as any).parseCommand(
      '"/path with spaces/opencode" -c --profile "dev mode"',
    );

    expect(parsed).toEqual({
      file: "/path with spaces/opencode",
      args: ["-c", "--profile", "dev mode"],
    });
  });

  it("returns undefined for malformed quoted command", () => {
    const parsed = (service as any).parseCommand(
      '"/path with spaces/opencode -c',
    );

    expect(parsed).toBeUndefined();
  });

  it("preserves backslashes in quoted Windows executable path", () => {
    const parsed = (service as any).parseCommand(
      '"C:\\Program Files\\OpenCode\\opencode.exe" -c --mode test',
    );

    expect(parsed).toEqual({
      file: "C:\\Program Files\\OpenCode\\opencode.exe",
      args: ["-c", "--mode", "test"],
    });
  });
});
