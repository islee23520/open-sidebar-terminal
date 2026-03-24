import * as vscode from "vscode";
import * as pty from "node-pty";
import * as os from "os";
import * as path from "path";

export interface Terminal {
  id: string;
  process: pty.IPty;
  onData: vscode.EventEmitter<{ id: string; data: string }>;
  onExit: vscode.EventEmitter<string>;
  port?: number;
  instanceId?: string;
}

export class TerminalManager {
  private terminals: Map<string, Terminal> = new Map();
  private instanceToTerminal: Map<string, string> = new Map();
  private readonly _onData = new vscode.EventEmitter<{
    id: string;
    data: string;
  }>();
  private readonly _onExit = new vscode.EventEmitter<string>();

  readonly onData = this._onData.event;
  readonly onExit = this._onExit.event;

  /**
   * Creates a terminal process and registers it by terminal id.
   */
  createTerminal(
    id: string,
    command?: string,
    env?: Record<string, string>,
    port?: number,
    cols?: number,
    rows?: number,
    instanceId?: string,
    cwd?: string,
  ): Terminal {
    if (this.terminals.has(id)) {
      this.killTerminal(id);
    }

    const { shell, args: shellArgs } = this.getShellConfig();
    const ptyArgs = command ? [...shellArgs, command] : [];

    const onDataEmitter = new vscode.EventEmitter<{
      id: string;
      data: string;
    }>();
    const onExitEmitter = new vscode.EventEmitter<string>();

    // Merge environment variables: custom env > process.env > defaults
    const mergedEnv: Record<string, string> = {
      ...process.env,
      TERM: "xterm-256color",
      ...env,
    } as Record<string, string>;

    const ptyProcess = pty.spawn(shell, ptyArgs, {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd:
        cwd ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        os.homedir(),
      env: mergedEnv,
      handleFlowControl: false,
    });

    ptyProcess.onData((data) => {
      onDataEmitter.fire({ id, data });
      this._onData.fire({ id, data });
    });

    ptyProcess.onExit(() => {
      onExitEmitter.fire(id);
      this._onExit.fire(id);
      this.terminals.delete(id);
      this.removeInstanceMappingForTerminal(id);
    });

    const terminal: Terminal = {
      id,
      process: ptyProcess,
      onData: onDataEmitter,
      onExit: onExitEmitter,
      port,
      instanceId,
    };

    this.terminals.set(id, terminal);
    if (instanceId) {
      this.instanceToTerminal.set(instanceId, id);
    }

    return terminal;
  }

  getTerminal(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  /**
   * Gets a terminal by instance id.
   */
  getByInstance(instanceId: string): Terminal | undefined {
    const terminalId = this.instanceToTerminal.get(instanceId);
    if (!terminalId) {
      return undefined;
    }

    return this.terminals.get(terminalId);
  }

  writeToTerminal(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.process.write(data);
    }
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.process.resize(cols, rows);
    }
  }

  /**
   * Kills a terminal by terminal id and cleans related mappings.
   */
  killTerminal(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.process.kill();
      terminal.onData.dispose();
      terminal.onExit.dispose();
      this.terminals.delete(id);
      this.removeInstanceMappingForTerminal(id);
    }
  }

  /**
   * Kills a terminal associated with the given instance id.
   */
  killByInstance(instanceId: string): void {
    const terminalId = this.instanceToTerminal.get(instanceId);
    if (!terminalId) {
      return;
    }

    this.killTerminal(terminalId);
    this.instanceToTerminal.delete(instanceId);
  }

  /**
   * Disposes all terminals and manager event emitters.
   */
  dispose(): void {
    for (const [id] of this.terminals) {
      this.killTerminal(id);
    }
    this.instanceToTerminal.clear();
    this._onData.dispose();
    this._onExit.dispose();
  }

  /**
   * Removes an instance-to-terminal mapping by terminal id.
   */
  private removeInstanceMappingForTerminal(terminalId: string): void {
    for (const [
      instanceId,
      mappedTerminalId,
    ] of this.instanceToTerminal.entries()) {
      if (mappedTerminalId === terminalId) {
        this.instanceToTerminal.delete(instanceId);
        break;
      }
    }
  }

  private getShellConfig(): { shell: string; args: string[] } {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    const overrideShell = config.get<string>("shellPath");
    const overrideArgs = config.get<string[]>("shellArgs");

    const shell =
      overrideShell ||
      vscode.env.shell ||
      (os.platform() === "win32"
        ? process.env.COMSPEC || "cmd.exe"
        : process.env.SHELL || "/bin/bash");

    if (overrideArgs && overrideArgs.length > 0) {
      return { shell, args: overrideArgs };
    }

    const shellName = path.basename(shell).toLowerCase();
    if (os.platform() === "win32") {
      if (shellName === "cmd.exe" || shellName === "cmd")
        return { shell, args: ["/c"] };
      if (shellName.includes("powershell") || shellName.includes("pwsh"))
        return { shell, args: ["-Command"] };
    }
    return { shell, args: ["-c"] };
  }
}
