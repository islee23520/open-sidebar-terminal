import type { HerdrInvocation, HerdrInvocationInput } from "./types";

const SOCKET_ENV = "HERDR_SOCKET_PATH";

export class HerdrInvocationResolver {
  public static resolve(input: HerdrInvocationInput): HerdrInvocation {
    const command = input.executablePath?.trim() || "herdr";
    const session = input.session?.trim() || "";
    const socketPath = input.socketPath?.trim() || "";
    const env = this.copyEnvironment(input.env);
    this.prependCommonBinDirs(env, input.platform);
    const argsPrefix: string[] = [];
    const warnings: string[] = [];
    let displayEndpoint = "herdr default";

    if (session) {
      argsPrefix.push("--session", session);
      delete env[SOCKET_ENV];
      displayEndpoint = `session ${session}`;
      if (socketPath) {
        warnings.push(
          `Herdr session \"${session}\" is configured; socketPath \"${socketPath}\" is ignored.`,
        );
      }
    } else if (socketPath) {
      env[SOCKET_ENV] = socketPath;
      displayEndpoint = `socket ${socketPath}`;
    } else if (env[SOCKET_ENV]) {
      displayEndpoint = `inherited socket ${env[SOCKET_ENV]}`;
    }

    return Object.freeze({
      command,
      argsPrefix: Object.freeze(argsPrefix),
      env: Object.freeze(env),
      displayEndpoint,
      warnings: Object.freeze(warnings),
    });
  }

  private static copyEnvironment(
    source: Readonly<Record<string, string | undefined>>,
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }

  private static prependCommonBinDirs(
    env: Record<string, string>,
    platform: HerdrInvocationInput["platform"],
  ): void {
    const home = env.HOME ?? env.USERPROFILE;
    if (!home) {
      return;
    }
    const extra = `${home}/.local/bin`;
    const separator = platform === "win32" ? ";" : ":";
    const parts = (env.PATH ?? "").split(separator).filter(Boolean);
    if (parts.includes(extra)) {
      return;
    }
    env.PATH = [extra, ...parts].join(separator);
  }
}
