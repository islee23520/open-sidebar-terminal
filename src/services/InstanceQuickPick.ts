import * as vscode from "vscode";
import {
  InstanceId,
  InstanceRecord,
  InstanceState,
  InstanceStore,
} from "./InstanceStore";
import {
  InstanceDiscoveryService,
  OpenCodeInstance,
} from "./InstanceDiscoveryService";
import { InstanceController } from "./InstanceController";

interface InstanceQuickPickItem extends vscode.QuickPickItem {
  action:
    | { type: "select"; instanceId: InstanceId }
    | { type: "connect"; instanceId: InstanceId; port: number }
    | { type: "disconnect"; instanceId: InstanceId }
    | { type: "spawn" }
    | { type: "refresh" };
}

const STATE_ICONS: Record<InstanceState, string> = {
  connected: "$(circle-filled)",
  connecting: "$(loading~spin)",
  resolving: "$(loading~spin)",
  spawning: "$(loading~spin)",
  disconnected: "$(circle-outline)",
  error: "$(error)",
  stopping: "$(loading~spin)",
};

export class InstanceQuickPick {
  constructor(
    private readonly instanceStore: InstanceStore,
    private readonly discoveryService: InstanceDiscoveryService,
    private readonly controller?: InstanceController,
  ) {}

  public async show(): Promise<void> {
    const quickPick = vscode.window.createQuickPick<InstanceQuickPickItem>();
    quickPick.title = "OpenCode Tmux Sessions";
    quickPick.placeholder = "Select a tmux session to connect...";
    quickPick.busy = true;
    quickPick.show();

    try {
      const items = await this.buildItems();
      quickPick.items = items;
      quickPick.busy = false;
    } catch {
      quickPick.items = this.buildFallbackItems();
      quickPick.busy = false;
    }

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        quickPick.dispose();
        return;
      }

      quickPick.dispose();
      await this.handleAction(selected.action);
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
    });
  }

  private async buildItems(): Promise<InstanceQuickPickItem[]> {
    const items: InstanceQuickPickItem[] = [];

    const storeRecords = this.instanceStore.getAll();
    let activeId: InstanceId | undefined;
    try {
      activeId = this.instanceStore.getActive().config.id;
    } catch {}

    let discovered: OpenCodeInstance[] = [];
    try {
      discovered = await this.discoveryService.discoverInstances();
    } catch {}

    const knownPorts = new Set<number>();
    for (const record of storeRecords) {
      if (record.runtime.port) {
        knownPorts.add(record.runtime.port);
      }
    }

    for (const record of storeRecords) {
      const isActive = record.config.id === activeId;
      items.push(this.buildStoreItem(record, isActive));
    }

    for (const instance of discovered) {
      if (knownPorts.has(instance.port)) {
        continue;
      }

      items.push(this.buildDiscoveredItem(instance));
    }

    if (items.length > 0) {
      items.push({
        label: "",
        kind: vscode.QuickPickItemKind.Separator,
        action: { type: "refresh" },
      });
    }

    items.push({
      label: "$(add) Spawn New Tmux Session",
      description: "Start a new OpenCode tmux session for this workspace",
      action: { type: "spawn" },
    });

    items.push({
      label: "$(refresh) Refresh",
      description: "Re-scan for running instances",
      action: { type: "refresh" },
    });

    return items;
  }

  private buildStoreItem(
    record: InstanceRecord,
    isActive: boolean,
  ): InstanceQuickPickItem {
    const icon = STATE_ICONS[record.state] ?? "$(circle-outline)";
    const port = record.runtime.port ? `:${record.runtime.port}` : "";
    const label = record.config.label ?? record.config.id;
    const activeMarker = isActive ? " $(check)" : "";
    const session = record.health?.sessionTitle
      ? ` — ${record.health.sessionTitle}`
      : "";

    const isConnected = record.state === "connected";

    return {
      label: `${icon} ${label}${port}${activeMarker}`,
      description: `${record.state}${session}`,
      detail: record.health?.model
        ? `Model: ${record.health.model}`
        : undefined,
      action: isConnected
        ? { type: "select", instanceId: record.config.id }
        : record.runtime.port
          ? {
              type: "connect",
              instanceId: record.config.id,
              port: record.runtime.port,
            }
          : { type: "select", instanceId: record.config.id },
    };
  }

  private buildDiscoveredItem(
    instance: OpenCodeInstance,
  ): InstanceQuickPickItem {
    const instanceId = `discovered-${instance.port}`;

    return {
      label: `$(circle-large-outline) External :${instance.port}`,
      description: instance.workspacePath
        ? `PID ${instance.pid} — ${instance.workspacePath}`
        : `PID ${instance.pid}`,
      detail: "Discovered externally-running tmux session",
      action: {
        type: "connect",
        instanceId,
        port: instance.port,
      },
    };
  }

  private buildFallbackItems(): InstanceQuickPickItem[] {
    return [
      {
        label: "$(warning) Failed to discover instances",
        description: "Try spawning a new tmux session",
        action: { type: "spawn" },
      },
      {
        label: "$(refresh) Refresh",
        description: "Re-scan for running instances",
        action: { type: "refresh" },
      },
    ];
  }

  private async handleAction(
    action: InstanceQuickPickItem["action"],
  ): Promise<void> {
    switch (action.type) {
      case "select": {
        try {
          this.instanceStore.setActive(action.instanceId);
          vscode.window.showInformationMessage(
            `Switched to tmux session: ${action.instanceId}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to select tmux session: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }

      case "connect": {
        if (this.controller) {
          try {
            await this.controller.connect(action.instanceId, action.port);
            this.instanceStore.setActive(action.instanceId);
            vscode.window.showInformationMessage(
              `Connected to tmux session on port ${action.port}`,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          this.instanceStore.upsert({
            config: {
              id: action.instanceId,
              preferredPort: action.port,
            },
            runtime: {
              port: action.port,
            },
            state: "connected",
          });
          this.instanceStore.setActive(action.instanceId);
          vscode.window.showInformationMessage(
            `Connected to tmux session on port ${action.port}`,
          );
        }
        break;
      }

      case "disconnect": {
        if (this.controller) {
          try {
            await this.controller.disconnect(action.instanceId);
            vscode.window.showInformationMessage(
              "Disconnected from tmux session",
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to disconnect: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        break;
      }

      case "spawn": {
        vscode.commands.executeCommand("opencodeTui.start");
        break;
      }

      case "refresh": {
        await this.show();
        break;
      }
    }
  }
}
