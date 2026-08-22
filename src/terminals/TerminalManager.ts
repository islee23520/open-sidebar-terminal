import type * as pty from "node-pty";
import * as vscode from "vscode";
import { LocalShellTransport } from "./LocalShellTransport";
import type {
  TerminalTransport,
  TerminalTransportExitReason,
} from "./TerminalTransport";

const MAX_SHELL_REPLAY_CHARS = 500_000;
const MAX_ATTACHED_REPLAY_BYTES = 8 * 1024 * 1024;

export interface TerminalDataEvent {
  readonly id: string;
  readonly data: string;
  readonly replay: "append" | "replace";
}

export interface TerminalExitEvent {
  readonly id: string;
  readonly code: number;
  readonly signal?: number;
  readonly reason: TerminalTransportExitReason;
  readonly message?: string;
}

export interface TerminalStartEvent {
  readonly id: string;
  readonly pid: number;
}

interface TerminalSlot {
  localShell?: LocalShellTransport;
  localGeneration: number;
  localReplay: string;
  attached?: TerminalTransport;
  attachedGeneration: number;
  attachedReplay: string;
}

export class TerminalManager implements vscode.Disposable {
  private readonly slots = new Map<string, TerminalSlot>();
  private readonly dataEmitter = new vscode.EventEmitter<TerminalDataEvent>();
  private readonly exitEmitter = new vscode.EventEmitter<TerminalExitEvent>();
  private readonly startEmitter = new vscode.EventEmitter<TerminalStartEvent>();

  public readonly onData = this.dataEmitter.event;
  public readonly onExit = this.exitEmitter.event;
  public readonly onStart = this.startEmitter.event;

  public createTerminal(
    id: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): pty.IPty {
    return this.ensureLocalShell(id, cols, rows, cwd).unwrap();
  }

  public ensureLocalShell(
    id: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): LocalShellTransport {
    const slot = this.getOrCreateSlot(id);
    if (slot.localShell) {
      return slot.localShell;
    }

    const shell = new LocalShellTransport(cols, rows, cwd);
    const generation = slot.localGeneration + 1;
    slot.localGeneration = generation;
    slot.localShell = shell;
    this.startEmitter.fire({ id, pid: shell.pid });
    shell.onOutput(({ data, replay }) => {
      if (slot.localGeneration !== generation || slot.localShell !== shell) {
        return;
      }
      slot.localReplay = this.appendShellReplay(slot.localReplay, data);
      if (!slot.attached) {
        this.dataEmitter.fire(this.createDataEvent(id, data, replay));
      }
    });
    shell.onExit(({ reason, message }) => {
      if (slot.localGeneration !== generation || slot.localShell !== shell) {
        return;
      }
      slot.localShell = undefined;
      slot.localReplay = "";
      this.exitEmitter.fire(
        this.createExitEvent(
          id,
          shell.exitCode ?? 0,
          shell.exitSignal,
          reason,
          message,
        ),
      );
      this.deleteEmptySlot(id, slot);
    });
    return shell;
  }

  public attach(id: string, transportFactory: () => TerminalTransport): TerminalTransport {
    const slot = this.getOrCreateSlot(id);
    const previous = slot.attached;
    if (previous) {
      slot.attachedGeneration += 1;
      slot.attached = undefined;
      slot.attachedReplay = "";
      void previous.close("release");
    }

    const transport = transportFactory();
    const generation = slot.attachedGeneration + 1;
    slot.attachedGeneration = generation;
    slot.attached = transport;
    slot.attachedReplay = "";
    transport.onOutput(({ data, replay }) => {
      if (!this.isCurrentAttached(slot, transport, generation)) {
        return;
      }
      const nextReplay = replay === "replace" ? data : slot.attachedReplay + data;
      if (Buffer.byteLength(nextReplay, "utf8") > MAX_ATTACHED_REPLAY_BYTES) {
        this.failAttachedReplay(id, slot, transport, generation);
        return;
      }
      slot.attachedReplay = nextReplay;
      this.dataEmitter.fire(this.createDataEvent(id, data, replay));
    });
    transport.onExit(({ reason, message }) => {
      if (!this.isCurrentAttached(slot, transport, generation)) {
        return;
      }
      slot.attached = undefined;
      slot.attachedReplay = "";
      this.exitEmitter.fire(
        this.createExitEvent(id, 0, undefined, reason, message),
      );
      this.deleteEmptySlot(id, slot);
    });
    return transport;
  }

  public detach(id: string): void {
    const slot = this.slots.get(id);
    const attached = slot?.attached;
    if (!slot || !attached) {
      return;
    }
    slot.attachedGeneration += 1;
    slot.attached = undefined;
    slot.attachedReplay = "";
    void attached.close("release");
    this.deleteEmptySlot(id, slot);
  }

  public activeSource(
    id: string,
  ): "local-shell" | "herdr-control" | undefined {
    const slot = this.slots.get(id);
    return slot?.attached?.kind ?? slot?.localShell?.kind;
  }

  public replay(id: string): string {
    const slot = this.slots.get(id);
    if (!slot) {
      return "";
    }
    return slot.attached ? slot.attachedReplay : slot.localReplay;
  }

  public hasTerminal(id: string): boolean {
    return this.slots.get(id)?.localShell !== undefined;
  }

  public terminalCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) {
      if (slot.localShell) {
        count += 1;
      }
    }
    return count;
  }

  public write(id: string, data: string): void {
    const slot = this.slots.get(id);
    (slot?.attached ?? slot?.localShell)?.write(data);
  }

  public resize(id: string, cols: number, rows: number): void {
    if (cols < 1 || rows < 1) {
      return;
    }
    const slot = this.slots.get(id);
    (slot?.attached ?? slot?.localShell)?.resize(cols, rows);
  }

  public kill(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) {
      return;
    }
    this.slots.delete(id);
    const attached = slot.attached;
    const shell = slot.localShell;
    slot.attachedGeneration += 1;
    slot.localGeneration += 1;
    slot.attached = undefined;
    slot.localShell = undefined;
    slot.attachedReplay = "";
    slot.localReplay = "";
    if (attached) {
      void attached.close("shutdown");
    }
    if (shell) {
      void shell.close("shutdown");
    }
  }

  public dispose(): void {
    for (const id of [...this.slots.keys()]) {
      this.kill(id);
    }
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
    this.startEmitter.dispose();
  }

  private getOrCreateSlot(id: string): TerminalSlot {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = {
        localGeneration: 0,
        localReplay: "",
        attachedGeneration: 0,
        attachedReplay: "",
      };
      this.slots.set(id, slot);
    }
    return slot;
  }

  private appendShellReplay(current: string, data: string): string {
    const replay = current + data;
    return replay.length > MAX_SHELL_REPLAY_CHARS
      ? replay.slice(replay.length - MAX_SHELL_REPLAY_CHARS)
      : replay;
  }

  private isCurrentAttached(
    slot: TerminalSlot,
    transport: TerminalTransport,
    generation: number,
  ): boolean {
    return (
      slot.attachedGeneration === generation && slot.attached === transport
    );
  }

  private failAttachedReplay(
    id: string,
    slot: TerminalSlot,
    transport: TerminalTransport,
    generation: number,
  ): void {
    if (!this.isCurrentAttached(slot, transport, generation)) {
      return;
    }
    slot.attachedGeneration += 1;
    slot.attached = undefined;
    slot.attachedReplay = "";
    void transport.close("release");
    this.exitEmitter.fire(
      this.createExitEvent(
        id,
        0,
        undefined,
        "protocol-error",
        "Attached terminal replay exceeded the 8 MiB limit.",
      ),
    );
    this.deleteEmptySlot(id, slot);
  }

  private createDataEvent(
    id: string,
    data: string,
    replay: "append" | "replace",
  ): TerminalDataEvent {
    const event = { id, data } as TerminalDataEvent;
    Object.defineProperty(event, "replay", { value: replay, enumerable: false });
    return event;
  }

  private createExitEvent(
    id: string,
    code: number,
    signal: number | undefined,
    reason: TerminalTransportExitReason,
    message: string | undefined,
  ): TerminalExitEvent {
    const event = (signal === undefined
      ? { id, code }
      : { id, code, signal }) as TerminalExitEvent;
    Object.defineProperties(event, {
      reason: { value: reason, enumerable: false },
      message: { value: message, enumerable: false },
    });
    return event;
  }

  private deleteEmptySlot(id: string, slot: TerminalSlot): void {
    if (!slot.localShell && !slot.attached) {
      this.slots.delete(id);
    }
  }
}
