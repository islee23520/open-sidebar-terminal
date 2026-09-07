import type { HostMessage } from "../../types";

type SourceStateMessage = Extract<HostMessage, { type: "sourceState" }>;

export function createStatusBadge(container: HTMLElement): {
  update(message: SourceStateMessage): void;
} {
  let badgeElement: HTMLDivElement | undefined;
  return {
    update(message) {
      if (message.phase === "shell") {
        badgeElement?.remove();
        badgeElement = undefined;
        return;
      }
      if (!badgeElement) {
        badgeElement = document.createElement("div");
        badgeElement.className = "ulw-status-badge";
        badgeElement.setAttribute("role", "status");
        badgeElement.setAttribute("aria-live", "polite");
        container.appendChild(badgeElement);
      }
      if (message.phase === "error") {
        badgeElement.classList.add("error");
        badgeElement.textContent = message.message
          ? `Error: ${message.message}`
          : "Error attaching";
        return;
      }
      badgeElement.classList.remove("error");
      const phaseText = message.phase.charAt(0).toUpperCase() + message.phase.slice(1);
      badgeElement.textContent = message.label
        ? `${phaseText}: ${message.label}`
        : phaseText;
    },
  };
}
