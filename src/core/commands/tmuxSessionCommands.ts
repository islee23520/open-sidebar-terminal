import * as vscode from "vscode";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import type { InstanceController } from "../../services/InstanceController";
import type { InstanceQuickPick } from "../../services/InstanceQuickPick";
import type { InstanceStore } from "../../services/InstanceStore";
import type { OutputChannelService } from "../../services/OutputChannelService";
import type { TmuxSessionManager } from "../../services/TmuxSessionManager";
import type { ZellijSessionManager } from "../../services/ZellijSessionManager";
import type { TerminalBackendType } from "../../types";

export interface TmuxSessionCommandDependencies {
  provider: TerminalProvider | undefined;
  instanceStore: InstanceStore | undefined;
  instanceController: InstanceController | undefined;
  instanceQuickPick: InstanceQuickPick | undefined;
  outputChannel: OutputChannelService | undefined;
  tmuxManager: TmuxSessionManager | undefined;
  zellijManager?: ZellijSessionManager | undefined;
}

function getActiveBackend(
  instanceStore: InstanceStore | undefined,
): TerminalBackendType {
  try {
    return instanceStore?.getActive().runtime.terminalBackend ?? "tmux";
  } catch {
    return "tmux";
  }
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

        const newId = `${Date.now()}`;
        const newRecord = {
          config: {
            id: newId,
            workspaceUri,
            label: `OpenCode (${vscode.workspace.name || "Workspace"})`,
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

  const killTmuxSessionCommand = vscode.commands.registerCommand(
    "opencodeTui.killTmuxSession",
    async (sessionId?: string) => {
      if (!sessionId || !deps.provider) {
        return;
      }

      await deps.provider.killTmuxSession(sessionId);
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

  const browseTmuxSessionsCommand = vscode.commands.registerCommand(
    "opencodeTui.browseTmuxSessions",
    async () => {
      const activeBackend = getActiveBackend(deps.instanceStore);
      const sessionManager =
        activeBackend === "zellij" ? deps.zellijManager : deps.tmuxManager;
      const backendLabel = activeBackend === "zellij" ? "zellij" : "tmux";

      if (!sessionManager || !deps.provider) {
        vscode.window.showWarningMessage(
          `${backendLabel} is not available or the terminal provider is not initialized`,
        );
        return;
      }

      try {
        const sessions = await sessionManager.discoverSessions();
        if (sessions.length === 0) {
          vscode.window.showInformationMessage(`No ${backendLabel} sessions found`);
          return;
        }

        const activeSessionId =
          activeBackend === "zellij"
            ? deps.instanceStore?.getActive()?.runtime.zellijSessionId
            : deps.instanceStore?.getActive()?.runtime.tmuxSessionId;

        const items = sessions.map((session) => ({
          label: session.name,
          description: session.workspace,
          detail: session.isActive ? "attached" : undefined,
          session,
        }));

        items.sort((a, b) => {
          if (a.session.id === activeSessionId) return -1;
          if (b.session.id === activeSessionId) return 1;
          return a.label.localeCompare(b.label);
        });

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: activeSessionId
            ? `Current: ${activeSessionId} — select a session to switch`
            : `Select a ${backendLabel} session to attach`,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (!picked) {
          return;
        }

        if (picked.session.id === activeSessionId) {
          vscode.window.showInformationMessage(
            `Already attached to session "${picked.session.name}"`,
          );
          return;
        }

        if (activeBackend === "zellij") {
          await deps.provider.switchToZellijSession(picked.session.id);
        } else {
          await deps.provider.switchToTmuxSession(picked.session.id);
        }
        await vscode.commands.executeCommand("opencodeTui.focus");
      } catch (error) {
        deps.outputChannel?.error(
          `Failed to browse tmux sessions: ${error instanceof Error ? error.message : String(error)}`,
        );
        vscode.window.showErrorMessage(
          `Failed to browse tmux sessions: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  const killNativeShellCommand = vscode.commands.registerCommand(
    "opencodeTui.killNativeShell",
    async (instanceId?: string) => {
      if (!instanceId || !deps.instanceController || !deps.instanceStore) {
        return;
      }

      try {
        const wasActive =
          deps.instanceStore.getActive()?.config.id === instanceId;

        await deps.instanceController.kill(instanceId);
        deps.instanceStore.remove(instanceId);

        if (wasActive) {
          const remaining = deps.instanceStore.getAll();
          if (remaining.length > 0) {
            deps.instanceStore.setActive(remaining[0].config.id);
          }
        }
      } catch (error) {
        deps.outputChannel?.error(
          `[killNativeShell] Failed to kill native shell ${instanceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  return [
    openInNewWindowCommand,
    spawnForWorkspaceCommand,
    selectInstanceCommand,
    switchTmuxSessionCommand,
    createTmuxSessionCommand,
    killTmuxSessionCommand,
    killNativeShellCommand,
    switchNativeShellCommand,
    browseTmuxSessionsCommand,
  ];
}
