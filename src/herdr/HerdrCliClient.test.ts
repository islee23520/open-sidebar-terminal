import { afterEach, describe, expect, test, vi } from "vitest";
import {
  HerdrNotInstalledError,
  HerdrProtocolError,
  HerdrServerDownError,
  HerdrUnsupportedVersionError,
} from "./errors";
import { HerdrCliClient } from "./HerdrCliClient";
import { HerdrInvocationResolver } from "./HerdrInvocationResolver";
import type { HerdrCommandRunner, HerdrInvocation } from "./types";

const invocation: HerdrInvocation = HerdrInvocationResolver.resolve({
  executablePath: "/opt/herdr",
  session: "team",
  socketPath: undefined,
  env: { PATH: "/bin" },
  platform: "darwin",
});

function result(stdout: string, stderr = "", code = 0) {
  return Promise.resolve({ stdout, stderr, code });
}

describe("HerdrCliClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("maps supported-version agent list through shared resolver", async () => {
    const run = vi
      .fn<HerdrCommandRunner>()
      .mockImplementationOnce(() => result("herdr 0.8.2\n"))
      .mockImplementationOnce(() =>
        result(
          JSON.stringify({
            id: 7,
            result: {
              agents: [
                {
                  agent: "claude",
                  agent_status: "working",
                  cwd: "/Users/example/repo",
                  pane_id: "w46:p1",
                  terminal_id: "terminal-123",
                  terminal_title_stripped: "Claude Code",
                  workspace_id: "workspace-456",
                  ignored_live_field: true,
                },
              ],
            },
          }),
        ),
      );
    const client = new HerdrCliClient({ run, invocation });

    await expect(client.versionCheck()).resolves.toEqual({ version: "0.8.2" });
    await expect(client.listAgents()).resolves.toEqual([
      {
        paneId: "w46:p1",
        terminalId: "terminal-123",
        agent: "claude",
        status: "working",
        title: "Claude Code",
        cwd: "/Users/example/repo",
        workspaceId: "workspace-456",
      },
    ]);
    expect(run).toHaveBeenNthCalledWith(
      1,
      "/opt/herdr",
      ["--session", "team", "--version"],
      { PATH: "/bin" },
      5_000,
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/opt/herdr",
      ["--session", "team", "agent", "list"],
      { PATH: "/bin" },
      5_000,
    );
  });

  test("maps executable version timeout protocol and capacity failures", async () => {
    const missing = new HerdrCliClient({
      invocation,
      run: vi.fn<HerdrCommandRunner>().mockRejectedValue(
        Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      ),
    });
    await expect(missing.versionCheck()).rejects.toMatchObject({
      name: "HerdrNotInstalledError",
      displayEndpoint: "session team",
    });
    await expect(missing.versionCheck()).rejects.toBeInstanceOf(
      HerdrNotInstalledError,
    );

    const unsupported = new HerdrCliClient({
      invocation,
      run: () => result("herdr 0.7.9"),
    });
    await expect(unsupported.versionCheck()).rejects.toMatchObject({
      name: "HerdrUnsupportedVersionError",
      version: "0.7.9",
      displayEndpoint: "session team",
    });
    await expect(unsupported.versionCheck()).rejects.toBeInstanceOf(
      HerdrUnsupportedVersionError,
    );

    vi.useFakeTimers();
    const timeout = new HerdrCliClient({
      invocation,
      run: vi.fn<HerdrCommandRunner>().mockReturnValue(new Promise(() => {})),
    });
    const timedOut = timeout.listAgents();
    const timeoutRejection = expect(timedOut).rejects.toMatchObject({
      name: "HerdrServerDownError",
      displayEndpoint: "session team",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await timeoutRejection;
    await expect(timedOut).rejects.toBeInstanceOf(HerdrServerDownError);
    vi.useRealTimers();

    const malformed = new HerdrCliClient({
      invocation,
      run: () => result("{not-json"),
    });
    await expect(malformed.listAgents()).rejects.toBeInstanceOf(
      HerdrProtocolError,
    );

    const agents = Array.from({ length: 1_001 }, (_, index) => ({
      agent: `agent-${index}`,
      agent_status: "idle",
      cwd: `/repo/${index}`,
      pane_id: `pane-${index}`,
      terminal_id: `terminal-${index}`,
      terminal_title_stripped: `Agent ${index}`,
      workspace_id: `workspace-${index}`,
    }));
    const oversized = new HerdrCliClient({
      invocation,
      run: () => result(JSON.stringify({ result: { agents } })),
    });
    await expect(oversized.listAgents()).rejects.toMatchObject({
      name: "HerdrProtocolError",
      displayEndpoint: "session team",
    });
  });

  test("accepts 0.8.2 and rejects 0.7.9", async () => {
    const supported = new HerdrCliClient({
      invocation,
      run: () => result("herdr 0.8.2"),
    });
    const unsupported = new HerdrCliClient({
      invocation,
      run: () => result("herdr 0.7.9"),
    });

    await expect(supported.versionCheck()).resolves.toEqual({ version: "0.8.2" });
    await expect(unsupported.versionCheck()).rejects.toBeInstanceOf(
      HerdrUnsupportedVersionError,
    );
  });

  test("maps code 127 to not installed", async () => {
    const client = new HerdrCliClient({
      invocation,
      run: () => result("", "herdr: command not found", 127),
    });

    await expect(client.versionCheck()).rejects.toBeInstanceOf(
      HerdrNotInstalledError,
    );
  });

  test("maps a nonzero agent-list exit to server down", async () => {
    const client = new HerdrCliClient({
      invocation,
      run: () => result("", "failed to connect to herdr server", 1),
    });

    await expect(client.listAgents()).rejects.toMatchObject({
      name: "HerdrServerDownError",
      displayEndpoint: "session team",
    });
  });

  test("returns an empty agent list", async () => {
    const client = new HerdrCliClient({
      invocation,
      run: () => result(JSON.stringify({ id: 1, result: { agents: [] } })),
    });

    await expect(client.listAgents()).resolves.toEqual([]);
  });

  test("rejects a malformed agent row instead of returning misleading values", async () => {
    const client = new HerdrCliClient({
      invocation,
      run: () =>
        result(
          JSON.stringify({
            result: {
              agents: [
                {
                  agent: "claude",
                  agent_status: "idle",
                  cwd: "/repo",
                  pane_id: "pane",
                  terminal_id: 123,
                  terminal_title_stripped: "Claude",
                  workspace_id: "workspace",
                },
              ],
            },
          }),
        ),
    });

    await expect(client.listAgents()).rejects.toBeInstanceOf(
      HerdrProtocolError,
    );
  });
});
