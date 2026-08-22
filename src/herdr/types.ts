export type HerdrPlatform = "darwin" | "linux" | "win32";

export interface HerdrInvocationInput {
  readonly executablePath?: string;
  readonly session?: string;
  readonly socketPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: HerdrPlatform;
}

export interface HerdrInvocation {
  readonly command: string;
  readonly argsPrefix: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly displayEndpoint: string;
  readonly warnings: readonly string[];
}

export interface HerdrCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type HerdrCommandRunner = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
) => Promise<HerdrCommandResult>;

export interface HerdrTimers {
  readonly setTimeout: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface HerdrAgent {
  readonly paneId: string;
  readonly terminalId: string;
  readonly agent: string;
  readonly status: string;
  readonly title: string;
  readonly cwd: string;
  readonly workspaceId: string;
}
