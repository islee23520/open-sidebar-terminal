import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test.each(["missing", "unready", "malformed"])("does not fall back to an older DAG when the newest connected session pane is %s", async (paneState) => {
    const dir = await mkdtemp(join(tmpdir(), "ulw-dag-sessions-"));
    try {
      for (const [sessionId, updatedAt] of [["old", "2026-09-08T00:00:00Z"], ["new", "2026-09-09T00:00:00Z"]]) {
        const key = createHash("sha256").update(JSON.stringify(["/server.sock", "w1:p1", sessionId])).digest("hex").slice(0, 24);
        await writeFile(join(dir, `${key}.json`), JSON.stringify({ sessionId, updatedAt, connected: true }));
        if (sessionId === "old") await writeFile(join(dir, `${key}.pane.json`), JSON.stringify({ paneId: "w1:p2", ready: true }));
        else if (paneState !== "missing") await writeFile(join(dir, `${key}.pane.json`), paneState === "malformed" ? "{broken" : JSON.stringify({ paneId: "w1:p3", ready: false }));
      }
      const run = vi.fn<HerdrCommandRunner>(async (_command, args) => result(JSON.stringify(
        args.includes("status") ? { server: { socket: "/server.sock" } } : { result: { pane: { pane_id: "w1:p2", terminal_id: "old-live-dag" } } },
      )));
      const client = new HerdrCliClient({ run, invocation: { ...invocation, env: { OMO_HERDR_DAG_STATE_DIR: dir } } });
      await expect(client.findDagPane("w1:p1")).resolves.toBeUndefined();
      expect(run.mock.calls.some(([, args]) => args.includes("pane"))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test.each([false, true])("discovers only the live DAG associated with this socket and parent (custom directory: %s)", async (customDirectory) => {
    const home = await mkdtemp(join(tmpdir(), "ulw-dag-test-"));
    try {
      const dir = customDirectory ? join(home, "custom-plugin-state") : join(home, ".omo/agent/herdr-dag");
      await mkdir(dir, { recursive: true });
      const key = createHash("sha256").update(JSON.stringify(["/server.sock", "w1:p1", "session-a"])).digest("hex").slice(0, 24);
      await writeFile(join(dir, `${key}.json`), JSON.stringify({ sessionId: "session-a", connected: true, updatedAt: "2026-09-09" }));
      await writeFile(join(dir, `${key}.pane.json`), JSON.stringify({ paneId: "w1:p2", ready: true }));
      const run = vi.fn<HerdrCommandRunner>(async (_command, args) => result(JSON.stringify(
        args.includes("status") ? { server: { socket: "/server.sock" } } : { result: { pane: { pane_id: "w1:p2", terminal_id: "dag-terminal" } } },
      )));
      const client = new HerdrCliClient({ run, invocation: { ...invocation, env: { HOME: home, ...(customDirectory ? { OMO_HERDR_DAG_STATE_DIR: dir } : {}) } } });
      await expect(client.findDagPane("w1:p1")).resolves.toEqual({ terminalId: "dag-terminal", label: "DAG" });
      await expect(client.findDagPane("w1:p9")).resolves.toBeUndefined();
      await writeFile(join(dir, `${key}.pane.json`), "{broken");
      await expect(client.findDagPane("w1:p1")).resolves.toBeUndefined();
      await writeFile(join(dir, `${key}.pane.json`), JSON.stringify({ paneId: "w1:p2", ready: true }));
      run.mockImplementation(async (_command, args) => args.includes("status") ? result(JSON.stringify({ server: { socket: "/other.sock" } })) : result("", "pane_not_found", 1));
      await expect(client.findDagPane("w1:p1")).resolves.toBeUndefined();
      run.mockImplementation(async (_command, args) => args.includes("status") ? result(JSON.stringify({ server: { socket: "/server.sock" } })) : result("", "pane_not_found", 1));
      await expect(client.findDagPane("w1:p1")).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("never reads local DAG metadata for a forwarded host", async () => {
    const run = vi.fn<HerdrCommandRunner>();
    const client = new HerdrCliClient({ run, invocation, localDagMetadata: false });
    await expect(client.findDagPane("w1:p1")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

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

  test("keeps agents whose cwd or title is missing", async () => {
    const client = new HerdrCliClient({
      invocation,
      run: () =>
        result(
          JSON.stringify({
            result: {
              agents: [
                {
                  agent: "pi",
                  agent_status: "working",
                  pane_id: "w46:p1",
                  terminal_id: "term-1",
                  workspace_id: "w46",
                },
              ],
            },
          }),
        ),
    });
    await expect(client.listAgents()).resolves.toEqual([
      {
        paneId: "w46:p1",
        terminalId: "term-1",
        agent: "pi",
        status: "working",
        title: "",
        cwd: "",
        workspaceId: "w46",
      },
    ]);
  });

  test("maps workspace list rows for the Spaces tree", async () => {
    const run = vi.fn<HerdrCommandRunner>().mockImplementation(() =>
      result(
        JSON.stringify({
          id: "cli:workspace:list",
          result: {
            type: "workspace_list",
            workspaces: [
              {
                workspace_id: "w46",
                label: "ulwcode",
                agent_status: "working",
                pane_count: 1,
                tab_count: 1,
                focused: true,
              },
            ],
          },
        }),
      ),
    );
    const client = new HerdrCliClient({ run, invocation });

    await expect(client.listWorkspaces()).resolves.toEqual([
      {
        workspaceId: "w46",
        label: "ulwcode",
        status: "working",
        paneCount: 1,
      },
    ]);
    expect(run).toHaveBeenCalledWith(
      "/opt/herdr",
      ["--session", "team", "workspace", "list"],
      { PATH: "/bin" },
      5_000,
    );
  });

  test("rejects a workspace list without result.workspaces", async () => {
    const client = new HerdrCliClient({
      invocation,
      run: () => result(JSON.stringify({ id: 1, result: {} })),
    });
    await expect(client.listWorkspaces()).rejects.toBeInstanceOf(
      HerdrProtocolError,
    );
  });
});
