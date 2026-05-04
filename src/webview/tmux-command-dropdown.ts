import type { WebviewMessage } from "../types";
import type { TerminalBackendType } from "../types";
import { postMessage } from "./shared/vscode-api";
import { escapeHtml } from "./dashboard/utils";

type TmuxDropdownMessage = Extract<
  WebviewMessage,
  {
    type:
      | "executeTmuxCommand"
      | "executeTmuxRawCommand"
      | "requestAiToolSelector"
      | "zoomTmuxPane";
  }
>;

interface TmuxCommand {
  id: string;
  label: string;
  category: string;
  requiresSession: boolean;
  unsupportedBackends?: TerminalBackendType[];
  buildMessage: (activeSessionId: string | null) => TmuxDropdownMessage;
}

let visible = false;
let query = "";
let focusedIndex = 0;
let activeSessionId: string | null = null;
let activeBackend: TerminalBackendType = "tmux";

const commands: TmuxCommand[] = [
  {
    id: "browse-sessions",
    label: "Browse Sessions",
    category: "Session",
    requiresSession: false,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.browseTmuxSessions",
    }),
  },
  {
    id: "create-session",
    label: "New Session",
    category: "Session",
    requiresSession: false,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.createTmuxSession",
    }),
  },
  {
    id: "kill-session",
    label: "Kill Session",
    category: "Session",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxKillSession",
    }),
  },
  {
    id: "create-window",
    label: "New Window",
    category: "Window",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxCreateWindow",
    }),
  },
  {
    id: "next-window",
    label: "Next Window",
    category: "Window",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxNextWindow",
    }),
  },
  {
    id: "previous-window",
    label: "Previous Window",
    category: "Window",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxPrevWindow",
    }),
  },
  {
    id: "select-window",
    label: "Select Window",
    category: "Window",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxSelectWindow",
    }),
  },
  {
    id: "kill-window",
    label: "Kill Window",
    category: "Window",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxKillWindow",
    }),
  },
  {
    id: "select-ai-tool",
    label: "Select AI Tool",
    category: "Utility",
    requiresSession: false,
    unsupportedBackends: ["native"],
    buildMessage: () => ({
      type: "requestAiToolSelector",
    }),
  },
  {
    id: "switch-pane",
    label: "Switch Pane",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxSwitchPane",
    }),
  },
  {
    id: "split-pane-h",
    label: "Split Horizontal",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxSplitPaneH",
    }),
  },
  {
    id: "split-pane-v",
    label: "Split Vertical",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxSplitPaneV",
    }),
  },
  {
    id: "split-pane-command",
    label: "Split with Command",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxSplitPaneWithCommand",
    }),
  },
  {
    id: "send-text",
    label: "Send Text to Pane",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxSendTextToPane",
    }),
  },
  {
    id: "resize-pane",
    label: "Resize Pane",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxResizePane",
    }),
  },
  {
    id: "swap-pane",
    label: "Swap Pane",
    category: "Pane",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxSwapPane",
    }),
  },
  {
    id: "kill-pane",
    label: "Kill Pane",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxKillPane",
    }),
  },
  {
    id: "zoom-pane",
    label: "Zoom Pane",
    category: "Pane",
    requiresSession: true,
    buildMessage: () => ({
      type: "zoomTmuxPane",
    }),
  },
  {
    id: "refresh",
    label: "Refresh Terminal Manager",
    category: "Utility",
    requiresSession: false,
    buildMessage: () => ({
      type: "executeTmuxCommand",
      commandId: "opencodeTui.tmuxRefresh",
    }),
  },
  {
    id: "rename-session",
    label: "Rename Session",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "rename-session",
    }),
  },
  {
    id: "rename-window",
    label: "Rename Window",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "rename-window",
    }),
  },
  {
    id: "last-window",
    label: "Last Window",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "last-window",
    }),
  },
  {
    id: "last-pane",
    label: "Last Pane",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "last-pane",
    }),
  },
  {
    id: "rotate-window",
    label: "Rotate Window",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "rotate-window",
    }),
  },
  {
    id: "select-layout",
    label: "Select Layout",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "select-layout",
    }),
  },
  {
    id: "display-panes",
    label: "Display Panes",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "display-panes",
    }),
  },
  {
    id: "copy-mode",
    label: "Copy Mode",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "copy-mode",
    }),
  },
  {
    id: "clear-history",
    label: "Clear History",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "clear-history",
    }),
  },
  {
    id: "detach-client",
    label: "Detach Client",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "detach-client",
    }),
  },
  {
    id: "move-window",
    label: "Move Window",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "move-window",
    }),
  },
  {
    id: "move-pane",
    label: "Move Pane",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "move-pane",
    }),
  },
  {
    id: "respawn-pane",
    label: "Respawn Pane",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "respawn-pane",
    }),
  },
  {
    id: "choose-tree",
    label: "Choose Tree",
    category: "Native",
    requiresSession: true,
    unsupportedBackends: ["zellij"],
    buildMessage: () => ({
      type: "executeTmuxRawCommand",
      subcommand: "choose-tree",
    }),
  },
];

function getFilteredCommands(): TmuxCommand[] {
  const q = query.toLowerCase();
  return commands.filter((cmd) => {
    if (cmd.unsupportedBackends?.includes(activeBackend)) {
      return false;
    }
    return (
      getCommandLabel(cmd).toLowerCase().includes(q) ||
      getCommandCategory(cmd).toLowerCase().includes(q)
    );
  });
}

function getCommandLabel(cmd: TmuxCommand): string {
  return activeBackend === "zellij"
    ? cmd.label.replace(/Window/g, "Tab")
    : cmd.label;
}

function getCommandCategory(cmd: TmuxCommand): string {
  return activeBackend === "zellij" && cmd.category === "Window"
    ? "Tab"
    : cmd.category;
}

function renderList(): void {
  const listContainer = document.getElementById("tmux-command-list");
  if (!listContainer) return;

  const filtered = getFilteredCommands();

  if (filtered.length === 0) {
    listContainer.innerHTML = `<div class="tmux-cmd-item disabled"><span class="tmux-cmd-label">No commands found</span></div>`;
    return;
  }

  listContainer.innerHTML = filtered
    .map((cmd, idx) => {
      const isFocused = idx === focusedIndex;
      const isDisabled = cmd.requiresSession && !activeSessionId;
      const focusedClass = isFocused ? " focused" : "";
      const disabledClass = isDisabled ? " disabled" : "";

      return `<div class="tmux-cmd-item${focusedClass}${disabledClass}" data-cmd-index="${idx}">
      <span class="tmux-cmd-category">${escapeHtml(getCommandCategory(cmd))}</span>
      <span class="tmux-cmd-label">${escapeHtml(getCommandLabel(cmd))}</span>
    </div>`;
    })
    .join("");
}

export function show(
  sessionId: string | null,
  backend: TerminalBackendType = "tmux",
): void {
  activeSessionId = sessionId;
  activeBackend = backend;
  visible = true;
  query = "";
  focusedIndex = 0;

  const dropdown = document.getElementById("tmux-command-dropdown");
  if (dropdown) {
    dropdown.style.display = "flex";
  }

  const searchInput = document.getElementById(
    "tmux-cmd-search-input",
  ) as HTMLInputElement;
  if (searchInput) {
    searchInput.value = "";
    searchInput.focus();

    // Add input listener if not already added
    if (!searchInput.dataset.listenerAdded) {
      searchInput.addEventListener("input", (e) => {
        query = (e.target as HTMLInputElement).value;
        focusedIndex = 0;
        renderList();
      });
      searchInput.dataset.listenerAdded = "true";
    }
  }

  renderList();
}

export function hide(): void {
  visible = false;
  activeSessionId = null;

  const dropdown = document.getElementById("tmux-command-dropdown");
  if (dropdown) {
    dropdown.style.display = "none";
  }
}

export function isVisible(): boolean {
  return visible;
}

export function updateFocus(): void {
  const options = document.querySelectorAll(".tmux-cmd-item:not(.disabled)");
  options.forEach((el) => {
    const idx = parseInt((el as HTMLElement).dataset.cmdIndex || "-1", 10);
    if (idx === focusedIndex) {
      el.classList.add("focused");
      el.scrollIntoView({ block: "nearest" });
    } else {
      el.classList.remove("focused");
    }
  });
}

function selectCommand(index: number): void {
  const filtered = getFilteredCommands();
  const cmd = filtered[index];
  if (!cmd) return;

  if (cmd.requiresSession && !activeSessionId) return;

  postMessage(cmd.buildMessage(activeSessionId));
  hide();
}

export function handleKeydown(event: KeyboardEvent): boolean {
  if (!visible) {
    return false;
  }

  const filtered = getFilteredCommands();

  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (filtered.length > 0) {
      focusedIndex = (focusedIndex + 1) % filtered.length;
      updateFocus();
    }
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (filtered.length > 0) {
      focusedIndex = (focusedIndex - 1 + filtered.length) % filtered.length;
      updateFocus();
    }
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    selectCommand(focusedIndex);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hide();
    return true;
  }
  if (
    event.key === "/" &&
    document.activeElement?.id !== "tmux-cmd-search-input"
  ) {
    event.preventDefault();
    const searchInput = document.getElementById(
      "tmux-cmd-search-input",
    ) as HTMLInputElement;
    if (searchInput) {
      searchInput.focus();
    }
    return true;
  }

  return false;
}

export function handleClick(target: Element): boolean {
  if (!visible) return false;

  const item = target.closest(".tmux-cmd-item");
  if (item instanceof HTMLElement && item.dataset.cmdIndex) {
    const idx = parseInt(item.dataset.cmdIndex, 10);
    if (!isNaN(idx)) {
      selectCommand(idx);
    }
    return true;
  }

  return false;
}
