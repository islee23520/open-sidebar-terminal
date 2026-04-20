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

export function setupDashboardToggleButton(toggleDashboard: () => void): void {
  document.getElementById("btn-toggle-dashboard")?.addEventListener("click", () => {
    toggleDashboard();
  });
}
