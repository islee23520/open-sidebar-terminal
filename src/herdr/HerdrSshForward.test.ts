import { createServer, type Server } from "net";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";
import { PassThrough, Writable } from "stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  HerdrSshForward,
  type HerdrSshForwardChild,
  type HerdrSshSpawn,
} from "./HerdrSshForward";

class FakeSshChild extends EventEmitter implements HerdrSshForwardChild {
  public readonly stderr = new PassThrough();
  public readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

let uniqueId = 0;
const trackedServers: Server[] = [];
const trackedPaths: string[] = [];
const trackedChildren: FakeSshChild[] = [];

function makePaths(): { api: string; client: string } {
  uniqueId += 1;
  const api = join(tmpdir(), `ulw-fwd-test-${process.pid}-${uniqueId}.sock`);
  const client = join(tmpdir(), `ulw-fwd-test-${process.pid}-${uniqueId}-client.sock`);
  trackedPaths.push(api, client);
  return { api, client };
}

function listenOn(path: string): Promise<Server> {
  const server = createServer();
  trackedServers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

async function listenAll(paths: readonly string[]): Promise<Server[]> {
  return Promise.all(paths.map((path) => listenOn(path)));
}

async function closeAll(): Promise<void> {
  for (const server of trackedServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeForward(
  paths: { api: string; client: string },
  overrides: Partial<ConstructorParameters<typeof HerdrSshForward>[0]> = {},
) {
  const child = new FakeSshChild();
  trackedChildren.push(child);
  const spawnFn = vi.fn(
    (_command: string, _args: readonly string[], _options: unknown) => child,
  ) as unknown as HerdrSshSpawn;
  const forward = new HerdrSshForward({
    target: "u@h",
    localApiSocket: paths.api,
    localClientSocket: paths.client,
    spawnFn,
    homeQuery: async () => "/remotehome",
    ...overrides,
  });
  return { forward, child, spawnFn };
}

afterEach(async () => {
  await closeAll();
  for (const child of trackedChildren.splice(0)) {
    child.removeAllListeners();
  }
  for (const path of trackedPaths.splice(0)) {
    await fs.rm(path, { force: true });
  }
});

describe("HerdrSshForward", () => {
  test("builds dual -L arguments with the target as one argv element", () => {
    expect(
      HerdrSshForward.buildArgs(
        {
          remoteApiSocket: "/remotehome/.config/herdr/herdr.sock",
          remoteClientSocket: "/remotehome/.config/herdr/herdr-client.sock",
        },
        "u@h -J jump; rm -rf /",
        "/tmp/a.sock",
        "/tmp/a-client.sock",
      ),
    ).toEqual([
      "-nNT",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "/tmp/a.sock:/remotehome/.config/herdr/herdr.sock",
      "-L",
      "/tmp/a-client.sock:/remotehome/.config/herdr/herdr-client.sock",
      "u@h -J jump; rm -rf /",
    ]);
  });

  test("queries the remote home, spawns ssh with dual forwards, and resolves when sockets accept", async () => {
    const paths = makePaths();
    const servers = await listenAll([paths.api, paths.client]);
    const { forward, spawnFn } = makeForward(paths);

    const sockets = await forward.start();

    expect(sockets).toEqual({
      apiSocketPath: paths.api,
      clientSocketPath: paths.client,
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "ssh",
      [
        "-nNT",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `${paths.api}:/remotehome/.config/herdr/herdr.sock`,
        "-L",
        `${paths.client}:/remotehome/.config/herdr/herdr-client.sock`,
        "u@h",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    void servers;
  });

  test("rejects with the ssh stderr when the child exits before readiness", async () => {
    const paths = makePaths();
    const { forward, child } = makeForward(paths, { readinessTimeoutMs: 5_000 });

    const starting = forward.start();
    // Let start() attach its exit/error listeners before the child fails.
    await new Promise((resolve) => setImmediate(resolve));
    child.stderr.write("Host key verification failed.\n");
    child.emit("exit", 255, null);

    await expect(starting).rejects.toThrow(/Host key verification failed/);
  });

  test("stops polling and kills the child when readiness times out", async () => {
    vi.useFakeTimers();
    const paths = makePaths();
    const { forward, child } = makeForward(paths, { readinessTimeoutMs: 200 });

    const starting = forward.start();
    const expectation = expect(starting).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(200);
    await expectation;

    expect(child.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test("does not spawn ssh when dispose happens during the remote-home query", async () => {
    const paths = makePaths();
    let releaseHome: (home: string) => void = () => undefined;
    const { forward, spawnFn } = makeForward(paths, {
      homeQuery: () =>
        new Promise<string>((resolve) => {
          releaseHome = resolve;
        }),
    });

    const starting = forward.start();
    forward.dispose();
    releaseHome("/remotehome");

    await expect(starting).rejects.toThrow(/disposed/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  test("dispose kills the ssh child and removes the local sockets", async () => {
    const paths = makePaths();
    const servers = await listenAll([paths.api, paths.client]);
    const { forward, child } = makeForward(paths);

    await forward.start();
    await closeAll();
    void servers;
    for (const path of [paths.api, paths.client]) {
      await fs.rm(path, { force: true });
      await fs.writeFile(path, "stale");
    }

    forward.dispose();

    expect(child.kill).toHaveBeenCalled();
    for (const path of [paths.api, paths.client]) {
      await expect(fs.access(path)).rejects.toThrow();
    }
  });
});
