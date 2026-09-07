import * as os from "os";
import * as pty from "node-pty";
import * as vscode from "vscode";
import type { HerdrScrollGesture } from "../types";
import type { TerminalTransport } from "./TerminalTransport";

export class LocalShellTransport implements TerminalTransport {
  public readonly kind = "local-shell" as const;
  public readonly pid: number;
  public exitCode: number | undefined;
  public exitSignal: number | undefined;

  private readonly outputEmitter = new vscode.EventEmitter<{
    data: string;
    replay: "append";
  }>();
  private readonly exitEmitter = new vscode.EventEmitter<{
    reason: "process-exit";
    message?: string;
  }>();
  private readonly process: pty.IPty;
  private closed = false;

  public readonly onOutput = this.outputEmitter.event;
  public readonly onExit = this.exitEmitter.event;

  public constructor(
    cols: number,
    rows: number,
    cwd = LocalShellTransport.resolveWorkingDirectory(),
  ) {
    const configuration = vscode.workspace.getConfiguration("ulw");
    const configuredShell = configuration.get<string>("shellPath", "").trim();
    const shell = configuredShell || vscode.env.shell || this.defaultShell();
    const args = configuration.get<readonly string[]>("shellArgs", []);

    this.process = pty.spawn(shell, [...args], {
      name: "xterm-256color",
      cols: this.normalizeDimension(cols, 80),
      rows: this.normalizeDimension(rows, 24),
      cwd,
      env: this.buildEnvironment(),
    });
    this.pid = this.process.pid;
    this.process.onData((data) => {
      if (!this.closed) {
        this.outputEmitter.fire({ data, replay: "append" });
      }
    });
    this.process.onExit(({ exitCode, signal }) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.exitCode = exitCode;
      this.exitSignal = signal;
      const signalMessage = signal === undefined ? "" : `, signal ${signal}`;
      this.exitEmitter.fire({
        reason: "process-exit",
        message: `code ${exitCode}${signalMessage}`,
      });
    });
  }

  public unwrap(): pty.IPty {
    return this.process;
  }

  public write(data: string): void {
    this.process.write(data);
  }

  public scroll(_gesture: HerdrScrollGesture): void {
    // Local shells scroll through xterm; Herdr scroll is attach-only.
  }

  public resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) {
      return;
    }
    this.process.resize(cols, rows);
  }

  public async close(_reason: "release" | "shutdown"): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.process.kill();
  }

  private static resolveWorkingDirectory(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private defaultShell(): string {
    if (process.platform === "win32") {
      return process.env.COMSPEC ?? "cmd.exe";
    }
    return process.env.SHELL ?? "/bin/sh";
  }

  private buildEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        environment[key] = value;
      }
    }
    environment.TERM = "xterm-256color";
    environment.COLORTERM = "truecolor";
    const utf8Locale =
      environment.LANG && environment.LANG.includes("UTF-8")
        ? environment.LANG
        : "en_US.UTF-8";
    if (!environment.LANG || !environment.LANG.includes("UTF-8")) {
      environment.LANG = utf8Locale;
    }
    if (!environment.LC_CTYPE) {
      environment.LC_CTYPE = environment.LANG;
    }
    return environment;
  }

  private normalizeDimension(value: number, fallback: number): number {
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
