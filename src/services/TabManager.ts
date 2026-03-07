import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { CliToolType } from "../types";

export interface Tab {
  id: string;
  toolId: CliToolType;
  instanceId: string;
  label: string;
  state: "active" | "inactive" | "error";
  createdAt: number;
  updatedAt: number;
}

export interface TabManagerState {
  tabs: Tab[];
  activeTabId: string | null;
}

type TabManagerEventMap = {
  changeTabs: [tabs: Tab[]];
  changeActive: [activeTab: Tab | null];
  addTab: [tab: Tab];
  removeTab: [tabId: string];
};

export class TabManager {
  private readonly tabs: Map<string, Tab> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string | null = null;
  private readonly emitter = new EventEmitter();

  public createTab(toolId: CliToolType, label?: string): Tab {
    const now = Date.now();
    const id = randomUUID();
    const tab: Tab = {
      id,
      toolId,
      instanceId: randomUUID(),
      label: label ?? `${toolId} ${this.tabOrder.length + 1}`,
      state: "inactive",
      createdAt: now,
      updatedAt: now,
    };

    this.tabs.set(id, tab);
    this.tabOrder.push(id);
    this.emit("addTab", this.cloneTab(tab));
    this.setActiveTab(id);

    const created = this.getTab(id);
    if (!created) {
      throw new Error("Failed to create tab");
    }
    return created;
  }

  public removeTab(tabId: string): boolean {
    if (!this.tabs.has(tabId)) {
      return false;
    }

    const removalIndex = this.tabOrder.indexOf(tabId);
    this.tabs.delete(tabId);
    if (removalIndex >= 0) {
      this.tabOrder.splice(removalIndex, 1);
    }

    this.emit("removeTab", tabId);

    if (this.activeTabId === tabId) {
      if (this.tabOrder.length === 0) {
        this.activeTabId = null;
        this.emit("changeActive", null);
        this.emit("changeTabs", this.getAllTabs());
        return true;
      }

      const nextIndex = Math.min(removalIndex, this.tabOrder.length - 1);
      this.setActiveTab(this.tabOrder[nextIndex]);
      return true;
    }

    this.emit("changeTabs", this.getAllTabs());
    return true;
  }

  public updateTab(tabId: string, updates: Partial<Omit<Tab, "id">>): boolean {
    const existing = this.tabs.get(tabId);
    if (!existing) {
      return false;
    }

    const nextTab: Tab = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    this.tabs.set(tabId, nextTab);

    if (updates.state === "active") {
      this.setActiveTab(tabId);
      return true;
    }

    if (this.activeTabId === tabId && nextTab.state !== "active") {
      this.recoverActiveTab(tabId);
      return true;
    }

    this.emit("changeTabs", this.getAllTabs());
    return true;
  }

  public reorderTabs(tabIds: string[]): void {
    const ordered: string[] = [];
    const seen = new Set<string>();

    for (const tabId of tabIds) {
      if (this.tabs.has(tabId) && !seen.has(tabId)) {
        ordered.push(tabId);
        seen.add(tabId);
      }
    }

    for (const tabId of this.tabOrder) {
      if (!seen.has(tabId)) {
        ordered.push(tabId);
      }
    }

    if (
      ordered.length === this.tabOrder.length &&
      ordered.every((tabId, index) => tabId === this.tabOrder[index])
    ) {
      return;
    }

    this.tabOrder = ordered;
    this.emit("changeTabs", this.getAllTabs());
  }

  public setActiveTab(tabId: string): void {
    if (!this.tabs.has(tabId)) {
      throw new Error(`Cannot set active tab: unknown id '${tabId}'`);
    }

    if (this.activeTabId === tabId) {
      return;
    }

    const now = Date.now();

    if (this.activeTabId) {
      const current = this.tabs.get(this.activeTabId);
      if (current) {
        this.tabs.set(this.activeTabId, {
          ...current,
          state: current.state === "error" ? "error" : "inactive",
          updatedAt: now,
        });
      }
    }

    const next = this.tabs.get(tabId);
    if (!next) {
      throw new Error(`Cannot set active tab: unknown id '${tabId}'`);
    }

    this.tabs.set(tabId, {
      ...next,
      state: "active",
      updatedAt: now,
    });
    this.activeTabId = tabId;

    this.emit("changeActive", this.getActiveTab());
    this.emit("changeTabs", this.getAllTabs());
  }

  public getActiveTab(): Tab | null {
    if (!this.activeTabId) {
      return null;
    }

    const active = this.tabs.get(this.activeTabId);
    return active ? this.cloneTab(active) : null;
  }

  public getAllTabs(): Tab[] {
    const tabs: Tab[] = [];
    for (const tabId of this.tabOrder) {
      const tab = this.tabs.get(tabId);
      if (tab) {
        tabs.push(this.cloneTab(tab));
      }
    }
    return tabs;
  }

  public getTab(tabId: string): Tab | null {
    const tab = this.tabs.get(tabId);
    return tab ? this.cloneTab(tab) : null;
  }

  public getTabsByTool(toolId: CliToolType): Tab[] {
    return this.getAllTabs().filter((tab) => tab.toolId === toolId);
  }

  public nextTab(): void {
    if (this.tabOrder.length <= 1 || !this.activeTabId) {
      return;
    }

    const currentIndex = this.tabOrder.indexOf(this.activeTabId);
    const nextIndex = (currentIndex + 1) % this.tabOrder.length;
    this.setActiveTab(this.tabOrder[nextIndex]);
  }

  public previousTab(): void {
    if (this.tabOrder.length <= 1 || !this.activeTabId) {
      return;
    }

    const currentIndex = this.tabOrder.indexOf(this.activeTabId);
    const previousIndex =
      (currentIndex - 1 + this.tabOrder.length) % this.tabOrder.length;
    this.setActiveTab(this.tabOrder[previousIndex]);
  }

  public serialize(): TabManagerState {
    return {
      tabs: this.getAllTabs(),
      activeTabId: this.activeTabId,
    };
  }

  public deserialize(state: TabManagerState): void {
    this.tabs.clear();
    this.tabOrder = [];

    for (const tab of state.tabs) {
      this.tabs.set(tab.id, this.cloneTab(tab));
      this.tabOrder.push(tab.id);
    }

    this.activeTabId =
      state.activeTabId && this.tabs.has(state.activeTabId)
        ? state.activeTabId
        : null;

    if (!this.activeTabId && this.tabOrder.length > 0) {
      this.activeTabId = this.tabOrder[0];
    }

    const now = Date.now();
    for (const tabId of this.tabOrder) {
      const tab = this.tabs.get(tabId);
      if (!tab) {
        continue;
      }

      const nextState =
        tabId === this.activeTabId
          ? "active"
          : tab.state === "error"
            ? "error"
            : "inactive";

      this.tabs.set(tabId, {
        ...tab,
        state: nextState,
        updatedAt: now,
      });
    }

    this.emit("changeActive", this.getActiveTab());
    this.emit("changeTabs", this.getAllTabs());
  }

  public onDidChangeTabs(listener: (tabs: Tab[]) => void): vscode.Disposable {
    return this.on("changeTabs", listener);
  }

  public onDidChangeActive(
    listener: (activeTab: Tab | null) => void,
  ): vscode.Disposable {
    return this.on("changeActive", listener);
  }

  public onDidAddTab(listener: (tab: Tab) => void): vscode.Disposable {
    return this.on("addTab", listener);
  }

  public onDidRemoveTab(listener: (tabId: string) => void): vscode.Disposable {
    return this.on("removeTab", listener);
  }

  private recoverActiveTab(removedActiveId: string): void {
    const fallbackId =
      this.tabOrder.find((tabId) => tabId !== removedActiveId) ?? null;

    if (!fallbackId) {
      this.activeTabId = null;
      this.emit("changeActive", null);
      this.emit("changeTabs", this.getAllTabs());
      return;
    }

    this.setActiveTab(fallbackId);
  }

  private on<K extends keyof TabManagerEventMap>(
    event: K,
    listener: (...args: TabManagerEventMap[K]) => void,
  ): vscode.Disposable {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return new vscode.Disposable(() => {
      this.emitter.off(event, listener as (...args: unknown[]) => void);
    });
  }

  private emit<K extends keyof TabManagerEventMap>(
    event: K,
    ...args: TabManagerEventMap[K]
  ): void {
    this.emitter.emit(event, ...args);
  }

  private cloneTab(tab: Tab): Tab {
    return {
      ...tab,
    };
  }
}
