// Opt-in live integration test: drives the REAL HerdrSshForward over REAL ssh
// against a live Herdr server. Skipped unless ULW_LIVE_SSH=1 is set.
import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "vitest";
import { HerdrSshForward } from "./HerdrSshForward";

const HERDR = process.env.ULW_E2E_HERDR ?? "/Users/ilseoblee/.local/bin/herdr";

function run(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

function runBridge(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  holdMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    setTimeout(() => child.stdin.end(), holdMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

describe.skipIf(process.env.ULW_LIVE_SSH !== "1")(
  "HerdrSshForward live over ssh localhost",
  () => {
    test("forwards listing and attach through the real ssh child, then disposes", async () => {
      const forward = new HerdrSshForward({
        target: "localhost",
        localApiSocket: join(tmpdir(), `ulw-live-${process.pid}.sock`),
        localClientSocket: join(tmpdir(), `ulw-live-${process.pid}-client.sock`),
      });

      const sockets = await forward.start();
      expect(sockets.apiSocketPath).toBe(
        join(tmpdir(), `ulw-live-${process.pid}.sock`),
      );

      const listing = await run(HERDR, ["agent", "list"], {
        HERDR_SOCKET_PATH: sockets.apiSocketPath,
      });
      const parsed = JSON.parse(listing.stdout) as {
        result?: { agents?: unknown[] };
      };
      const agentCount = (parsed.result?.agents ?? []).length;
      // eslint-disable-next-line no-console
      console.log(`[live] agents through forward: ${agentCount}`);
      expect(agentCount).toBeGreaterThan(0);

      const workspaceDir = join(tmpdir(), `ulw-live-ws-${process.pid}`);
      await fs.mkdir(workspaceDir, { recursive: true });
      const created = await run(
        HERDR,
        ["workspace", "create", "--cwd", workspaceDir, "--label", "ulw-live-probe", "--no-focus"],
      );
      const createdJson = JSON.parse(created.stdout) as {
        result: {
          workspace: { workspace_id: string };
          root_pane: { terminal_id: string };
        };
      };
      const workspaceId = createdJson.result.workspace.workspace_id;
      const terminalId = createdJson.result.root_pane.terminal_id;

      const bridge = await runBridge(
        HERDR,
        [
          "terminal",
          "session",
          "control",
          terminalId,
          "--takeover",
          "--cols",
          "80",
          "--rows",
          "24",
        ],
        { HERDR_SOCKET_PATH: sockets.apiSocketPath },
        3_000,
      );
      const frames = (bridge.stdout.match(/terminal\.frame/g) ?? []).length;
      const closures = (bridge.stdout.match(/terminal\.closed/g) ?? []).length;
      // eslint-disable-next-line no-console
      console.log(
        `[live] bridge exit=${bridge.code} frames=${frames} closures=${closures} stderr="${bridge.stderr.trim()}"`,
      );
      expect(bridge.code).toBe(0);
      expect(frames).toBeGreaterThan(0);
      expect(closures).toBe(1);
      expect(bridge.stderr).not.toContain("failed");

      await run(HERDR, ["workspace", "close", workspaceId]);
      await fs.rm(workspaceDir, { recursive: true, force: true });

      forward.dispose();

      const sshAlive = await new Promise<number>((resolve) => {
        execFile("pgrep", ["-f", `ulw-live-${process.pid}.sock`], (error) =>
          resolve(error ? 0 : 1),
        );
      });
      // eslint-disable-next-line no-console
      console.log(`[live] ssh child alive after dispose: ${sshAlive}`);
      expect(sshAlive).toBe(0);
      await expect(fs.access(sockets.apiSocketPath)).rejects.toThrow();
      await expect(fs.access(sockets.clientSocketPath)).rejects.toThrow();
    }, 30_000);
  },
);
