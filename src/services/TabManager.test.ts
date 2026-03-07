import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabManager, TabManagerState } from "./TabManager";

describe("TabManager", () => {
  let manager: TabManager;

  beforeEach(() => {
    manager = new TabManager();
  });

  describe("CRUD", () => {
    it("creates tabs and keeps insertion order", () => {
      const first = manager.createTab("opencode", "OpenCode");
      const second = manager.createTab("claude", "Claude");

      const all = manager.getAllTabs();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe(first.id);
      expect(all[1].id).toBe(second.id);
      expect(all[1].state).toBe("active");
      expect(all[0].state).toBe("inactive");
    });

    it("removes tabs and activates next tab when active is removed", () => {
      const first = manager.createTab("opencode", "First");
      const second = manager.createTab("claude", "Second");
      const third = manager.createTab("codex", "Third");

      expect(manager.getActiveTab()?.id).toBe(third.id);
      expect(manager.removeTab(second.id)).toBe(true);
      expect(manager.getTab(second.id)).toBeNull();

      expect(manager.removeTab(third.id)).toBe(true);
      expect(manager.getActiveTab()?.id).toBe(first.id);
      expect(manager.removeTab("missing")).toBe(false);
    });

    it("updates tab fields and supports reorder", () => {
      const first = manager.createTab("opencode", "First");
      const second = manager.createTab("claude", "Second");
      const third = manager.createTab("codex", "Third");

      expect(
        manager.updateTab(second.id, { label: "Renamed", state: "error" }),
      ).toBe(true);
      expect(manager.getTab(second.id)?.label).toBe("Renamed");
      expect(manager.getTab(second.id)?.state).toBe("error");

      manager.reorderTabs([third.id, first.id]);
      expect(manager.getAllTabs().map((tab) => tab.id)).toEqual([
        third.id,
        first.id,
        second.id,
      ]);
    });
  });

  describe("active tab", () => {
    it("sets and retrieves active tab", () => {
      const first = manager.createTab("opencode", "First");
      const second = manager.createTab("claude", "Second");

      manager.setActiveTab(first.id);
      expect(manager.getActiveTab()?.id).toBe(first.id);
      expect(manager.getTab(first.id)?.state).toBe("active");
      expect(manager.getTab(second.id)?.state).toBe("inactive");
    });

    it("throws when setting active tab to unknown id", () => {
      expect(() => manager.setActiveTab("unknown")).toThrow(
        "Cannot set active tab: unknown id 'unknown'",
      );
    });
  });

  describe("queries", () => {
    it("filters tabs by tool", () => {
      manager.createTab("opencode", "O1");
      manager.createTab("claude", "C1");
      manager.createTab("opencode", "O2");

      const opencodeTabs = manager.getTabsByTool("opencode");
      expect(opencodeTabs).toHaveLength(2);
      expect(opencodeTabs.every((tab) => tab.toolId === "opencode")).toBe(true);
    });
  });

  describe("persistence", () => {
    it("serializes and deserializes state", () => {
      const first = manager.createTab("opencode", "First");
      manager.createTab("claude", "Second");
      manager.setActiveTab(first.id);

      const serialized = manager.serialize();

      const restored = new TabManager();
      restored.deserialize(serialized);

      expect(restored.getAllTabs()).toEqual(serialized.tabs);
      expect(restored.getActiveTab()?.id).toBe(serialized.activeTabId);
    });

    it("falls back to first tab when activeTabId is invalid", () => {
      const now = Date.now();
      const state: TabManagerState = {
        activeTabId: "missing",
        tabs: [
          {
            id: "t1",
            toolId: "opencode",
            instanceId: "i1",
            label: "T1",
            state: "inactive",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "t2",
            toolId: "claude",
            instanceId: "i2",
            label: "T2",
            state: "inactive",
            createdAt: now,
            updatedAt: now,
          },
        ],
      };

      manager.deserialize(state);
      expect(manager.getActiveTab()?.id).toBe("t1");
      expect(manager.getTab("t1")?.state).toBe("active");
      expect(manager.getTab("t2")?.state).toBe("inactive");
    });
  });

  describe("events", () => {
    it("emits add, remove, active, and change events", () => {
      const onAdd = vi.fn();
      const onRemove = vi.fn();
      const onActive = vi.fn();
      const onChange = vi.fn();

      manager.onDidAddTab(onAdd);
      manager.onDidRemoveTab(onRemove);
      manager.onDidChangeActive(onActive);
      manager.onDidChangeTabs(onChange);

      const first = manager.createTab("opencode", "First");
      const second = manager.createTab("claude", "Second");
      manager.setActiveTab(first.id);
      manager.removeTab(second.id);

      expect(onAdd).toHaveBeenCalledTimes(2);
      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(onRemove).toHaveBeenCalledWith(second.id);
      expect(onActive).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalled();
    });

    it("supports unsubscribing listeners", () => {
      const listener = vi.fn();
      const disposable = manager.onDidChangeTabs(listener);

      manager.createTab("opencode", "First");
      expect(listener).toHaveBeenCalledTimes(1);

      disposable.dispose();
      manager.createTab("claude", "Second");

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
