import { postMessage } from "../shared/vscode-api";

import * as TmuxCmd from "../tmux-command-dropdown";

export function setupTmuxCommandButton(
  getSessionId: () => string | null,
): void {
  const btnTmuxCommands = document.getElementById("btn-tmux-commands");
  btnTmuxCommands?.addEventListener("click", () => {
    TmuxCmd.isVisible() ? TmuxCmd.hide() : TmuxCmd.show(getSessionId());
  });
}

export function setupBackendToggleButton(
  getIsTmuxMode: () => boolean,
): void {
  const btn = document.getElementById("btn-toggle-backend");
  btn?.addEventListener("click", () => {
    const isTmux = getIsTmuxMode();
    postMessage({
      type: "sendTmuxPromptChoice",
      choice: isTmux ? "shell" : "tmux",
    });
  });
}

export function updateBackendToggleButtonState(
  isTmuxMode: boolean,
  tmuxAvailable: boolean,
): void {
  const btn = document.getElementById(
    "btn-toggle-backend",
  ) as HTMLButtonElement | null;
  if (!btn) return;

  if (isTmuxMode) {
    btn.title = "Switch to Native Shell";
    btn.disabled = false;
  } else {
    btn.title = "Switch to Tmux";
    if (!tmuxAvailable) {
      btn.disabled = true;
      btn.title = "Tmux is not available";
    } else {
      btn.disabled = false;
    }
  }
}

export function setupReloadButton(): void {
  document.getElementById("btn-restart")?.addEventListener("click", () => {
    postMessage({ type: "requestRestart" });
  });
}

export function setupEditorAttachmentButton(): void {
  document
    .getElementById("btn-toggle-editor-attachment")
    ?.addEventListener("click", () => {
      postMessage({ type: "toggleEditorAttachment" });
    });
}
