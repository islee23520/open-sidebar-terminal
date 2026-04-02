import * as vscode from "vscode";
import type {
  TmuxPane,
  TmuxSessionManager,
} from "../../services/TmuxSessionManager";

type PaneQuickPickItem = {
  label: string;
  description: string;
  paneId: string;
};

export interface TmuxPaneCommandDependencies {
  tmuxManager: TmuxSessionManager | undefined;
  resolveActiveTmuxSessionId: () => string | undefined;
}

function toPaneQuickPickItems(
  panes: TmuxPane[],
  includeActiveMarker: boolean = false,
): PaneQuickPickItem[] {
  return panes.map((pane) => ({
    label: `${includeActiveMarker && pane.isActive ? "$(check) " : ""}Pane ${pane.index}${pane.title ? `: ${pane.title}` : ""}`,
    description: pane.paneId,
    paneId: pane.paneId,
  }));
}

async function listTmuxPanes(
  tmuxManager: TmuxSessionManager,
  sessionId: string,
): Promise<TmuxPane[]> {
  return tmuxManager.listPanes(sessionId);
}

async function sendTextToTmuxPane(
  tmuxManager: TmuxSessionManager,
  paneId: string,
  text: string,
): Promise<void> {
  await tmuxManager.sendTextToPane(paneId, text);
}

async function pickPaneFromActiveSession(
  deps: TmuxPaneCommandDependencies,
  placeHolder: string,
  includeActiveMarker: boolean = false,
): Promise<PaneQuickPickItem | undefined> {
  const sessionId = deps.resolveActiveTmuxSessionId();
  if (!sessionId || !deps.tmuxManager) {
    return undefined;
  }
  const panes = await listTmuxPanes(deps.tmuxManager, sessionId);
  return vscode.window.showQuickPick<PaneQuickPickItem>(
    toPaneQuickPickItems(panes, includeActiveMarker),
    { placeHolder },
  );
}

async function promptResizeDirectionAndAmount(): Promise<
  | {
      dirFlag: "L" | "R" | "U" | "D";
      adjustment: number;
      directionLabel: string;
    }
  | undefined
> {
  const direction = await vscode.window.showQuickPick(
    ["Left", "Right", "Up", "Down"],
    { placeHolder: "Resize direction" },
  );
  if (!direction) {
    return undefined;
  }
  const dirFlag =
    direction === "Left"
      ? "L"
      : direction === "Right"
        ? "R"
        : direction === "Up"
          ? "U"
          : "D";
  const adjustment = await vscode.window.showInputBox({
    prompt: `Resize amount (cells) for ${direction.toLowerCase()}`,
    value: "5",
    validateInput: (v) =>
      /^\d+$/.test(v) ? undefined : "Must be a positive number",
  });
  if (!adjustment) {
    return undefined;
  }
  return {
    dirFlag,
    adjustment: Number(adjustment),
    directionLabel: direction,
  };
}

export function registerTmuxPaneCommands(
  deps: TmuxPaneCommandDependencies,
): vscode.Disposable[] {
  const tmuxSwitchPaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSwitchPane",
    async (item?: { paneId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      if (item?.paneId) {
        await deps.tmuxManager.selectPane(item.paneId);
        return;
      }
      const selected = await pickPaneFromActiveSession(
        deps,
        "Select pane to switch to",
        true,
      );
      if (selected) {
        await deps.tmuxManager.selectPane(selected.paneId);
      }
    },
  );

  const tmuxSplitPaneHCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSplitPaneH",
    async (item?: { paneId?: string; sessionId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      const sessionId = item?.sessionId ?? deps.resolveActiveTmuxSessionId();
      if (!sessionId) {
        return;
      }
      try {
        await deps.tmuxManager.splitPane(item?.paneId ?? sessionId, "h");
      } catch {
        vscode.window.showErrorMessage("Failed to split pane");
      }
    },
  );

  const tmuxSplitPaneVCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSplitPaneV",
    async (item?: { paneId?: string; sessionId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      const sessionId = item?.sessionId ?? deps.resolveActiveTmuxSessionId();
      if (!sessionId) {
        return;
      }
      try {
        await deps.tmuxManager.splitPane(item?.paneId ?? sessionId, "v");
      } catch {
        vscode.window.showErrorMessage("Failed to split pane");
      }
    },
  );

  const tmuxSplitPaneWithCommandCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSplitPaneWithCommand",
    async (item?: { paneId?: string; sessionId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      const sessionId = item?.sessionId ?? deps.resolveActiveTmuxSessionId();
      if (!sessionId) {
        return;
      }
      const command = await vscode.window.showInputBox({
        prompt: "Enter command to run in new pane",
        placeHolder: "e.g., htop, vim, npm run dev",
      });
      if (!command) {
        return;
      }
      try {
        await deps.tmuxManager.splitPane(item?.paneId ?? sessionId, "v", {
          command,
        });
      } catch {
        vscode.window.showErrorMessage("Failed to split pane");
      }
    },
  );

  const tmuxSendTextToPaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSendTextToPane",
    async (item?: { paneId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      if (item?.paneId) {
        const text = await vscode.window.showInputBox({
          prompt: "Enter text to send to pane",
        });
        if (text) {
          await sendTextToTmuxPane(deps.tmuxManager, item.paneId, text);
        }
        return;
      }

      const selected = await pickPaneFromActiveSession(deps, "Select pane");
      if (!selected) {
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: "Enter text to send",
      });
      if (text) {
        await sendTextToTmuxPane(deps.tmuxManager, selected.paneId, text);
      }
    },
  );

  const tmuxResizePaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxResizePane",
    async (item?: { paneId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      const paneId = item?.paneId;
      if (!paneId) {
        const selected = await pickPaneFromActiveSession(
          deps,
          "Select pane to resize",
        );
        if (!selected) {
          return;
        }
        const resize = await promptResizeDirectionAndAmount();
        if (!resize) {
          return;
        }
        await deps.tmuxManager.resizePane(
          selected.paneId,
          resize.dirFlag,
          resize.adjustment,
        );
        return;
      }

      const resize = await promptResizeDirectionAndAmount();
      if (!resize) {
        return;
      }
      try {
        await deps.tmuxManager.resizePane(
          paneId,
          resize.dirFlag,
          resize.adjustment,
        );
      } catch {
        vscode.window.showErrorMessage("Failed to resize pane");
      }
    },
  );

  const tmuxSwapPaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSwapPane",
    async (item?: { paneId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      const sessionId = deps.resolveActiveTmuxSessionId();
      if (!sessionId) {
        return;
      }
      const panes = await listTmuxPanes(deps.tmuxManager, sessionId);
      const sourcePaneId = item?.paneId;
      if (!sourcePaneId) {
        const selected = await vscode.window.showQuickPick<PaneQuickPickItem>(
          toPaneQuickPickItems(panes),
          { placeHolder: "Select source pane" },
        );
        if (!selected) {
          return;
        }
        const targets = panes.filter((p) => p.paneId !== selected.paneId);
        if (targets.length === 0) {
          return;
        }
        const target = await vscode.window.showQuickPick<PaneQuickPickItem>(
          toPaneQuickPickItems(targets),
          { placeHolder: "Swap with" },
        );
        if (!target) {
          return;
        }
        try {
          await deps.tmuxManager.swapPanes(selected.paneId, target.paneId);
        } catch {
          vscode.window.showErrorMessage("Failed to swap panes");
        }
        return;
      }
      const targets = panes.filter((p) => p.paneId !== sourcePaneId);
      if (targets.length === 0) {
        return;
      }
      const target = await vscode.window.showQuickPick<PaneQuickPickItem>(
        toPaneQuickPickItems(targets),
        { placeHolder: "Swap with" },
      );
      if (!target) {
        return;
      }
      try {
        await deps.tmuxManager.swapPanes(sourcePaneId, target.paneId);
      } catch {
        vscode.window.showErrorMessage("Failed to swap panes");
      }
    },
  );

  const tmuxKillPaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxKillPane",
    async (item?: { paneId: string }) => {
      if (!deps.tmuxManager) {
        return;
      }
      const sessionId = deps.resolveActiveTmuxSessionId();
      if (!sessionId) {
        return;
      }
      const panes = await listTmuxPanes(deps.tmuxManager, sessionId);
      const paneId = item?.paneId;
      if (!paneId) {
        if (panes.length <= 1) {
          vscode.window.showWarningMessage(
            "Cannot kill the last pane — use 'Kill Session' instead",
          );
          return;
        }
        const selected = await vscode.window.showQuickPick<PaneQuickPickItem>(
          toPaneQuickPickItems(panes),
          { placeHolder: "Select pane to kill" },
        );
        if (!selected) {
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Kill pane ${selected.paneId}?`,
          { modal: true },
          "Kill",
        );
        if (confirm !== "Kill") {
          return;
        }
        try {
          await deps.tmuxManager.killPane(selected.paneId);
        } catch {
          vscode.window.showErrorMessage("Failed to kill pane");
        }
        return;
      }
      if (panes.length <= 1) {
        vscode.window.showWarningMessage(
          "Cannot kill the last pane — use 'Kill Session' instead",
        );
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Kill pane ${paneId}?`,
        { modal: true },
        "Kill",
      );
      if (confirm !== "Kill") {
        return;
      }
      try {
        await deps.tmuxManager.killPane(paneId);
      } catch {
        vscode.window.showErrorMessage("Failed to kill pane");
      }
    },
  );

  const tmuxNextWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxNextWindow",
    async () => {
      if (!deps.tmuxManager) return;
      const sessionId = deps.resolveActiveTmuxSessionId();
      if (!sessionId) return;
      try {
        await deps.tmuxManager.nextWindow(sessionId);
      } catch {
        vscode.window.showErrorMessage("Failed to switch to next window");
      }
    },
  );

  const tmuxPrevWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxPrevWindow",
    async () => {
      if (!deps.tmuxManager) return;
      const sessionId = deps.resolveActiveTmuxSessionId();
      if (!sessionId) return;
      try {
        await deps.tmuxManager.prevWindow(sessionId);
      } catch {
        vscode.window.showErrorMessage("Failed to switch to previous window");
      }
    },
  );

  const tmuxCreateWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxCreateWindow",
    async () => {
      if (!deps.tmuxManager) return;
      const sessionId = deps.resolveActiveTmuxSessionId();
      if (!sessionId) return;
      try {
        await deps.tmuxManager.createWindow(sessionId);
      } catch {
        vscode.window.showErrorMessage("Failed to create window");
      }
    },
  );

  const tmuxKillWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxKillWindow",
    async (item?: { windowId: string }) => {
      if (!deps.tmuxManager) return;
      const sessionId = deps.resolveActiveTmuxSessionId();
      if (!sessionId) return;
      let windowId = item?.windowId;
      if (!windowId) {
        const windows = await deps.tmuxManager.listWindows(sessionId);
        const picked = await vscode.window.showQuickPick(
          windows.map((w) => ({
            label: `${w.isActive ? "$(check) " : ""}Window ${w.index}: ${w.name}`,
            description: w.windowId,
            windowId: w.windowId,
          })),
          { placeHolder: "Select window to kill" },
        );
        if (!picked) return;
        windowId = picked.windowId;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Kill window ${windowId}?`,
        { modal: true },
        "Kill",
      );
      if (confirm !== "Kill") return;
      try {
        await deps.tmuxManager.killWindow(windowId);
      } catch {
        vscode.window.showErrorMessage("Failed to kill window");
      }
    },
  );

  const tmuxSelectWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSelectWindow",
    async (item?: { windowId: string }) => {
      if (!deps.tmuxManager) return;
      const sessionId = deps.resolveActiveTmuxSessionId();
      if (!sessionId) return;
      let windowId = item?.windowId;
      if (!windowId) {
        const windows = await deps.tmuxManager.listWindows(sessionId);
        const picked = await vscode.window.showQuickPick(
          windows.map((w) => ({
            label: `${w.isActive ? "$(check) " : ""}Window ${w.index}: ${w.name}`,
            description: w.windowId,
            windowId: w.windowId,
          })),
          { placeHolder: "Select window to switch to" },
        );
        if (!picked) return;
        windowId = picked.windowId;
      }
      try {
        await deps.tmuxManager.selectWindow(windowId);
      } catch {
        vscode.window.showErrorMessage("Failed to select window");
      }
    },
  );

  const tmuxKillSessionCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxKillSession",
    async (item?: { sessionId: string }) => {
      if (!deps.tmuxManager) return;
      const sessionId = item?.sessionId ?? deps.resolveActiveTmuxSessionId();
      if (!sessionId) return;
      const confirm = await vscode.window.showWarningMessage(
        `Kill tmux session "${sessionId}"?`,
        { modal: true },
        "Kill",
      );
      if (confirm !== "Kill") return;
      try {
        await deps.tmuxManager.killSession(sessionId);
      } catch {
        vscode.window.showErrorMessage("Failed to kill session");
      }
    },
  );

  const tmuxRefreshCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxRefresh",
    async () => {
      await vscode.commands.executeCommand(
        "opencodeTui.terminalDashboard.focus",
      );
    },
  );

  return [
    tmuxSwitchPaneCommand,
    tmuxSplitPaneHCommand,
    tmuxSplitPaneVCommand,
    tmuxSplitPaneWithCommandCommand,
    tmuxSendTextToPaneCommand,
    tmuxResizePaneCommand,
    tmuxSwapPaneCommand,
    tmuxKillPaneCommand,
    tmuxNextWindowCommand,
    tmuxPrevWindowCommand,
    tmuxCreateWindowCommand,
    tmuxKillWindowCommand,
    tmuxSelectWindowCommand,
    tmuxKillSessionCommand,
    tmuxRefreshCommand,
  ];
}
