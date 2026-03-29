import * as vscode from "vscode";
import {
  InstanceDiscoveryService,
  OpenCodeInstance,
} from "./InstanceDiscoveryService";
import { InstanceController } from "./InstanceController";
import { InstanceId, InstanceRecord, InstanceStore } from "./InstanceStore";
import { OpenCodeApiClient } from "./OpenCodeApiClient";

export class ConnectionResolver {
  private readonly clientPool: Map<InstanceId, OpenCodeApiClient> = new Map();

  constructor(
    private readonly instanceStore: InstanceStore,
    private readonly discoveryService: InstanceDiscoveryService = new InstanceDiscoveryService(),
    private readonly controller?: InstanceController,
    private readonly outputChannel?: vscode.OutputChannel,
  ) {}

  /** Resolves a healthy port for an instance, or undefined when unavailable. */
  public async resolve(instanceId: InstanceId): Promise<number | undefined> {
    const record = this.instanceStore.get(instanceId);
    this.log(`Resolving instance '${instanceId}'`);

    const storedPort = this.getStoredPort(record);
    if (storedPort !== undefined) {
      this.log(`Tier 1: found stored port ${storedPort} for '${instanceId}'`);

      if (await this.healthCheck(instanceId, storedPort)) {
        this.log(`Tier 2: stored port ${storedPort} is healthy`);
        this.syncRecordRuntime(instanceId, record, { port: storedPort });
        return storedPort;
      }

      this.log(`Tier 2: stored port ${storedPort} failed health check`);
    } else {
      this.log(`Tier 1: no stored port found for '${instanceId}'`);
    }

    const discoveredPort = await this.resolveFromDiscovery(instanceId, record);
    if (discoveredPort !== undefined) {
      return discoveredPort;
    }

    const spawnedPort = await this.resolveFromSpawn(instanceId, record);
    if (spawnedPort !== undefined) {
      return spawnedPort;
    }

    this.log(`Failed to resolve port for '${instanceId}'`);
    return undefined;
  }

  /** Returns true when normalized paths are equal or parent/child related. */
  public pathsMatch(path1: string, path2: string): boolean {
    const normalizedA = this.normalizePath(path1);
    const normalizedB = this.normalizePath(path2);

    if (normalizedA.length === 0 || normalizedB.length === 0) {
      return false;
    }

    if (normalizedA === normalizedB) {
      return true;
    }

    return (
      normalizedA.startsWith(`${normalizedB}/`) ||
      normalizedB.startsWith(`${normalizedA}/`)
    );
  }

  private async resolveFromDiscovery(
    instanceId: InstanceId,
    record: InstanceRecord | undefined,
  ): Promise<number | undefined> {
    try {
      this.log(`Tier 3: scanning running processes for '${instanceId}'`);
      const discovered = await this.discoveryService.discoverInstances();

      if (discovered.length === 0) {
        this.log("Tier 3: no discoverable instances found");
        return undefined;
      }

      const targetWorkspace = this.getTargetWorkspacePath(record);
      const matched = this.selectDiscoveredInstance(
        discovered,
        targetWorkspace,
      );

      if (!matched) {
        this.log("Tier 3: discovered instances do not match workspace");
        return undefined;
      }

      this.log(
        `Tier 3: matched discovered instance on port ${matched.port} (pid ${matched.pid})`,
      );

      if (!(await this.healthCheck(instanceId, matched.port))) {
        this.log(
          `Tier 3: matched discovered port ${matched.port} failed health check`,
        );
        return undefined;
      }

      this.syncRecordRuntime(instanceId, record, {
        pid: matched.pid,
        port: matched.port,
      });
      return matched.port;
    } catch (error) {
      this.log(
        `Tier 3 failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private async resolveFromSpawn(
    instanceId: InstanceId,
    record: InstanceRecord | undefined,
  ): Promise<number | undefined> {
    if (!this.controller) {
      this.log("Tier 4: InstanceController not provided; skipping auto-spawn");
      return undefined;
    }

    try {
      this.log(`Tier 4: spawning instance '${instanceId}'`);
      await this.controller.spawn(instanceId, {
        preferredPort: record?.config.preferredPort,
      });

      const updated = this.instanceStore.get(instanceId);
      const spawnedPort = this.getStoredPort(updated);
      if (spawnedPort === undefined) {
        this.log("Tier 4: spawn completed but no port was recorded");
        return undefined;
      }

      if (!(await this.healthCheck(instanceId, spawnedPort))) {
        this.log(`Tier 4: spawned port ${spawnedPort} failed health check`);
        return undefined;
      }

      this.log(`Tier 4: spawn succeeded on port ${spawnedPort}`);
      this.syncRecordRuntime(instanceId, updated, { port: spawnedPort });
      return spawnedPort;
    } catch (error) {
      this.log(
        `Tier 4 failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private async healthCheck(
    instanceId: InstanceId,
    port: number,
  ): Promise<boolean> {
    try {
      this.clientPool.delete(instanceId);
      const client = new OpenCodeApiClient(port);
      this.clientPool.set(instanceId, client);
      return await client.healthCheck();
    } catch (error) {
      this.log(
        `Health check failed on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private getStoredPort(
    record: InstanceRecord | undefined,
  ): number | undefined {
    return record?.runtime.port ?? record?.config.preferredPort;
  }

  private getTargetWorkspacePath(
    record: InstanceRecord | undefined,
  ): string | undefined {
    if (record?.config.workspaceUri) {
      try {
        const uri = vscode.Uri.parse(record.config.workspaceUri);
        return uri.fsPath;
      } catch {
        return record.config.workspaceUri;
      }
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private selectDiscoveredInstance(
    instances: OpenCodeInstance[],
    targetWorkspace: string | undefined,
  ): OpenCodeInstance | undefined {
    if (!targetWorkspace) {
      return instances[0];
    }

    return instances.find((instance) => {
      if (!instance.workspacePath) {
        return false;
      }

      return this.pathsMatch(instance.workspacePath, targetWorkspace);
    });
  }

  private syncRecordRuntime(
    instanceId: InstanceId,
    current: InstanceRecord | undefined,
    runtimePatch: Partial<InstanceRecord["runtime"]>,
  ): void {
    if (!current) {
      return;
    }

    this.instanceStore.upsert({
      ...current,
      runtime: {
        ...current.runtime,
        ...runtimePatch,
        lastSeenAt: Date.now(),
      },
      error: undefined,
      state: "connected",
      config: {
        ...current.config,
        preferredPort: runtimePatch.port ?? current.config.preferredPort,
      },
    });

    this.log(`Updated runtime info for '${instanceId}'`);
  }

  private normalizePath(pathValue: string): string {
    let normalized = pathValue.trim().replace(/\\/g, "/");

    while (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    if (process.platform === "win32" || process.platform === "darwin") {
      normalized = normalized.toLowerCase();
    }

    return normalized;
  }

  private log(message: string): void {
    this.outputChannel?.appendLine(`[ConnectionResolver] ${message}`);
  }
}
