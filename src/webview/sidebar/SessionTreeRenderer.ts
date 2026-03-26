import { SessionTreeState, TmuxSession } from "./types";

export class SessionTreeRenderer {
  private container: HTMLElement;
  private onSessionClick: (sessionId: string) => void;
  private onKillSession: (sessionId: string) => void;
  private onCreateSession: () => void;
  private onSwitchNativeShell: () => void;

  constructor(
    container: HTMLElement,
    onSessionClick: (sessionId: string) => void,
    onKillSession: (sessionId: string) => void,
    onCreateSession: () => void,
    onSwitchNativeShell: () => void,
    _onGroupToggle: (groupName: string) => void,
  ) {
    this.container = container;
    this.onSessionClick = onSessionClick;
    this.onKillSession = onKillSession;
    this.onCreateSession = onCreateSession;
    this.onSwitchNativeShell = onSwitchNativeShell;
  }

  public render(state: SessionTreeState): void {
    this.container.innerHTML = "";

    const actions = this.renderActionButtons();
    this.container.appendChild(actions);

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

  private renderActionButtons(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "session-tab-actions";

    const newSessionButton = document.createElement("button");
    newSessionButton.type = "button";
    newSessionButton.className = "session-tab-action";
    newSessionButton.textContent = "+ tmux";
    newSessionButton.onclick = () => this.onCreateSession();

    const nativeButton = document.createElement("button");
    nativeButton.type = "button";
    nativeButton.className = "session-tab-action";
    nativeButton.textContent = "native";
    nativeButton.onclick = () => this.onSwitchNativeShell();

    wrapper.appendChild(newSessionButton);
    wrapper.appendChild(nativeButton);
    return wrapper;
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
    const wrapper = document.createElement("div");
    wrapper.className = "session-tab-item-wrapper";

    const itemEl = document.createElement("button");
    itemEl.type = "button";
    itemEl.className = `session-tab-item ${isActive ? "active" : ""}`;
    itemEl.textContent = "tmux";
    itemEl.title = `${session.name} (${session.workspace || "unknown"})`;
    itemEl.onclick = () => this.onSessionClick(session.id);

    const killButton = document.createElement("button");
    killButton.type = "button";
    killButton.className = "session-tab-kill";
    killButton.textContent = "×";
    killButton.title = `Kill tmux session ${session.name}`;
    killButton.onclick = (event) => {
      event.stopPropagation();
      this.onKillSession(session.id);
    };

    wrapper.appendChild(itemEl);
    wrapper.appendChild(killButton);
    return wrapper;
  }
}
