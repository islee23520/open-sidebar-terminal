import * as vscode from "vscode";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import type { InstanceController } from "../../services/InstanceController";
import type { InstanceQuickPick } from "../../services/InstanceQuickPick";
import type { InstanceStore } from "../../services/InstanceStore";
import type { OutputChannelService } from "../../services/OutputChannelService";

export interface TmuxSessionCommandDependencies {
  provider: TerminalProvider | undefined;
  instanceStore: InstanceStore | undefined;
  instanceController: InstanceController | undefined;
  instanceQuickPick: InstanceQuickPick | undefined;
  outputChannel: OutputChannelService | undefined;
}

export function registerTmuxSessionCommands(
  deps: TmuxSessionCommandDependencies,
): vscode.Disposable[] {
  const openInNewWindowCommand = vscode.commands.registerCommand(
    "opencode.openInNewWindow",
    async () => {
      if (!deps.instanceStore) {
        vscode.window.showErrorMessage("Instance store is not initialized");
        return;
      }

      try {
        const active = deps.instanceStore.getActive();
        const newId = `${Date.now()}`;
        const newRecord = {
          config: {
            id: newId,
            workspaceUri: active.config.workspaceUri,
            label: `${active.config.label || "OpenCode"} (New Window)`,
          },
          runtime: {},
          state: "disconnected" as const,
        };

        deps.instanceStore.upsert(newRecord);

        if (newRecord.config.workspaceUri) {
          vscode.commands.executeCommand(
            "vscode.openFolder",
            vscode.Uri.parse(newRecord.config.workspaceUri),
            true,
          );
        }
        vscode.window.showInformationMessage(
          `Opened in new window: ${newRecord.config.label}`,
        );
      } catch (error) {
        deps.outputChannel?.error(
          `Failed to open in new window: ${error instanceof Error ? error.message : String(error)}`,
        );
        vscode.window.showErrorMessage(
          `Failed to open in new window: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  const spawnForWorkspaceCommand = vscode.commands.registerCommand(
    "opencode.spawnForWorkspace",
    async (uri?: vscode.Uri) => {
      if (!deps.instanceStore) {
        vscode.window.showErrorMessage("Instance store is not initialized");
        return;
      }

      try {
        const workspaceUri =
          uri?.toString() ||
          vscode.workspace.workspaceFolders?.[0]?.uri.toString();
        if (!workspaceUri) {
          vscode.window.showWarningMessage("No workspace folder available");
          return;
        }

        const existingWorkspaceRecord = deps.instanceStore
          .getAll()
          .find((record) => record.config.workspaceUri === workspaceUri);

        const reusableStates = new Set<string>([
          "connected",
          "connecting",
          "spawning",
          "resolving",
        ]);

        if (
          existingWorkspaceRecord &&
          reusableStates.has(existingWorkspaceRecord.state)
        ) {
          deps.instanceStore.setActive(existingWorkspaceRecord.config.id);
          await vscode.commands.executeCommand("opencodeTui.focus");
          vscode.window.showInformationMessage(
            `Focused existing OpenCode for workspace: ${existingWorkspaceRecord.config.label || existingWorkspaceRecord.config.id}`,
          );
          return;
        }

        if (existingWorkspaceRecord) {
          deps.instanceStore.setActive(existingWorkspaceRecord.config.id);
          await deps.instanceController?.spawn(
            existingWorkspaceRecord.config.id,
          );
          vscode.window.showInformationMessage(
            `Spawned OpenCode for workspace: ${existingWorkspaceRecord.config.label || existingWorkspaceRecord.config.id}`,
          );
          return;
        }

        const config = vscode.workspace.getConfiguration("opencodeTui");
        const configuredCommand = config.get<string>("command", "opencode -c");

        const newId = `${Date.now()}`;
        const newRecord = {
          config: {
            id: newId,
            workspaceUri,
            label: `OpenCode (${vscode.workspace.name || "Workspace"})`,
            command: configuredCommand,
          },
          runtime: {},
          state: "disconnected" as const,
        };

        deps.instanceStore.upsert(newRecord);

        await deps.instanceController?.spawn(newId);
        vscode.window.showInformationMessage(
          `Spawned OpenCode for workspace: ${newRecord.config.label}`,
        );
      } catch (error) {
        deps.outputChannel?.error(
          `Failed to spawn for workspace: ${error instanceof Error ? error.message : String(error)}`,
        );
        vscode.window.showErrorMessage(
          `Failed to spawn for workspace: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  const selectInstanceCommand = vscode.commands.registerCommand(
    "opencodeTui.selectInstance",
    () => {
      deps.instanceQuickPick?.show();
    },
  );

  const switchTmuxSessionCommand = vscode.commands.registerCommand(
    "opencodeTui.switchTmuxSession",
    async (sessionId?: string) => {
      if (!sessionId || !deps.provider) {
        return;
      }

      await deps.provider.switchToTmuxSession(sessionId);
      await vscode.commands.executeCommand("opencodeTui.focus");
    },
  );

  const createTmuxSessionCommand = vscode.commands.registerCommand(
    "opencodeTui.createTmuxSession",
    async () => {
      if (!deps.provider) {
        return;
      }

      return deps.provider.createTmuxSession();
    },
  );

  const switchNativeShellCommand = vscode.commands.registerCommand(
    "opencodeTui.switchNativeShell",
    async () => {
      if (!deps.provider) {
        return;
      }

      await deps.provider.switchToNativeShell();
    },
  );

  const openTerminalManagerCommand = vscode.commands.registerCommand(
    "opencodeTui.openTerminalManager",
    () => {
      vscode.commands.executeCommand(
        "workbench.view.focus",
        "opencodeTui.terminalManager",
      );
    },
  );

  return [
    openInNewWindowCommand,
    spawnForWorkspaceCommand,
    selectInstanceCommand,
    switchTmuxSessionCommand,
    createTmuxSessionCommand,
    switchNativeShellCommand,
    openTerminalManagerCommand,
  ];
}
