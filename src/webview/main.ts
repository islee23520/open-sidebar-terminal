import "@xterm/xterm/css/xterm.css";
import * as TmuxPrompt from "./tmux-prompt";
import * as AiSelector from "./ai-tool-selector";
import * as TmuxCmd from "./tmux-command-dropdown";
import { HostMessage } from "../types";
import type { TerminalBackendAvailability, TerminalBackendType } from "../types";
import {
  copySelectionToClipboard,
  handlePasteEventWithImageSupport,
} from "./clipboard";
import { postMessage } from "./shared/vscode-api";
import { initTerminal } from "./terminal";
import { createMessageHandler, type MessageHandlerCallbacks } from "./messages";
import {
  setupEditorAttachmentButton,
  setupReloadButton,
  setupTmuxCommandButton,
  setupBackendToggleButton,
  updateBackendToggleButtonState,
} from "./toolbar";

let currentSessionId: string | null = null;
let activeBackend: TerminalBackendType = "native";
let backendAvailability: TerminalBackendAvailability = {
  native: true,
  tmux: true,
  zellij: false,
};

function toggleTmuxCommandMenu(): void {
  if (!currentSessionId) {
    return;
  }

  if (TmuxCmd.isVisible()) {
    TmuxCmd.hide();
  } else {
    TmuxCmd.show(currentSessionId);
  }
}

function updateBackendOnlyElements(): void {
  const elements = document.querySelectorAll("[data-tmux-only]");
  Array.from(elements).forEach((el) => {
    if (el instanceof HTMLElement) {
      el.style.display = backendAvailability.tmux ? "" : "none";
    }
  });
  const zellijElements = document.querySelectorAll("[data-zellij-only]");
  Array.from(zellijElements).forEach((el) => {
    if (el instanceof HTMLElement) {
      el.style.display = backendAvailability.zellij ? "" : "none";
    }
  });
}

const callbacks: MessageHandlerCallbacks = {
  onActiveSession(message) {
    const toolbar = document.getElementById("tmux-toolbar");
    const label = document.getElementById("tmux-session-label");
    const toolbarControls = document.querySelector(".toolbar-controls");

    if (toolbar) toolbar.classList.remove("hidden");

    if ("sessionName" in message && message.sessionName) {
      currentSessionId = message.sessionId;
      activeBackend = message.backend ?? "tmux";
      if (label) {
        const windowSuffix =
          message.windowIndex !== undefined
            ? ` [${message.windowIndex}]${message.windowName ? ` ${message.windowName}` : ""}`
            : "";
        const backendPrefix = activeBackend === "zellij" ? "Zellij: " : "";
        label.textContent = backendPrefix + message.sessionName + windowSuffix;
      }
      if (toolbarControls) {
        if (activeBackend === "tmux") {
          toolbarControls.classList.remove("hidden");
        } else {
          toolbarControls.classList.add("hidden");
        }
      }
    } else {
      currentSessionId = null;
      activeBackend = "native";
      if (label) label.textContent = "Native Shell";
      if (toolbarControls) {
        toolbarControls.classList.add("hidden");
      }
    }

    updateBackendToggleButtonState(activeBackend, backendAvailability);
  },

  onToggleTmuxCommandToolbar() {
    toggleTmuxCommandMenu();
  },

  onShowAiToolSelector(message) {
    AiSelector.show(
      message.sessionId,
      message.sessionName,
      message.defaultTool,
      message.tools,
      message.targetPaneId,
    );
  },

  onShowTmuxPrompt(message) {
    backendAvailability.tmux = message.tmuxAvailable !== false;
    backendAvailability.zellij = message.zellijAvailable === true;
    TmuxPrompt.show(message.workspaceName, backendAvailability);
  },

  onPlatformInfo(message) {
    backendAvailability = message.backendAvailability ?? {
      native: true,
      tmux: message.tmuxAvailable !== false,
      zellij: message.zellijAvailable === true,
    };
    activeBackend = message.activeBackend ?? activeBackend;
    updateBackendOnlyElements();
    updateBackendToggleButtonState(activeBackend, backendAvailability);
  },
};

const messageHandler = createMessageHandler(callbacks);

function initApp(): void {
  const container = document.getElementById("terminal-container");
  if (!container) return;

  const instance = initTerminal(container, {
    onData: (data) => {
      postMessage({ type: "terminalInput", data });
    },
    onResize: (cols, rows) => {
      postMessage({ type: "terminalResize", cols, rows });
    },
    onToggleTmuxCommands: () => {
      toggleTmuxCommandMenu();
    },
  });

  if (instance) {
    messageHandler.terminal = instance.terminal;
    messageHandler.fitAddon = instance.fitAddon;
  }

  container.addEventListener(
    "paste",
    (event: ClipboardEvent) => {
      if (!handlePasteEventWithImageSupport(event)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );

  container.addEventListener(
    "copy",
    (event: ClipboardEvent) => {
      const selection = instance?.terminal.hasSelection()
        ? instance.terminal.getSelection()
        : "";
      if (!selection) {
        return;
      }

      event.preventDefault();
      copySelectionToClipboard(selection);
    },
    { capture: true },
  );

  setupReloadButton();
  setupEditorAttachmentButton();
  setupTmuxCommandButton(() => currentSessionId);
  setupBackendToggleButton(() => activeBackend);

  window.addEventListener("message", (event: MessageEvent) => {
    messageHandler.handleEvent(event as MessageEvent<HostMessage>);
  });

  setupAiToolSelectorEvents();
}
const aiCallbacks = {
  postMessage: (msg: unknown) => {
    const m = msg as Record<string, unknown>;
    if (m && m.action === "launchAiTool") {
      postMessage({
        type: "launchAiTool",
        sessionId: String(m.sessionId ?? ""),
        tool: String(m.tool ?? ""),
        savePreference: Boolean(m.savePreference),
        targetPaneId: m.targetPaneId ? String(m.targetPaneId) : undefined,
      });
    }
  },
};

const tmuxPromptCallbacks = {
  postMessage: (msg: unknown) => {
    const m = msg as Record<string, unknown>;
    if (m && m.type === "sendTmuxPromptChoice") {
      postMessage({
        type: "sendTmuxPromptChoice",
        choice: String(m.choice) as "tmux" | "shell" | "zellij",
      });
    }
  },
};

function setupAiToolSelectorEvents(): void {
  document.addEventListener("keydown", (event) => {
    // Cmd/Ctrl+Alt+M → toggle tmux command dropdown
    // VS Code keybindings don't fire when xterm has focus,
    // so we handle this directly in the webview.
    const isToggleTmuxCmd =
      event.altKey && (event.metaKey || event.ctrlKey) && event.code === "KeyM";
    if (isToggleTmuxCmd) {
      if (currentSessionId) {
        event.preventDefault();
        if (TmuxCmd.isVisible()) {
          TmuxCmd.hide();
        } else {
          TmuxCmd.show(currentSessionId);
        }
      }
      return;
    }

    if (TmuxCmd.isVisible()) {
      if (TmuxCmd.handleKeydown(event)) {
        return;
      }
    }
    if (AiSelector.isVisible()) {
      AiSelector.handleKeydown(event, aiCallbacks);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event
      .composedPath()
      .find((el): el is Element => el instanceof Element);
    if (!target) return;
    if (AiSelector.isVisible()) {
      AiSelector.handleClick(target, aiCallbacks);
    }

    if (TmuxPrompt.isVisible()) {
      TmuxPrompt.handleClick(target, tmuxPromptCallbacks);
    }

    if (TmuxCmd.isVisible()) {
      if (
        target.closest(".tmux-cmd-item") &&
        !target.closest(".tmux-cmd-item.disabled")
      ) {
        TmuxCmd.handleClick(target);
      } else if (
        !target.closest("#tmux-command-dropdown") &&
        !target.closest("#btn-tmux-commands")
      ) {
        TmuxCmd.hide();
      }
    }
  });
}

const boot = () => {
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => initApp());
  } else {
    initApp();
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
