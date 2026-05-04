import * as vscode from "vscode";
import type {
  TmuxPane,
  TmuxSessionManager,
} from "../../services/TmuxSessionManager";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import type { InstanceStore } from "../../services/InstanceStore";
import type {
  ZellijPane,
  ZellijSessionManager,
  ZellijTab,
} from "../../services/ZellijSessionManager";
import type { TerminalBackendType } from "../../types";

type PaneQuickPickItem = {
  label: string;
  description: string;
  paneId: string;
};

export interface TmuxPaneCommandDependencies {
  tmuxManager: TmuxSessionManager | undefined;
  zellijManager?: ZellijSessionManager | undefined;
  instanceStore: InstanceStore | undefined;
  resolveActiveTmuxSessionId: () => string | undefined;
  resolveActiveTmuxFocus: () => Promise<
    { sessionId: string; windowId: string; paneId: string } | undefined
  >;
  resolveWorkspacePath: () => string | undefined;
  provider: TerminalProvider | undefined;
}

type BackendPaneManager =
  | { kind: "tmux"; manager: TmuxSessionManager }
  | { kind: "zellij"; manager: ZellijSessionManager };

type WindowQuickPickItem = {
  label: string;
  description: string;
  windowId: string;
};

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

function toTmuxPaneFromZellijPane(pane: ZellijPane, index: number): TmuxPane {
  return {
    paneId: pane.id,
    index,
    title: pane.title,
    isActive: pane.isFocused,
  };
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

function getActiveZellijSessionId(
  instanceStore: InstanceStore | undefined,
): string | undefined {
  try {
    return instanceStore?.getActive().runtime.zellijSessionId;
  } catch {
    return undefined;
  }
}

function getPaneManager(
  deps: TmuxPaneCommandDependencies,
): BackendPaneManager | undefined {
  const backend = getActiveBackend(deps.instanceStore);
  if (backend === "tmux") {
    return deps.tmuxManager ? { kind: "tmux", manager: deps.tmuxManager } : undefined;
  }
  if (backend === "zellij") {
    return deps.zellijManager
      ? { kind: "zellij", manager: deps.zellijManager }
      : undefined;
  }
  return undefined;
}

async function listTmuxPanes(
  paneManager: BackendPaneManager,
  sessionId: string,
): Promise<TmuxPane[]> {
  if (paneManager.kind === "tmux") {
    return paneManager.manager.listPanes(sessionId);
  }
  const panes = await paneManager.manager.listPanes();
  return panes.map(toTmuxPaneFromZellijPane);
}

async function sendTextToTmuxPane(
  paneManager: BackendPaneManager,
  paneId: string,
  text: string,
): Promise<void> {
  if (paneManager.kind === "tmux") {
    await paneManager.manager.sendTextToPane(paneId, text);
    return;
  }
  await paneManager.manager.selectPane(paneId);
  await paneManager.manager.sendTextToPane(text);
}

async function pickPaneFromSession(
  deps: TmuxPaneCommandDependencies,
  sessionId: string,
  placeHolder: string,
  includeActiveMarker: boolean = false,
): Promise<PaneQuickPickItem | undefined> {
  const paneManager = getPaneManager(deps);
  if (!paneManager) {
    return undefined;
  }
  const panes = await listTmuxPanes(paneManager, sessionId);
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
  function resolvePaneManager(): BackendPaneManager | undefined {
    return getPaneManager(deps);
  }

  async function splitPane(
    targetPaneId: string,
    direction: "h" | "v",
    options?: { command?: string; workingDirectory?: string },
  ): Promise<void> {
    const paneManager = resolvePaneManager();
    if (!paneManager) return;
    if (paneManager.kind === "tmux") {
      await paneManager.manager.splitPane(targetPaneId, direction, options);
      return;
    }
    await paneManager.manager.selectPane(targetPaneId);
    await paneManager.manager.splitPane(direction, options);
  }

  async function resizePane(
    paneId: string,
    dirFlag: "L" | "R" | "U" | "D",
    adjustment: number,
  ): Promise<void> {
    const paneManager = resolvePaneManager();
    if (!paneManager) return;
    if (paneManager.kind === "tmux") {
      await paneManager.manager.resizePane(paneId, dirFlag, adjustment);
      return;
    }
    const direction =
      dirFlag === "L"
        ? "left"
        : dirFlag === "R"
          ? "right"
          : dirFlag === "U"
            ? "up"
            : "down";
    await paneManager.manager.selectPane(paneId);
    await paneManager.manager.resizePane(direction, adjustment);
  }

  async function listWindows(sessionId: string): Promise<WindowQuickPickItem[]> {
    const paneManager = resolvePaneManager();
    if (!paneManager) return [];
    if (paneManager.kind === "tmux") {
      const windows = await paneManager.manager.listWindows(sessionId);
      return windows.map((w) => ({
        label: `${w.isActive ? "$(check) " : ""}Window ${w.index}: ${w.name}`,
        description: w.windowId,
        windowId: w.windowId,
      }));
    }
    const tabs = await paneManager.manager.listTabs();
    return tabs.map((tab: ZellijTab) => ({
      label: `${tab.isActive ? "$(check) " : ""}Tab ${tab.index}: ${tab.name}`,
      description: String(tab.index),
      windowId: String(tab.index),
    }));
  }

  async function selectWindow(windowId: string): Promise<void> {
    const paneManager = resolvePaneManager();
    if (!paneManager) return;
    if (paneManager.kind === "tmux") {
      await paneManager.manager.selectWindow(windowId);
      return;
    }
    await paneManager.manager.selectTab(Number(windowId));
  }

  async function killWindow(windowId: string): Promise<void> {
    const paneManager = resolvePaneManager();
    if (!paneManager) return;
    if (paneManager.kind === "tmux") {
      await paneManager.manager.killWindow(windowId);
      return;
    }
    await paneManager.manager.selectTab(Number(windowId));
    await paneManager.manager.killTab();
  }

  const tmuxSwitchPaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSwitchPane",
    async (item?: { paneId: string }) => {
      const paneManager = resolvePaneManager();
      if (!paneManager) {
        return;
      }
      if (item?.paneId) {
        await paneManager.manager.selectPane(item.paneId);
        return;
      }
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) return;
      const selected = await pickPaneFromSession(
        deps,
        sessionId,
        "Select pane to switch to",
        true,
      );
      if (selected) {
        await paneManager.manager.selectPane(selected.paneId);
      }
    },
  );

  async function resolveFocusedContext(): Promise<
    { sessionId: string; paneId: string } | undefined
  > {
    const paneManager = resolvePaneManager();
    if (paneManager?.kind === "zellij") {
      const sessionId = getActiveZellijSessionId(deps.instanceStore);
      if (!sessionId) return undefined;
      try {
        const panes = await listTmuxPanes(paneManager, sessionId);
        const active = panes.find((p) => p.isActive) ?? panes[0];
        if (!active) return undefined;
        return { sessionId, paneId: active.paneId };
      } catch {
        return undefined;
      }
    }
    const focus = await deps.resolveActiveTmuxFocus();
    if (focus) {
      return { sessionId: focus.sessionId, paneId: focus.paneId };
    }
    const sessionId = deps.resolveActiveTmuxSessionId();
    if (!sessionId || !paneManager) return undefined;
    try {
      const panes = await listTmuxPanes(paneManager, sessionId);
      const active = panes.find((p) => p.isActive) ?? panes[0];
      if (!active) return undefined;
      return { sessionId, paneId: active.paneId };
    } catch {
      return undefined;
    }
  }

  async function resolveFocusedSessionId(): Promise<string | undefined> {
    if (getActiveBackend(deps.instanceStore) === "zellij") {
      return getActiveZellijSessionId(deps.instanceStore);
    }
    const focus = await deps.resolveActiveTmuxFocus();
    return focus?.sessionId ?? deps.resolveActiveTmuxSessionId();
  }

  const tmuxSplitPaneHCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSplitPaneH",
    async (item?: { paneId?: string; sessionId: string }) => {
      if (!resolvePaneManager()) {
        return;
      }
      let targetPaneId = item?.paneId;
      if (!targetPaneId) {
        const focused = await resolveFocusedContext();
        if (!focused) return;
        targetPaneId = focused.paneId;
      }
      try {
        const cwd = deps.resolveWorkspacePath();
        await splitPane(targetPaneId, "h", {
          workingDirectory: cwd,
        });
      } catch {
        vscode.window.showErrorMessage("Failed to split pane");
      }
    },
  );

  const tmuxSplitPaneVCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSplitPaneV",
    async (item?: { paneId?: string; sessionId: string }) => {
      if (!resolvePaneManager()) {
        return;
      }
      let targetPaneId = item?.paneId;
      if (!targetPaneId) {
        const focused = await resolveFocusedContext();
        if (!focused) return;
        targetPaneId = focused.paneId;
      }
      try {
        const cwd = deps.resolveWorkspacePath();
        await splitPane(targetPaneId, "v", {
          workingDirectory: cwd,
        });
      } catch {
        vscode.window.showErrorMessage("Failed to split pane");
      }
    },
  );

  const tmuxSplitPaneWithCommandCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSplitPaneWithCommand",
    async (item?: { paneId?: string; sessionId: string }) => {
      if (!resolvePaneManager()) {
        return;
      }
      const command = await vscode.window.showInputBox({
        prompt: "Enter command to run in new pane",
        placeHolder: "e.g., htop, vim, npm run dev",
      });
      if (!command) {
        return;
      }
      let targetPaneId = item?.paneId;
      if (!targetPaneId) {
        const focused = await resolveFocusedContext();
        if (!focused) return;
        targetPaneId = focused.paneId;
      }
      try {
        await splitPane(targetPaneId, "v", {
          command,
          workingDirectory: deps.resolveWorkspacePath(),
        });
      } catch {
        vscode.window.showErrorMessage("Failed to split pane");
      }
    },
  );

  const tmuxSendTextToPaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSendTextToPane",
    async (item?: { paneId: string }) => {
      const paneManager = resolvePaneManager();
      if (!paneManager) {
        return;
      }
      if (item?.paneId) {
        const text = await vscode.window.showInputBox({
          prompt: "Enter text to send to pane",
        });
        if (text) {
          await sendTextToTmuxPane(paneManager, item.paneId, text);
        }
        return;
      }

      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) return;
      const selected = await pickPaneFromSession(deps, sessionId, "Select pane");
      if (!selected) {
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: "Enter text to send",
      });
      if (text) {
        await sendTextToTmuxPane(paneManager, selected.paneId, text);
      }
    },
  );

  const tmuxResizePaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxResizePane",
    async (item?: { paneId: string }) => {
      if (!resolvePaneManager()) {
        return;
      }
      const paneId = item?.paneId;
      if (!paneId) {
        const sessionId = await resolveFocusedSessionId();
        if (!sessionId) return;
        const selected = await pickPaneFromSession(
          deps,
          sessionId,
          "Select pane to resize",
        );
        if (!selected) {
          return;
        }
        const resize = await promptResizeDirectionAndAmount();
        if (!resize) {
          return;
        }
        await resizePane(
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
        await resizePane(
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
      const paneManager = resolvePaneManager();
      if (!paneManager) {
        return;
      }
      if (paneManager.kind === "zellij") {
        vscode.window.showInformationMessage("Swap pane is not supported for zellij");
        return;
      }
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) {
        return;
      }
      const panes = await listTmuxPanes(paneManager, sessionId);
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
          await paneManager.manager.swapPanes(selected.paneId, target.paneId);
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
        await paneManager.manager.swapPanes(sourcePaneId, target.paneId);
      } catch {
        vscode.window.showErrorMessage("Failed to swap panes");
      }
    },
  );

  const tmuxKillPaneCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxKillPane",
    async (item?: { paneId: string }) => {
      const paneManager = resolvePaneManager();
      if (!paneManager) {
        return;
      }
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) {
        return;
      }
      const panes = await listTmuxPanes(paneManager, sessionId);
      const paneId = item?.paneId;
      const killPane = async (targetPaneId: string) => {
        if (paneManager.kind === "tmux") {
          await paneManager.manager.killPane(targetPaneId);
          return;
        }
        await paneManager.manager.selectPane(targetPaneId);
        await paneManager.manager.killPane();
      };
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
          await killPane(selected.paneId);
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
        await killPane(paneId);
      } catch {
        vscode.window.showErrorMessage("Failed to kill pane");
      }
    },
  );

  const tmuxNextWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxNextWindow",
    async () => {
      const paneManager = resolvePaneManager();
      if (!paneManager) return;
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) return;
      try {
        if (paneManager.kind === "tmux") {
          await paneManager.manager.nextWindow(sessionId);
        } else {
          await paneManager.manager.nextTab();
        }
      } catch {
        vscode.window.showErrorMessage("Failed to switch to next window");
      }
    },
  );

  const tmuxPrevWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxPrevWindow",
    async () => {
      const paneManager = resolvePaneManager();
      if (!paneManager) return;
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) return;
      try {
        if (paneManager.kind === "tmux") {
          await paneManager.manager.prevWindow(sessionId);
        } else {
          await paneManager.manager.prevTab();
        }
      } catch {
        vscode.window.showErrorMessage("Failed to switch to previous window");
      }
    },
  );

  const tmuxCreateWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxCreateWindow",
    async () => {
      const paneManager = resolvePaneManager();
      if (!paneManager) return;
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) return;
      try {
        if (paneManager.kind === "tmux") {
          await paneManager.manager.createWindow(
            sessionId,
            deps.resolveWorkspacePath(),
          );
        } else {
          await paneManager.manager.createTab({
            workingDirectory: deps.resolveWorkspacePath(),
          });
        }
      } catch {
        vscode.window.showErrorMessage("Failed to create window");
      }
    },
  );

  const tmuxKillWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxKillWindow",
    async (item?: { windowId: string }) => {
      if (!resolvePaneManager()) return;
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) return;
      let windowId = item?.windowId;
      if (!windowId) {
        const windows = await listWindows(sessionId);
        const picked = await vscode.window.showQuickPick(
          windows,
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
        await killWindow(windowId);
      } catch {
        vscode.window.showErrorMessage("Failed to kill window");
      }
    },
  );

  const tmuxSelectWindowCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxSelectWindow",
    async (item?: { windowId: string }) => {
      if (!resolvePaneManager()) return;
      const sessionId = await resolveFocusedSessionId();
      if (!sessionId) return;
      let windowId = item?.windowId;
      if (!windowId) {
        const windows = await listWindows(sessionId);
        const picked = await vscode.window.showQuickPick(
          windows,
          { placeHolder: "Select window to switch to" },
        );
        if (!picked) return;
        windowId = picked.windowId;
      }
      try {
        await selectWindow(windowId);
      } catch {
        vscode.window.showErrorMessage("Failed to select window");
      }
    },
  );

  const tmuxKillSessionCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxKillSession",
    async (item?: { sessionId: string }) => {
      const paneManager = resolvePaneManager();
      if (!paneManager) return;
      const sessionId = item?.sessionId ?? (await resolveFocusedSessionId());
      if (!sessionId) return;
      const confirm = await vscode.window.showWarningMessage(
        `Kill ${paneManager.kind} session "${sessionId}"?`,
        { modal: true },
        "Kill",
      );
      if (confirm !== "Kill") return;
      try {
        await paneManager.manager.killSession(sessionId);
      } catch {
        vscode.window.showErrorMessage("Failed to kill session");
      }
    },
  );

  const tmuxRefreshCommand = vscode.commands.registerCommand(
    "opencodeTui.tmuxRefresh",
    async () => {
      await vscode.commands.executeCommand("opencodeTui.openTerminalManager");
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
