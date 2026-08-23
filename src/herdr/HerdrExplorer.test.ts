import { describe, expect, it, vi } from "vitest";
import {
  HerdrAgentsTreeProvider,
  HerdrSnapshotStore,
  HerdrSpacesTreeProvider,
} from "./HerdrExplorer";
import type { HerdrAgent, HerdrSpace } from "./types";

function space(overrides: Partial<HerdrSpace> = {}): HerdrSpace {
  return {
    workspaceId: "w46",
    label: "ulwcode",
    status: "working",
    paneCount: 1,
    ...overrides,
  };
}

function agent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    paneId: "w46:p1",
    terminalId: "term-1",
    agent: "pi",
    status: "working",
    title: "omo - ulwcode",
    cwd: "/repo",
    workspaceId: "w46",
    ...overrides,
  };
}

describe("HerdrExplorer", () => {
  it("lists spaces as leaves that open the space command", async () => {
    const store = new HerdrSnapshotStore({
      listWorkspaces: async () => [space()],
      listAgents: async () => [agent()],
    });
    await store.refresh();
    const provider = new HerdrSpacesTreeProvider(store);

    const children = await provider.getChildren();
    expect(children).toEqual([
      {
        kind: "space",
        space: space(),
      },
    ]);
    const item = provider.getTreeItem(children[0]);
    expect(item.label).toBe("ulwcode");
    expect(item.description).toBe("working");
    expect(item.command).toEqual({
      command: "ulw.herdr.openSpace",
      title: "Open Space",
      arguments: [children[0]],
    });
  });

  it("lists agents as leaves that attach without a QuickPick", async () => {
    const store = new HerdrSnapshotStore({
      listWorkspaces: async () => [space()],
      listAgents: async () => [agent({ title: "" })],
    });
    await store.refresh();
    const provider = new HerdrAgentsTreeProvider(store);

    const children = await provider.getChildren();
    expect(children).toEqual([
      {
        kind: "agent",
        agent: agent({ title: "" }),
      },
    ]);
    const item = provider.getTreeItem(children[0]);
    expect(item.label).toBe("pi \u00b7 w46:p1");
    expect(item.command).toEqual({
      command: "ulw.herdr.openAgent",
      title: "Attach Agent",
      arguments: [children[0]],
    });
  });

  it("returns no children when Herdr lists are empty", async () => {
    const store = new HerdrSnapshotStore({
      listWorkspaces: async () => [],
      listAgents: async () => [],
    });
    await store.refresh();
    expect(await new HerdrSpacesTreeProvider(store).getChildren()).toEqual([]);
    expect(await new HerdrAgentsTreeProvider(store).getChildren()).toEqual([]);
  });

  it("keeps the previous snapshot when refresh fails", async () => {
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce([space()])
      .mockRejectedValueOnce(new Error("server down"));
    const store = new HerdrSnapshotStore({
      listWorkspaces,
      listAgents: async () => [agent()],
    });
    await store.refresh();
    await expect(store.refresh()).rejects.toThrow("server down");
    expect(store.spaces()).toEqual([space()]);
  });
});
