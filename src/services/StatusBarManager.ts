import * as vscode from "vscode";
import { InstanceStore, InstanceRecord } from "./InstanceStore";

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private instanceStore?: InstanceStore;
  private activeInstanceSubscription?: vscode.Disposable;
  private changeSubscription?: vscode.Disposable;

  /**
   * Creates a new StatusBarManager.
   * @param instanceStore - Optional InstanceStore for showing active instance status.
   *                       If not provided, shows static text.
   */
  constructor(instanceStore?: InstanceStore) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      1,
    );
    this.statusBarItem.tooltip = "Manage OpenCode tmux sessions";
    this.statusBarItem.command = "opencodeTui.selectInstance";
    this.instanceStore = instanceStore;

    if (this.instanceStore) {
      // Subscribe to instance changes
      this.activeInstanceSubscription = this.instanceStore.onDidSetActive(
        () => {
          this.updateStatus();
        },
      );
      // Also subscribe to general changes to update port/label info
      this.changeSubscription = this.instanceStore.onDidChange(() => {
        this.updateStatus();
      });
      // Initial update
      this.updateStatus();
    } else {
      // Fallback to static text when no store is provided
      this.statusBarItem.text = "$(terminal) OpenCode • tmux: idle";
    }
  }

  /**
   * Updates the status bar based on the active instance state.
   * Shows icon, port, and label information with appropriate colors.
   */
  private updateStatus(): void {
    if (!this.instanceStore) {
      return;
    }

    try {
      const active = this.instanceStore.getActive();
      this.updateStatusForInstance(active);
    } catch {
      // Store is empty or instance not found
      this.statusBarItem.text = "$(circle-outline) OpenCode • tmux: idle";
      this.statusBarItem.color = new vscode.ThemeColor(
        "statusBarItem.errorForeground",
      );
      this.statusBarItem.tooltip = "No active OpenCode tmux session";
    }
  }

  /**
   * Updates status bar display for a specific instance.
   * @param instance - The instance record to display.
   */
  private updateStatusForInstance(instance: InstanceRecord): void {
    const icon = this.resolveIcon(instance.state);
    const port = instance.runtime.port ? `:${instance.runtime.port}` : "";
    const label = instance.config.label ? ` [${instance.config.label}]` : "";
    const workspace = instance.config.workspaceUri
      ? `\nWorkspace: ${instance.config.workspaceUri}`
      : "";

    this.statusBarItem.text = `${icon} OpenCode • tmux: ${instance.state}${port}${label}`;
    this.statusBarItem.color = this.resolveColor(instance.state);
    this.statusBarItem.tooltip = `Active tmux session: ${instance.config.id}${workspace}`;
  }

  private resolveIcon(state: InstanceRecord["state"]): string {
    switch (state) {
      case "connected":
        return "$(circle-filled)";
      case "connecting":
      case "resolving":
      case "spawning":
      case "stopping":
        return "$(loading~spin)";
      case "error":
        return "$(error)";
      case "disconnected":
      default:
        return "$(circle-outline)";
    }
  }

  private resolveColor(
    state: InstanceRecord["state"],
  ): vscode.ThemeColor | undefined {
    switch (state) {
      case "connected":
        return undefined;
      case "connecting":
      case "resolving":
      case "spawning":
      case "stopping":
        return new vscode.ThemeColor("statusBarItem.warningForeground");
      case "error":
      case "disconnected":
      default:
        return new vscode.ThemeColor("statusBarItem.errorForeground");
    }
  }

  public show(): void {
    const config = vscode.workspace.getConfiguration("opencodeTui");
    const showStatusBar = config.get<boolean>("showStatusBar", true);

    if (showStatusBar) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  public hide(): void {
    this.statusBarItem.hide();
  }

  public dispose(): void {
    this.activeInstanceSubscription?.dispose();
    this.changeSubscription?.dispose();
    this.statusBarItem.dispose();
  }
}
