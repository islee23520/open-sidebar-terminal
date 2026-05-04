declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

import { h, render } from "preact";

import * as AiTool from "./ai-tool-selector";
import * as TmuxCmd from "./tmux-command-dropdown";
import { App } from "./dashboard/components/App";
import { DashboardPayload, HostMessage } from "./dashboard/types";

type AiToolConfig = AiTool.AiToolConfig;
type DashboardAction = Record<string, unknown>;
type DashboardHostMessage = HostMessage & Partial<DashboardPayload>;

const vscode = acquireVsCodeApi();

let lastPayload: DashboardPayload = {
  sessions: [],
  workspace: "",
  tmuxAvailable: true,
};
let aiTools: AiToolConfig[] = [];

const aiCallbacks = {
  postMessage: (message: unknown) => vscode.postMessage(message),
};
const pendingActionKeys = new Set<string>();

function getEventTarget(event: Event): Element | null {
  const target = event
    .composedPath()
    .find((value): value is Element => value instanceof Element);

  return target ?? null;
}

function getActionKey(action: DashboardAction): string {
  return Object.keys(action)
    .sort()
    .map((key) => `${key}:${String(action[key])}`)
    .join("|");
}

function postAction(action: DashboardAction): void {
  const actionKey = getActionKey(action);
  if (pendingActionKeys.has(actionKey)) {
    return;
  }

  pendingActionKeys.add(actionKey);
  queueMicrotask(() => {
    pendingActionKeys.delete(actionKey);
  });

  vscode.postMessage(action);
}

function handleAction(action: DashboardAction): void {
  postAction(action);
}

function updateTmuxOnlyVisibility(tmuxAvailable: boolean): void {
  const elements = document.querySelectorAll("[data-tmux-only]");
  Array.from(elements).forEach((el) => {
    if (el instanceof HTMLElement) {
      el.style.display = tmuxAvailable ? "" : "none";
    }
  });
}
function renderDashboard(): void {
  const workspace = document.getElementById("workspace");
  const toggleScope = document.getElementById("toggle-scope");
  const sessionList = document.getElementById("session-list");

  if (!workspace || !sessionList) {
    return;
  }

  workspace.textContent =
    "Workspace: " +
    (lastPayload.workspace || "-") +
    (lastPayload.showingAll ? " (all)" : "");

  if (toggleScope instanceof HTMLButtonElement) {
    if (lastPayload.showingAll) {
      toggleScope.classList.add("active-scope");
      toggleScope.textContent = "Workspace";
    } else {
      toggleScope.classList.remove("active-scope");
      toggleScope.textContent = "Global";
    }
  }

  render(null, sessionList);
  render(
    h(App, {
      payload: lastPayload,
      onAction: handleAction,
    }),
    sessionList,
  );

  const sessions = Array.isArray(lastPayload.sessions)
    ? lastPayload.sessions
    : [];
  const activeOther = sessions.find(
    (session) =>
      session.isActive && session.workspace !== lastPayload.workspace,
  );
  const banner = document.getElementById("return-banner");
  const returnWorkspace = document.getElementById("return-workspace");

  if (returnWorkspace) {
    returnWorkspace.textContent = lastPayload.workspace || "current workspace";
  }

  if (banner instanceof HTMLElement) {
    banner.style.display = activeOther ? "flex" : "none";
  }
}

window.addEventListener("message", (event) => {
  const message = event.data as DashboardHostMessage;

  if (message.type === "updateTmuxSessions") {
    if (Array.isArray(message.tools)) {
      aiTools = message.tools;
      AiTool.setTools(message.tools);
    }

    lastPayload = {
      sessions: Array.isArray(message.sessions) ? message.sessions : [],
      nativeShells: Array.isArray(message.nativeShells)
        ? message.nativeShells
        : undefined,
      workspace: message.workspace || "",
      windows: message.windows,
      showingAll: message.showingAll,
      tools: Array.isArray(message.tools) ? message.tools : undefined,
      tmuxAvailable: message.tmuxAvailable !== false,
    };
    updateTmuxOnlyVisibility(lastPayload.tmuxAvailable !== false);
    renderDashboard();
  }

  if (message.type === "showAiToolSelector") {
    const selectorMessage = message as DashboardHostMessage & {
      targetPaneId?: string;
    };
    AiTool.show(
      selectorMessage.sessionId || "",
      selectorMessage.sessionName || "",
      selectorMessage.defaultTool,
      Array.isArray(selectorMessage.tools) ? selectorMessage.tools : aiTools,
      selectorMessage.targetPaneId,
    );
  }
});

document.addEventListener("click", (event) => {
  const target = getEventTarget(event);
  if (!target) {
    return;
  }

  const sessions = Array.isArray(lastPayload.sessions)
    ? lastPayload.sessions
    : [];

  if (target.id === "return-btn" || target.closest("#return-btn")) {
    const matching = sessions.find(
      (session) => session.workspace === lastPayload.workspace,
    );

    if (matching) {
      postAction({ action: "activate", sessionId: matching.id });
    } else {
      postAction({ action: "create" });
    }

    return;
  }

  if (
    target.closest(".session-card") &&
    !target.closest('[data-action="killSession"]') &&
    !target.closest('[data-action="killNativeShell"]')
  ) {
    const card = target.closest(".session-card");

    if (card instanceof HTMLElement && card.dataset.sessionId) {
      postAction({ action: "activate", sessionId: card.dataset.sessionId });
    } else if (card instanceof HTMLElement && card.dataset.nativeShellId) {
      postAction({
        action: "activateNativeShell",
        instanceId: card.dataset.nativeShellId,
      });
    }

    return;
  }

  if (target.closest(".ai-tool-option")) {
    AiTool.handleClick(target, aiCallbacks);
    return;
  }

  if (target.id === "ai-selector" && !target.closest(".ai-selector-card")) {
    AiTool.hide();
    return;
  }

  if (target.closest('[data-action="killNativeShell"]')) {
    const button = target.closest('[data-action="killNativeShell"]');
    if (button instanceof HTMLButtonElement) {
      const instanceId = button.dataset.nativeShellId;
      if (instanceId) {
        postAction({ action: "killNativeShell", instanceId });
      }
    }

    return;
  }

  if (target.closest('[data-action="killSession"]')) {
    const button = target.closest('[data-action="killSession"]');
    if (button instanceof HTMLButtonElement) {
      const sessionId = button.dataset.sessionId;
      if (sessionId) {
        postAction({ action: "killSession", sessionId });
      }
    }

    return;
  }
  // Tmux command dropdown trigger
  if (target.closest("#tmux-command-trigger")) {
    if (TmuxCmd.isVisible()) {
      TmuxCmd.hide();
    } else {
      const sessions = Array.isArray(lastPayload.sessions)
        ? lastPayload.sessions
        : [];
      const activeSession = sessions.find((s) => s.isActive);
      const activeBackend = activeSession?.name.startsWith("Zellij: ")
        ? "zellij"
        : "tmux";
      TmuxCmd.show(activeSession?.id ?? null, activeBackend);
    }
    return;
  }

  // Tmux command dropdown item click
  if (
    target.closest(".tmux-cmd-item") &&
    !target.closest(".tmux-cmd-item.disabled")
  ) {
    TmuxCmd.handleClick(target);
    return;
  }

  // Tmux command dropdown click-outside close
  if (
    TmuxCmd.isVisible() &&
    !target.closest("#tmux-command-dropdown") &&
    !target.closest("#tmux-command-trigger")
  ) {
    TmuxCmd.hide();
    return;
  }

  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const action = target.dataset.action;
  if (
    action === "refresh" ||
    action === "create" ||
    action === "switchNativeShell" ||
    action === "createNativeShell" ||
    action === "toggleScope"
  ) {
    postAction({ action });
  }
});

document.addEventListener("keydown", (event) => {
  if (TmuxCmd.handleKeydown(event)) {
    return;
  }
  if (AiTool.handleKeydown(event, aiCallbacks)) {
    return;
  }
});

vscode.postMessage({ action: "refresh" });
