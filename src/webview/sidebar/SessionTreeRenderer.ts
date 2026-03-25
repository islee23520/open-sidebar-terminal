import { SessionTreeState, TmuxSession } from "./types";

export class SessionTreeRenderer {
  private container: HTMLElement;
  private onSessionClick: (sessionId: string) => void;

  constructor(
    container: HTMLElement,
    onSessionClick: (sessionId: string) => void,
    _onGroupToggle: (groupName: string) => void,
  ) {
    this.container = container;
    this.onSessionClick = onSessionClick;
  }

  public render(state: SessionTreeState): void {
    this.container.innerHTML = "";

    if (state.emptyState) {
      this.renderEmptyState(state.emptyState);
      return;
    }

    if (state.sessions.length === 0) {
      this.renderEmptyState("no-sessions");
      return;
    }

    const tabList = document.createElement("div");
    tabList.className = "session-tab-list";

    for (const session of state.sessions) {
      const tab = this.renderSessionItem(
        session,
        session.id === state.activeSessionId,
      );
      tabList.appendChild(tab);
    }

    this.container.appendChild(tabList);
  }

  private renderEmptyState(emptyState: string): void {
    const el = document.createElement("div");
    el.className = "session-tab-empty-state";

    let message = "No sessions found.";
    if (emptyState === "no-workspace") {
      message = "No workspace open.";
    } else if (emptyState === "no-tmux") {
      message = "Tmux is not installed or running.";
    }

    el.textContent = message;
    this.container.appendChild(el);
  }

  private renderSessionItem(
    session: TmuxSession,
    isActive: boolean,
  ): HTMLElement {
    const itemEl = document.createElement("button");
    itemEl.type = "button";
    itemEl.className = `session-tab-item ${isActive ? "active" : ""}`;
    itemEl.textContent = session.name;
    itemEl.title = session.workspace || session.name;
    itemEl.onclick = () => this.onSessionClick(session.id);
    return itemEl;
  }
}
