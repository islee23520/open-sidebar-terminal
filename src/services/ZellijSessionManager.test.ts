import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZellijSessionManager } from "./ZellijSessionManager";

type MockExecStep = {
  stdout?: string;
  stderr?: string;
  error?: (Error & { code?: number | string }) | null;
};

describe("ZellijSessionManager", () => {
  let manager: ZellijSessionManager;
  let execCalls: Array<{ file: string; args: string[]; cwd?: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    execCalls = [];
    manager = new ZellijSessionManager();
  });

  function mockExecSequence(steps: MockExecStep[]): void {
    let callIndex = 0;
    manager = new ZellijSessionManager(undefined, (file, args, options, callback) => {
      execCalls.push({ file, args, cwd: options.cwd?.toString() });
      const step = steps[callIndex++] ?? { stdout: "", stderr: "" };
      callback(step.error ?? null, step.stdout ?? "", step.stderr ?? "");
    });
  }

  it("reports available when zellij version command succeeds", async () => {
    mockExecSequence([{ stdout: "zellij 0.41.2" }]);

    await expect(manager.isAvailable()).resolves.toBe(true);
    expect(execCalls[0]?.args).toEqual(["--version"]);
  });

  it("reports unavailable when zellij binary is missing", async () => {
    const missingZellijError = Object.assign(new Error("spawn zellij ENOENT"), {
      code: "ENOENT",
    });
    mockExecSequence([{ error: missingZellijError }]);

    await expect(manager.isAvailable()).resolves.toBe(false);
  });

  it("parses zellij sessions", async () => {
    mockExecSequence([{ stdout: "repo-a\nrepo-b (current)\n" }]);

    await expect(manager.discoverSessions()).resolves.toEqual([
      { id: "repo-a", name: "repo-a", workspace: "repo-a", isActive: false },
      { id: "repo-b", name: "repo-b", workspace: "repo-b", isActive: true },
    ]);
  });

  it("creates missing sessions with create-background attach", async () => {
    mockExecSequence([{ stdout: "" }, { stdout: "" }]);

    await expect(
      manager.ensureSession("repo-a", "/workspace/repo-a"),
    ).resolves.toMatchObject({
      action: "created",
      session: { id: "repo-a" },
    });

    expect(execCalls[1]?.args).toEqual([
      "attach",
      "--create-background",
      "repo-a",
    ]);
    expect(execCalls[1]?.cwd).toBe("/workspace/repo-a");
  });

  it("builds attach command", () => {
    expect(manager.getAttachCommand("repo-a")).toBe("zellij attach 'repo-a'");
  });
});
