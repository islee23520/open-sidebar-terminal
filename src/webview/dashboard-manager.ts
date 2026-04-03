// External script for Terminal Managers dashboard — VS Code webview CSP blocks inline scripts,
// so this must be loaded via <script src="..."> instead of embedded in HTML.

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();

import * as AiTool from "./ai-tool-selector";
type AiToolConfig = AiTool.AiToolConfig;

interface TmuxDashboardSessionDto {
  id: string;
  name: string;
  workspace: string;
  isActive: boolean;
  paneCount?: number;
}

interface TmuxDashboardPaneDto {
  paneId: string;
  index: number;
  title: string;
  isActive: boolean;
  currentCommand?: string;
  windowId?: string;
}

interface TmuxDashboardWindowDto {
  windowId: string;
  index: number;
  name: string;
  isActive: boolean;
  panes: TmuxDashboardPaneDto[];
}

interface DashboardPayload {
  sessions: TmuxDashboardSessionDto[];
  nativeShells?: NativeShellDto[];
  workspace: string;
  windows?: Record<string, TmuxDashboardWindowDto[]>;
  showingAll?: boolean;
  tools?: AiToolConfig[];
}

interface NativeShellDto {
  id: string;
  label?: string;
  state: string;
  isActive: boolean;
}

const expandedSessions = new Set<string>();
let lastPayload: DashboardPayload = { sessions: [], workspace: "" };

// Local reference to AI tools for badge detection in session cards
let aiTools: AiToolConfig[] = [];

// Callbacks for shared AI tool selector
const aiCallbacks = { postMessage: (msg: unknown) => vscode.postMessage(msg) };

function detectToolIcon(currentCommand: string | undefined): string {
  if (!currentCommand || aiTools.length === 0) return "";
  for (const t of aiTools) {
    const patterns = [t.name, t.name + ".exe"];
    if (t.path) {
      const basename = t.path
        .split("/")
        .pop()
        ?.split("\\")
        .pop()
        ?.replace(/\.exe$/i, "");
      if (basename && basename !== t.name) {
        patterns.push(basename);
      }
    }
    for (const p of patterns) {
      if (currentCommand.indexOf(p) !== -1) {
        return `<span class="pane-tool-badge ${escapeHtml(t.name)}">${escapeHtml(t.label.charAt(0))}</span>`;
      }
    }
  }
  return "";
}

function escapeHtml(value: string | number | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(payload: DashboardPayload): void {
  lastPayload = payload || { sessions: [], workspace: "" };

  const workspace = document.getElementById("workspace");
  const list = document.getElementById("session-list");
  const banner = document.getElementById("return-banner");
  const returnWorkspace = document.getElementById("return-workspace");
  if (!workspace || !list) {
    return;
  }

  workspace.textContent =
    "Workspace: " +
    (payload.workspace || "-") +
    (payload.showingAll ? " (all)" : "");

  const toggleBtn = document.getElementById("toggle-scope");
  if (toggleBtn) {
    if (payload.showingAll) {
      toggleBtn.classList.add("active-scope");
      toggleBtn.textContent = "Workspace";
    } else {
      toggleBtn.classList.remove("active-scope");
      toggleBtn.textContent = "Global";
    }
  }

  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const windows = payload.windows || {};
  const activeOther = sessions.find(
    (s) => s.isActive && s.workspace !== payload.workspace,
  );

  const nativeShells = Array.isArray(payload.nativeShells)
    ? payload.nativeShells
    : [];

  if (banner && returnWorkspace) {
    if (activeOther) {
      banner.style.display = "flex";
      returnWorkspace.textContent = payload.workspace || "current workspace";
    } else {
      banner.style.display = "none";
    }
  }

  if (sessions.length === 0 && nativeShells.length === 0) {
    list.innerHTML =
      '<div class="empty">No tmux sessions or native shells for this workspace.</div>';
    return;
  }

  const nativeShellCardsHtml = nativeShells
    .map((s) => {
      const activeClass = s.isActive ? " active" : "";
      const statusText = s.isActive ? "Current" : "Available";
      const stateLabel = s.state || "disconnected";
      return [
        `<div class="session-card${activeClass}" data-native-shell-id="${escapeHtml(s.id)}">`,
        '<div class="row">',
        "<div>",
        `<strong>${escapeHtml(s.label || "Shell")}</strong>`,
        `<div class="status">${statusText}</div>`,
        "</div>",
        `<button class="danger" data-action="killNativeShell" data-native-shell-id="${escapeHtml(s.id)}" title="Close Shell">✕</button>`,
        "</div>",
        '<div class="meta-grid">',
        `<div class="meta">native shell · ${escapeHtml(stateLabel)}</div>`,
        "</div>",
        "</div>",
      ].join("");
    })
    .join("");

  const tmuxCardsHtml = sessions
    .map((s) => {
      const activeClass = s.isActive ? " active" : "";
      const statusText = s.isActive ? "Current" : "Available";
      const isExpanded = expandedSessions.has(s.id);
      const sessionWindows = windows[s.id] || [];
      const windowCount = sessionWindows.length;
      const totalPaneCount = sessionWindows.reduce(
        (sum, w) => sum + w.panes.length,
        0,
      );

      const windowListHtml = isExpanded
        ? `<div class="window-list">${sessionWindows
            .map((w) => {
              const wActive = w.isActive ? " active" : "";
              const panesHtml = w.panes
                .map((p) => {
                  const pActive = p.isActive ? " active" : "";
                  return `<div class="pane-item${pActive}" data-session-id="${escapeHtml(s.id)}" data-pane-id="${escapeHtml(p.paneId)}" data-window-id="${escapeHtml(w.windowId)}"><span class="pane-name">${detectToolIcon(p.currentCommand)}${p.title || "Pane " + p.index}</span><button class="danger pane-kill-btn" data-action="killPane" data-session-id="${escapeHtml(s.id)}" data-pane-id="${escapeHtml(p.paneId)}" title="Kill Pane">✕</button></div>`;
                })
                .join("");

              return `<div class="window-card${wActive}" data-session-id="${escapeHtml(s.id)}" data-window-id="${escapeHtml(w.windowId)}"><div class="window-row"><button class="window-select-btn" data-action="selectWindow" data-session-id="${escapeHtml(s.id)}" data-window-id="${escapeHtml(w.windowId)}">${escapeHtml(w.name)}</button><span class="window-index">${w.index}</span><button class="danger pane-kill-btn" data-action="killWindow" data-session-id="${escapeHtml(s.id)}" data-window-id="${escapeHtml(w.windowId)}" title="Kill Window">✕</button></div><div class="pane-list">${panesHtml}</div></div>`;
            })
            .join("")}</div>`
        : "";

      return [
        `<div class="session-card${activeClass}" data-session-id="${escapeHtml(s.id)}">`,
        '<div class="row">',
        "<div>",
        `<strong>${escapeHtml(s.name)}</strong>`,
        `<div class="status">${statusText}</div>`,
        "</div>",
        `<button class="danger" data-action="killSession" data-session-id="${escapeHtml(s.id)}" title="Kill Session">✕</button>`,
        "</div>",
        '<div class="meta-grid">',
        `<div class="meta">tmux session: ${escapeHtml(s.id)}</div>`,
        `<div class="meta">workspace: ${escapeHtml(s.workspace)}</div>`,
        "</div>",
        `<div class="pane-header" data-session-id="${escapeHtml(s.id)}">`,
        `<span>${isExpanded ? "▼" : "▶"} ${windowCount} window${windowCount !== 1 ? "s" : ""}, ${totalPaneCount} pane${totalPaneCount !== 1 ? "s" : ""}</span>`,
        "<div>",
        `<button class="pane-split-btn" data-action="prevWindow" data-session-id="${escapeHtml(s.id)}" title="Previous Window">◀</button>`,
        `<button class="pane-split-btn" data-action="nextWindow" data-session-id="${escapeHtml(s.id)}" title="Next Window">▶</button>`,
        `<button class="pane-split-btn" data-action="createWindow" data-session-id="${escapeHtml(s.id)}" title="New Window">+Win</button>`,
        `<button class="pane-split-btn" data-action="splitH" data-session-id="${escapeHtml(s.id)}" title="Split Horizontal">↔</button>`,
        `<button class="pane-split-btn" data-action="splitV" data-session-id="${escapeHtml(s.id)}" title="Split Vertical">↕</button>`,
        "</div>",
        "</div>",
        windowListHtml,
        "</div>",
      ].join("");
    })
    .join("");

  list.innerHTML = nativeShellCardsHtml + tmuxCardsHtml;
}

// AI tool selector: click handling (delegates to shared module)
document.addEventListener("click", (event) => {
  const target = event
    .composedPath()
    .find((el): el is Element => el instanceof Element);
  if (!target) {
    return;
  }

  const sessions = Array.isArray(lastPayload.sessions)
    ? lastPayload.sessions
    : [];

  if (target.id === "return-btn" || target.closest("#return-btn")) {
    const matching = sessions.find(
      (s) => s.workspace === lastPayload.workspace,
    );
    if (matching) {
      vscode.postMessage({ action: "activate", sessionId: matching.id });
    } else {
      vscode.postMessage({ action: "create" });
    }
    return;
  }

  if (
    target.closest(".session-card") &&
    !target.closest(".pane-header") &&
    !target.closest('[data-action="killSession"]') &&
    !target.closest('[data-action="killNativeShell"]') &&
    !target.closest('[data-action="killWindow"]') &&
    !target.closest('[data-action="killPane"]') &&
    !target.closest('[data-action="selectWindow"]') &&
    !target.closest(".pane-split-btn") &&
    !target.closest(".pane-item") &&
    !target.closest(".window-card")
  ) {
    const card = target.closest(".session-card");
    if (card instanceof HTMLElement && card.dataset.sessionId) {
      vscode.postMessage({
        action: "activate",
        sessionId: card.dataset.sessionId,
      });
    } else if (card instanceof HTMLElement && card.dataset.nativeShellId) {
      vscode.postMessage({
        action: "activateNativeShell",
        instanceId: card.dataset.nativeShellId,
      });
    }
    return;
  }

  if (target.classList.contains("pane-split-btn")) {
    const button = target;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const sessionId = button.dataset.sessionId;
    if (button.dataset.action === "createWindow") {
      vscode.postMessage({ action: "createWindow", sessionId });
      return;
    }
    if (button.dataset.action === "nextWindow") {
      vscode.postMessage({ action: "nextWindow", sessionId });
      return;
    }
    if (button.dataset.action === "prevWindow") {
      vscode.postMessage({ action: "prevWindow", sessionId });
      return;
    }
    const direction = button.dataset.action === "splitH" ? "h" : "v";
    vscode.postMessage({ action: "splitPane", sessionId, direction });
    return;
  }

  const paneHeader = target.closest(".pane-header");
  if (paneHeader instanceof HTMLElement) {
    const sessionId = paneHeader.dataset.sessionId;
    if (sessionId) {
      if (expandedSessions.has(sessionId)) {
        expandedSessions.delete(sessionId);
      } else {
        expandedSessions.add(sessionId);
      }
      render(lastPayload);
    }
    return;
  }

  if (target.closest('[data-action="killWindow"]')) {
    const button = target.closest('[data-action="killWindow"]');
    if (button instanceof HTMLButtonElement) {
      const sessionId = button.dataset.sessionId;
      const windowId = button.dataset.windowId;
      if (sessionId && windowId) {
        vscode.postMessage({ action: "killWindow", sessionId, windowId });
      }
    }
    return;
  }

  if (target.closest('[data-action="killPane"]')) {
    const button = target.closest('[data-action="killPane"]');
    if (button instanceof HTMLButtonElement) {
      const sessionId = button.dataset.sessionId;
      const paneId = button.dataset.paneId;
      if (sessionId && paneId) {
        vscode.postMessage({ action: "killPane", sessionId, paneId });
      }
    }
    return;
  }

  if (
    target.closest(".pane-item") &&
    !target.closest('[data-action="killPane"]')
  ) {
    const item = target.closest(".pane-item");
    if (item instanceof HTMLElement) {
      vscode.postMessage({
        action: "switchPane",
        sessionId: item.dataset.sessionId,
        paneId: item.dataset.paneId,
        windowId: item.dataset.windowId,
      });
    }
    return;
  }

  if (
    target.closest(".window-card") &&
    !target.closest('[data-action="killWindow"]') &&
    !target.closest('[data-action="killPane"]') &&
    !target.closest('[data-action="selectWindow"]') &&
    !target.closest(".pane-item")
  ) {
    const card = target.closest(".window-card");
    if (card instanceof HTMLElement && card.dataset.windowId) {
      vscode.postMessage({
        action: "selectWindow",
        sessionId: card.dataset.sessionId,
        windowId: card.dataset.windowId,
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
        vscode.postMessage({ action: "killNativeShell", instanceId });
      }
    }
    return;
  }

  if (target.closest('[data-action="killSession"]')) {
    const button = target.closest('[data-action="killSession"]');
    if (button instanceof HTMLButtonElement) {
      const sessionId = button.dataset.sessionId;
      if (sessionId) {
        vscode.postMessage({ action: "killSession", sessionId });
      }
    }
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
    vscode.postMessage({ action });
    return;
  }

  if (action === "selectWindow") {
    const sessionId = target.dataset.sessionId;
    const windowId = target.dataset.windowId;
    if (sessionId && windowId) {
      vscode.postMessage({ action: "selectWindow", sessionId, windowId });
    }
    return;
  }

  const sessionId = target.dataset.sessionId;
  if (sessionId) {
    vscode.postMessage({ action: "activate", sessionId });
  }
});

interface HostMessage {
  type: string;
  sessions?: TmuxDashboardSessionDto[];
  workspace?: string;
  windows?: Record<string, TmuxDashboardWindowDto[]>;
  showingAll?: boolean;
  tools?: AiToolConfig[];
  sessionId?: string;
  sessionName?: string;
  defaultTool?: string;
}

window.addEventListener("message", (event) => {
  const message = event.data as HostMessage;
  if (message && message.type === "updateTmuxSessions") {
    if (message.tools && message.tools.length > 0) {
      aiTools = message.tools;
      AiTool.setTools(message.tools);
    }
    render(message as DashboardPayload);
  }
  if (message && message.type === "showAiToolSelector") {
    AiTool.show(
      message.sessionId!,
      message.sessionName!,
      message.defaultTool,
      message.tools,
    );
  }
});

document.addEventListener("keydown", (event) => {
  if (AiTool.handleKeydown(event, aiCallbacks)) {
    return;
  }
});

vscode.postMessage({ action: "refresh" });
