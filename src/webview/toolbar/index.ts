import { postMessage } from "../shared/vscode-api";
import { TerminalBackendAvailability, TerminalBackendType } from "../../types";

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
  _getActiveBackend?: () => TerminalBackendType,
): void {
  const btn = document.getElementById("btn-toggle-backend");
  btn?.addEventListener("click", () => {
    postMessage({ type: "cycleTerminalBackend" });
  });
}

export function updateBackendToggleButtonState(
  activeBackend: TerminalBackendType,
  availability: TerminalBackendAvailability,
): void {
  const btn = document.getElementById(
    "btn-toggle-backend",
  ) as HTMLButtonElement | null;
  if (!btn) return;

  const next = nextAvailableBackend(activeBackend, availability);
  btn.disabled = next === activeBackend;
  btn.title = btn.disabled
    ? "No other terminal backend is available"
    : `Switch to ${backendLabel(next)}`;
  btn.textContent = backendGlyph(activeBackend);
}

function nextAvailableBackend(
  activeBackend: TerminalBackendType,
  availability: TerminalBackendAvailability,
): TerminalBackendType {
  const order: TerminalBackendType[] = ["native", "tmux", "zellij"];
  const start = order.indexOf(activeBackend);
  const offset = start >= 0 ? start : 0;
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(offset + step) % order.length];
    if (availability[candidate]) {
      return candidate;
    }
  }
  return activeBackend;
}

function backendLabel(backend: TerminalBackendType): string {
  if (backend === "tmux") return "Tmux";
  if (backend === "zellij") return "Zellij";
  return "Native Shell";
}

function backendGlyph(backend: TerminalBackendType): string {
  if (backend === "tmux") return "T";
  if (backend === "zellij") return "Z";
  return "N";
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
