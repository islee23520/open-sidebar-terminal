/**
 * Tmux Session Prompt logic for webviews.
 * Shows a modal when no tmux sessions exist, asking user to create one or use normal shell.
 */

export interface TmuxPromptCallbacks {
  postMessage: (message: unknown) => void;
}

let visible = false;

export function show(wsName: string): void {
  visible = true;

  const workspaceEl = document.getElementById("tmux-prompt-workspace");
  if (workspaceEl) {
    workspaceEl.textContent = `Workspace: ${wsName}`;
  }

  const backdrop = document.getElementById("tmux-prompt");
  if (backdrop) {
    backdrop.classList.remove("hidden");
    backdrop.style.display = "flex";
  }
}

export function hide(): void {
  visible = false;
  const backdrop = document.getElementById("tmux-prompt");
  if (backdrop) {
    backdrop.classList.add("hidden");
    backdrop.style.display = "none";
  }
}

export function isVisible(): boolean {
  return visible;
}

export function selectTmux(callbacks: TmuxPromptCallbacks): void {
  callbacks.postMessage({
    type: "sendTmuxPromptChoice",
    choice: "tmux",
  });
  hide();
}

export function selectShell(callbacks: TmuxPromptCallbacks): void {
  callbacks.postMessage({
    type: "sendTmuxPromptChoice",
    choice: "shell",
  });
  hide();
}

export function handleClick(
  target: Element,
  callbacks: TmuxPromptCallbacks,
): boolean {
  if (target.closest("#tmux-prompt-tmux")) {
    selectTmux(callbacks);
    return true;
  }

  if (target.closest("#tmux-prompt-shell")) {
    selectShell(callbacks);
    return true;
  }

  if (target.id === "tmux-prompt" && !target.closest(".ai-selector-card")) {
    return true;
  }

  return false;
}
