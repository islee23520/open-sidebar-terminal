import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstanceStore, InstanceRecord, InstanceId } from "./InstanceStore";

describe("InstanceStore", () => {
  let store: InstanceStore;

  beforeEach(() => {
    store = new InstanceStore();
  });

  describe("persistence round-trip", () => {
    it("should persist and retrieve instance records", () => {
      const record: InstanceRecord = {
        config: { id: "test-1", label: "Test Instance" },
        runtime: { port: 4096 },
        state: "connected",
      };

      store.upsert(record);
      const retrieved = store.get("test-1");

      expect(retrieved).toBeDefined();
      expect(retrieved?.config.id).toBe("test-1");
      expect(retrieved?.config.label).toBe("Test Instance");
      expect(retrieved?.runtime.port).toBe(4096);
      expect(retrieved?.state).toBe("connected");
    });

    it("should update existing record on upsert", () => {
      const initialRecord: InstanceRecord = {
        config: { id: "test-1", label: "Initial" },
        runtime: { port: 4096 },
        state: "disconnected",
      };

      const updatedRecord: InstanceRecord = {
        config: { id: "test-1", label: "Updated" },
        runtime: { port: 5000 },
        state: "connected",
      };

      store.upsert(initialRecord);
      store.upsert(updatedRecord);

      const retrieved = store.get("test-1");
      expect(retrieved?.config.label).toBe("Updated");
      expect(retrieved?.runtime.port).toBe(5000);
      expect(retrieved?.state).toBe("connected");
    });

    it("should return undefined for non-existent id", () => {
      const result = store.get("non-existent");
      expect(result).toBeUndefined();
    });

    it("should persist all record fields including optional ones", () => {
      const record: InstanceRecord = {
        config: {
          id: "test-1",
          label: "Full Test",
          workspaceUri: "/path/to/workspace",
          command: "opencode",
          args: ["--debug"],
          preferredPort: 8080,
          enableHttpApi: true,
        },
        runtime: {
          port: 8080,
          pid: 12345,
          terminalKey: "term-123",
          lastSeenAt: Date.now(),
        },
        state: "connected",
        health: {
          ok: true,
          baseUrl: "http://localhost:8080",
          sessionTitle: "Test Session",
          model: "test-model",
          messageCount: 42,
          version: "1.0.0",
        },
        error: undefined,
      };

      store.upsert(record);
      const retrieved = store.get("test-1");

      expect(retrieved).toBeDefined();
      expect(retrieved?.config.workspaceUri).toBe("/path/to/workspace");
      expect(retrieved?.config.command).toBe("opencode");
      expect(retrieved?.config.args).toEqual(["--debug"]);
      expect(retrieved?.runtime.pid).toBe(12345);
      expect(retrieved?.health?.ok).toBe(true);
      expect(retrieved?.health?.messageCount).toBe(42);
    });

    it("should return defensive copies (not mutate internal state)", () => {
      const record: InstanceRecord = {
        config: { id: "test-1", label: "Original" },
        runtime: { port: 4096 },
        state: "connected",
      };

      store.upsert(record);
      const retrieved1 = store.get("test-1");
      const retrieved2 = store.get("test-1");

      // Mutate retrieved copy
      if (retrieved1) {
        retrieved1.config.label = "Mutated";
        retrieved1.runtime.port = 9999;
      }

      // Should not affect subsequent retrievals
      expect(retrieved2?.config.label).toBe("Original");
      expect(retrieved2?.runtime.port).toBe(4096);
      expect(store.get("test-1")?.config.label).toBe("Original");
    });
  });

  describe("active selection", () => {
    it("should track active instance", () => {
      const record1: InstanceRecord = {
        config: { id: "instance-1" },
        runtime: {},
        state: "disconnected",
      };
      const record2: InstanceRecord = {
        config: { id: "instance-2" },
        runtime: {},
        state: "disconnected",
      };

      store.upsert(record1);
      store.upsert(record2);

      // First upsert becomes active
      expect(store.getActive().config.id).toBe("instance-1");

      // Can change active
      store.setActive("instance-2");
      expect(store.getActive().config.id).toBe("instance-2");
    });

    it("should throw when getting active from empty store", () => {
      expect(() => store.getActive()).toThrow(
        "Cannot get active instance from an empty store",
      );
    });

    it("should throw when setting active to non-existent id", () => {
      store.upsert({
        config: { id: "test-1" },
        runtime: {},
        state: "disconnected",
      });

      expect(() => store.setActive("non-existent")).toThrow(
        "Cannot set active instance: unknown id 'non-existent'",
      );
    });

    it("should not emit event when setting active to current active", () => {
      store.upsert({
        config: { id: "test-1" },
        runtime: {},
        state: "disconnected",
      });

      const setActiveListener = vi.fn();
      store.onDidSetActive(setActiveListener);

      // Should not emit
      store.setActive("test-1");
      expect(setActiveListener).not.toHaveBeenCalled();
    });

    it("should set first upserted record as active", () => {
      const record: InstanceRecord = {
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      };

      store.upsert(record);
      expect(store.getActive().config.id).toBe("first");
    });

    it("should maintain active when other records are added", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      expect(store.getActive().config.id).toBe("first");
    });
  });

  describe("empty-store bootstrap", () => {
    it("should auto-create default instance as active on first upsert", () => {
      const record: InstanceRecord = {
        config: { id: "default" },
        runtime: {},
        state: "disconnected",
      };

      store.upsert(record);

      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].config.id).toBe("default");
      expect(store.getActive().config.id).toBe("default");
    });

    it("should handle multiple instances after first upsert", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "third" },
        runtime: {},
        state: "disconnected",
      });

      const all = store.getAll();
      expect(all).toHaveLength(3);
      expect(store.getActive().config.id).toBe("first");
    });
  });

  describe("getAll", () => {
    it("should return empty array for empty store", () => {
      expect(store.getAll()).toEqual([]);
    });

    it("should return all records in insertion order", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "third" },
        runtime: {},
        state: "disconnected",
      });

      const all = store.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].config.id).toBe("first");
      expect(all[1].config.id).toBe("second");
      expect(all[2].config.id).toBe("third");
    });

    it("should return defensive copies", () => {
      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "connected",
      });

      const all1 = store.getAll();
      all1[0].state = "error";

      const all2 = store.getAll();
      expect(all2[0].state).toBe("connected");
    });
  });

  describe("remove", () => {
    it("should remove instance by id", () => {
      store.upsert({
        config: { id: "test-1" },
        runtime: {},
        state: "disconnected",
      });

      const removed = store.remove("test-1");

      expect(removed).toBe(true);
      expect(store.get("test-1")).toBeUndefined();
      expect(store.getAll()).toHaveLength(0);
    });

    it("should return false when removing non-existent id", () => {
      const removed = store.remove("non-existent");
      expect(removed).toBe(false);
    });

    it("should update active when removing active instance", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      // First is active
      expect(store.getActive().config.id).toBe("first");

      // Remove active
      store.remove("first");

      // Second becomes active
      expect(store.getActive().config.id).toBe("second");
    });

    it("should throw when getting active after removing all instances", () => {
      store.upsert({
        config: { id: "test-1" },
        runtime: {},
        state: "disconnected",
      });

      store.remove("test-1");

      expect(() => store.getActive()).toThrow(
        "Cannot get active instance from an empty store",
      );
    });

    it("should not change active when removing non-active instance", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      store.remove("second");

      expect(store.getActive().config.id).toBe("first");
    });
  });

  describe("events - onDidChange", () => {
    it("should emit onDidChange when records change via upsert", () => {
      const listener = vi.fn();
      store.onDidChange(listener);

      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            config: expect.objectContaining({ id: "test" }),
          }),
        ]),
      );
    });

    it("should emit onDidChange when records are updated", () => {
      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidChange(listener);

      store.upsert({
        config: { id: "test" },
        runtime: { port: 5000 },
        state: "connected",
      });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should emit onDidChange when records are removed", () => {
      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidChange(listener);

      store.remove("test");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith([]);
    });

    it("should emit onDidChange when active is set", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidChange(listener);

      store.setActive("second");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should support multiple listeners", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      store.onDidChange(listener1);
      store.onDidChange(listener2);

      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it("should allow unsubscribing via disposable", () => {
      const listener = vi.fn();
      const disposable = store.onDidChange(listener);

      store.upsert({
        config: { id: "test-1" },
        runtime: {},
        state: "disconnected",
      });

      expect(listener).toHaveBeenCalledTimes(1);

      disposable.dispose();

      store.upsert({
        config: { id: "test-2" },
        runtime: {},
        state: "disconnected",
      });

      // Should not be called after dispose
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("events - onDidSetActive", () => {
    it("should emit onDidSetActive when active changes", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidSetActive(listener);

      store.setActive("second");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("second");
    });

    it("should emit onDidSetActive on first upsert", () => {
      const listener = vi.fn();
      store.onDidSetActive(listener);

      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("first");
    });

    it("should emit onDidSetActive when active is removed", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidSetActive(listener);

      store.remove("first");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("second");
    });

    it("should not emit when setting active to current active", () => {
      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidSetActive(listener);

      store.setActive("test");

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("events - onDidAdd", () => {
    it("should emit onDidAdd when new instance is added", () => {
      const listener = vi.fn();
      store.onDidAdd(listener);

      const record: InstanceRecord = {
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      };

      store.upsert(record);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ id: "test" }),
        }),
      );
    });

    it("should not emit onDidAdd when updating existing instance", () => {
      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidAdd(listener);

      store.upsert({
        config: { id: "test" },
        runtime: { port: 5000 },
        state: "connected",
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("should emit for each unique instance added", () => {
      const listener = vi.fn();
      store.onDidAdd(listener);

      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "third" },
        runtime: {},
        state: "disconnected",
      });

      expect(listener).toHaveBeenCalledTimes(3);
    });
  });

  describe("events - onDidRemove", () => {
    it("should emit onDidRemove when instance is removed", () => {
      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidRemove(listener);

      store.remove("test");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("test");
    });

    it("should not emit when removing non-existent instance", () => {
      const listener = vi.fn();
      store.onDidRemove(listener);

      store.remove("non-existent");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should emit for each removed instance", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      const listener = vi.fn();
      store.onDidRemove(listener);

      store.remove("first");
      store.remove("second");

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenNthCalledWith(1, "first");
      expect(listener).toHaveBeenNthCalledWith(2, "second");
    });
  });

  describe("event ordering", () => {
    it("should emit events in correct order on upsert (add)", () => {
      const events: string[] = [];

      store.onDidAdd(() => events.push("add"));
      store.onDidSetActive(() => events.push("setActive"));
      store.onDidChange(() => events.push("change"));

      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      expect(events).toEqual(["setActive", "add", "change"]);
    });

    it("should emit events in correct order on upsert (update)", () => {
      store.upsert({
        config: { id: "test" },
        runtime: {},
        state: "disconnected",
      });

      const events: string[] = [];

      store.onDidAdd(() => events.push("add"));
      store.onDidSetActive(() => events.push("setActive"));
      store.onDidChange(() => events.push("change"));

      store.upsert({
        config: { id: "test" },
        runtime: { port: 5000 },
        state: "connected",
      });

      // Only change should fire for updates
      expect(events).toEqual(["change"]);
    });

    it("should emit events in correct order on remove", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      const events: string[] = [];

      store.onDidRemove(() => events.push("remove"));
      store.onDidSetActive(() => events.push("setActive"));
      store.onDidChange(() => events.push("change"));

      store.remove("first");

      expect(events).toEqual(["remove", "setActive", "change"]);
    });

    it("should emit events in correct order on setActive", () => {
      store.upsert({
        config: { id: "first" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "second" },
        runtime: {},
        state: "disconnected",
      });

      const events: string[] = [];

      store.onDidSetActive(() => events.push("setActive"));
      store.onDidChange(() => events.push("change"));

      store.setActive("second");

      expect(events).toEqual(["setActive", "change"]);
    });
  });

  describe("edge cases", () => {
    it("should handle instance with no optional fields", () => {
      const minimalRecord: InstanceRecord = {
        config: { id: "minimal" },
        runtime: {},
        state: "disconnected",
      };

      store.upsert(minimalRecord);
      const retrieved = store.get("minimal");

      expect(retrieved).toBeDefined();
      expect(retrieved?.config.id).toBe("minimal");
      expect(retrieved?.config.label).toBeUndefined();
      expect(retrieved?.runtime.port).toBeUndefined();
    });

    it("should handle instance with error field", () => {
      const errorRecord: InstanceRecord = {
        config: { id: "error-test" },
        runtime: {},
        state: "error",
        error: "Connection failed",
      };

      store.upsert(errorRecord);
      const retrieved = store.get("error-test");

      expect(retrieved?.state).toBe("error");
      expect(retrieved?.error).toBe("Connection failed");
    });

    it("should handle all possible states", () => {
      const states: Array<InstanceRecord["state"]> = [
        "disconnected",
        "resolving",
        "spawning",
        "connecting",
        "connected",
        "error",
        "stopping",
      ];

      states.forEach((state, index) => {
        store.upsert({
          config: { id: `instance-${index}` },
          runtime: {},
          state,
        });
      });

      expect(store.getAll()).toHaveLength(states.length);
      states.forEach((state, index) => {
        expect(store.get(`instance-${index}`)?.state).toBe(state);
      });
    });

    it("should handle rapid successive upserts", () => {
      const listener = vi.fn();
      store.onDidChange(listener);

      for (let i = 0; i < 100; i++) {
        store.upsert({
          config: { id: "test" },
          runtime: { port: 4000 + i },
          state: "connected",
        });
      }

      expect(listener).toHaveBeenCalledTimes(100);
      expect(store.get("test")?.runtime.port).toBe(4099);
    });

    it("should handle special characters in instance ids", () => {
      const specialIds = [
        "test-with-dashes",
        "test_with_underscores",
        "test.with.dots",
        "test:with:colons",
        "test/with/slashes",
      ];

      specialIds.forEach((id) => {
        store.upsert({
          config: { id },
          runtime: {},
          state: "disconnected",
        });
      });

      expect(store.getAll()).toHaveLength(specialIds.length);
      specialIds.forEach((id) => {
        expect(store.get(id)).toBeDefined();
      });
    });
  });

  describe("toolId and migration", () => {
    it("should default toolId to 'opencode' if missing (migration)", () => {
      const record: InstanceRecord = {
        config: { id: "test-1" },
        runtime: {},
        state: "disconnected",
      };

      store.upsert(record);
      const retrieved = store.get("test-1");
      expect(retrieved?.config.toolId).toBe("opencode");
    });

    it("should preserve provided toolId", () => {
      const record: InstanceRecord = {
        config: { id: "test-claude", toolId: "claude" },
        runtime: {},
        state: "disconnected",
      };

      store.upsert(record);
      const retrieved = store.get("test-claude");
      expect(retrieved?.config.toolId).toBe("claude");
    });

    it("should filter records by toolId using getByTool", () => {
      store.upsert({
        config: { id: "o1", toolId: "opencode" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "c1", toolId: "claude" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "o2", toolId: "opencode" },
        runtime: {},
        state: "disconnected",
      });

      const opencodeInstances = store.getByTool("opencode");
      const claudeInstances = store.getByTool("claude");

      expect(opencodeInstances).toHaveLength(2);
      expect(opencodeInstances.map((r) => r.config.id)).toContain("o1");
      expect(opencodeInstances.map((r) => r.config.id)).toContain("o2");
      expect(claudeInstances).toHaveLength(1);
      expect(claudeInstances[0].config.id).toBe("c1");
    });

    it("should return unique toolIds using getTools", () => {
      store.upsert({
        config: { id: "o1", toolId: "opencode" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "c1", toolId: "claude" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "o2", toolId: "opencode" },
        runtime: {},
        state: "disconnected",
      });
      store.upsert({
        config: { id: "a1", toolId: "aider" },
        runtime: {},
        state: "disconnected",
      });

      const tools = store.getTools();
      expect(tools).toHaveLength(3);
      expect(tools).toContain("opencode");
      expect(tools).toContain("claude");
      expect(tools).toContain("aider");
    });
  });
});
