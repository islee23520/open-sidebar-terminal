// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionTree } from "./SessionTree";
import { SessionTreeRenderer } from "./SessionTreeRenderer";
import { TreeSnapshot } from "./types";

describe("SessionTreeRenderer", () => {
  let container: HTMLElement;
  let tree: SessionTree;
  let renderer: SessionTreeRenderer;
  let onSessionClick: any;
  let onGroupToggle: any;

  beforeEach(() => {
    container = document.createElement("div");
    onSessionClick = vi.fn();
    onGroupToggle = vi.fn();
    tree = new SessionTree();
    renderer = new SessionTreeRenderer(
      container,
      onSessionClick,
      onGroupToggle,
    );

    tree.subscribe((state) => {
      renderer.render(state);
    });
  });

  it("renders empty state for no-workspace", () => {
    tree.updateFromSnapshot({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-workspace",
    });

    expect(container.innerHTML).toContain("No workspace open.");
  });

  it("renders empty state for no-tmux", () => {
    tree.updateFromSnapshot({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-tmux",
    });

    expect(container.innerHTML).toContain("Tmux is not installed or running.");
  });

  it("renders empty state for no-sessions", () => {
    tree.updateFromSnapshot({
      type: "treeSnapshot",
      sessions: [],
      activeSessionId: null,
      emptyState: "no-sessions",
    });

    expect(container.innerHTML).toContain("No sessions found.");
  });

  it("renders grouped sessions and active highlight", () => {
    const snapshot: TreeSnapshot = {
      type: "treeSnapshot",
      sessions: [
        { id: "1", name: "session1", workspace: "repo-a", isActive: false },
        { id: "2", name: "session2", workspace: "repo-a", isActive: true },
        { id: "3", name: "session3", workspace: "repo-b", isActive: false },
      ],
      activeSessionId: "2",
    };

    tree.updateFromSnapshot(snapshot);

    const tabs = container.querySelectorAll(".session-tab-item");
    expect(tabs.length).toBe(3);

    const activeItem = container.querySelector(".session-tab-item.active");
    expect(activeItem).not.toBeNull();
    expect(activeItem?.textContent).toBe("session2");
  });

  it("handles session click", () => {
    const snapshot: TreeSnapshot = {
      type: "treeSnapshot",
      sessions: [
        { id: "1", name: "session1", workspace: "repo-a", isActive: false },
      ],
      activeSessionId: null,
    };

    tree.updateFromSnapshot(snapshot);

    const item = container.querySelector(".session-tab-item") as HTMLElement;
    item.click();

    expect(onSessionClick).toHaveBeenCalledWith("1");
  });
});
