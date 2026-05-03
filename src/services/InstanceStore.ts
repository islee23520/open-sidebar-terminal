import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import { TerminalBackendType } from "../types";

export type InstanceId = string;

export type InstanceState =
  | "disconnected"
  | "resolving"
  | "spawning"
  | "connecting"
  | "connected"
  | "error"
  | "stopping";

export interface InstanceConfig {
  id: InstanceId;
  workspaceUri?: string;
  label?: string;
  args?: string[];
  selectedAiTool?: string;
  preferredPort?: number;
  enableHttpApi?: boolean;
}

interface InstanceRuntime {
  port?: number;
  pid?: number;
  terminalKey?: string;
  tmuxSessionId?: string;
  zellijSessionId?: string;
  terminalBackend?: TerminalBackendType;
  lastSeenAt?: number;
}

interface InstanceHealth {
  ok: boolean;
  baseUrl?: string;
  sessionTitle?: string;
  model?: string;
  messageCount?: number;
  version?: string;
}

export interface InstanceRecord {
  config: InstanceConfig;
  runtime: InstanceRuntime;
  state: InstanceState;
  health?: InstanceHealth;
  error?: string;
}

type InstanceStoreEventMap = {
  change: [records: readonly InstanceRecord[]];
  setActive: [id: InstanceId];
  add: [record: InstanceRecord];
  remove: [id: InstanceId];
};

/**
 * In-memory registry for OpenCode instances.
 *
 * Maintains a strongly-typed record map and an always-valid active instance id
 * while at least one instance exists in the store.
 */
export class InstanceStore {
  private readonly records: Map<InstanceId, InstanceRecord> = new Map();
  private readonly emitter = new EventEmitter();
  private activeInstanceId: InstanceId | undefined;

  /**
   * Returns all instance records in insertion order.
   */
  public getAll(): readonly InstanceRecord[] {
    return Array.from(this.records.values(), (record) =>
      this.cloneRecord(record),
    );
  }

  /**
   * Returns one instance record by id.
   * @param id - Instance identifier.
   */
  public get(id: InstanceId): InstanceRecord | undefined {
    const record = this.records.get(id);
    return record ? this.cloneRecord(record) : undefined;
  }

  /**
   * Returns the active instance record.
   * @throws Error when the store is empty.
   */
  public getActive(): InstanceRecord {
    if (this.records.size === 0 || this.activeInstanceId === undefined) {
      throw new Error("Cannot get active instance from an empty store");
    }

    const active = this.records.get(this.activeInstanceId);
    if (!active) {
      throw new Error("Active instance id does not exist in store");
    }

    return this.cloneRecord(active);
  }

  /**
   * Sets the active instance id.
   * @param id - Instance identifier to set as active.
   * @throws Error when id does not exist in the store.
   */
  public setActive(id: InstanceId): void {
    if (!this.records.has(id)) {
      throw new Error(`Cannot set active instance: unknown id '${id}'`);
    }

    if (this.activeInstanceId === id) {
      return;
    }

    this.activeInstanceId = id;
    this.emit("setActive", id);
    this.emit("change", this.getAll());
  }

  /**
   * Inserts or updates an instance record.
   * @param record - The instance record to insert or update.
   */
  public upsert(record: InstanceRecord): void {
    const id = record.config.id;
    const existed = this.records.has(id);

    this.records.set(id, this.cloneRecord(record));

    if (this.activeInstanceId === undefined) {
      this.activeInstanceId = id;
      this.emit("setActive", id);
    }

    if (!existed) {
      this.emit("add", this.cloneRecord(record));
    }

    this.emit("change", this.getAll());
  }

  /**
   * Removes an instance record by id.
   * @param id - Instance identifier to remove.
   * @returns true if removed, false if id did not exist.
   */
  public remove(id: InstanceId): boolean {
    const removed = this.records.delete(id);
    if (!removed) {
      return false;
    }

    this.emit("remove", id);

    if (this.activeInstanceId === id) {
      const next = this.records.keys().next();
      this.activeInstanceId = next.done ? undefined : next.value;

      if (this.activeInstanceId) {
        this.emit("setActive", this.activeInstanceId);
      }
    }

    this.emit("change", this.getAll());
    return true;
  }

  /**
   * Subscribes to any store mutation.
   * @param listener - Listener invoked with all current records.
   */
  public onDidChange(
    listener: (records: readonly InstanceRecord[]) => void,
  ): vscode.Disposable {
    return this.on("change", listener);
  }

  /**
   * Subscribes to active instance changes.
   * @param listener - Listener invoked with the active instance id.
   */
  public onDidSetActive(listener: (id: InstanceId) => void): vscode.Disposable {
    return this.on("setActive", listener);
  }

  /**
   * Subscribes to new instance additions.
   * @param listener - Listener invoked with the added record.
   */
  public onDidAdd(
    listener: (record: InstanceRecord) => void,
  ): vscode.Disposable {
    return this.on("add", listener);
  }

  /**
   * Subscribes to instance removals.
   * @param listener - Listener invoked with the removed id.
   */
  public onDidRemove(listener: (id: InstanceId) => void): vscode.Disposable {
    return this.on("remove", listener);
  }

  private on<K extends keyof InstanceStoreEventMap>(
    event: K,
    listener: (...args: InstanceStoreEventMap[K]) => void,
  ): vscode.Disposable {
    this.emitter.on(event, listener as (...args: unknown[]) => void);

    return new vscode.Disposable(() => {
      this.emitter.off(event, listener as (...args: unknown[]) => void);
    });
  }

  private emit<K extends keyof InstanceStoreEventMap>(
    event: K,
    ...args: InstanceStoreEventMap[K]
  ): void {
    this.emitter.emit(event, ...args);
  }

  private cloneRecord(record: InstanceRecord): InstanceRecord {
    return {
      config: {
        ...record.config,
        args: record.config.args ? [...record.config.args] : undefined,
      },
      runtime: {
        ...record.runtime,
      },
      state: record.state,
      health: record.health
        ? {
            ...record.health,
          }
        : undefined,
      error: record.error,
    };
  }
}
