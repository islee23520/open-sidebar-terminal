import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { StatusBarManager } from "./StatusBarManager";
import { InstanceStore } from "./InstanceStore";

vi.mock("vscode");

describe("StatusBarManager", () => {
  let statusBarManager: StatusBarManager;
  let mockStatusBarItem: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStatusBarItem = {
      text: "",
      tooltip: "",
      command: "",
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };

    (vscode.window.createStatusBarItem as any).mockReturnValue(
      mockStatusBarItem,
    );

    (vscode.workspace.getConfiguration as any).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === "showStatusBar") return true;
        return defaultValue;
      }),
    });

    statusBarManager = new StatusBarManager();
  });

  it("should create a status bar item with correct properties", () => {
    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    expect(mockStatusBarItem.text).toBe("$(terminal) OpenCode • tmux: idle");
    expect(mockStatusBarItem.tooltip).toBe("Manage OpenCode tmux sessions");
    expect(mockStatusBarItem.command).toBe("opencodeTui.selectInstance");
  });

  it("shows active tmux session status when store has connected session", () => {
    const store = new InstanceStore();
    store.upsert({
      config: { id: "session-a", label: "Session A" },
      runtime: { port: 4096 },
      state: "connected",
    });

    const manager = new StatusBarManager(store);

    expect(mockStatusBarItem.text).toContain("tmux: connected");
    expect(mockStatusBarItem.text).toContain(":4096");
    expect(mockStatusBarItem.text).toContain("[Session A]");
    expect(mockStatusBarItem.tooltip).toContain(
      "Active tmux session: session-a",
    );

    manager.dispose();
  });

  it("updates to disconnected state color for non-connected sessions", () => {
    const store = new InstanceStore();
    store.upsert({
      config: { id: "session-b" },
      runtime: {},
      state: "disconnected",
    });

    const manager = new StatusBarManager(store);

    expect(mockStatusBarItem.text).toContain("tmux: disconnected");
    expect((mockStatusBarItem.color as vscode.ThemeColor).id).toBe(
      "statusBarItem.errorForeground",
    );

    manager.dispose();
  });

  it("should show status bar item if configured to show", () => {
    statusBarManager.show();
    expect(mockStatusBarItem.show).toHaveBeenCalled();
  });

  it("should hide status bar item when hide() is called", () => {
    statusBarManager.hide();
    expect(mockStatusBarItem.hide).toHaveBeenCalled();
  });

  it("should respect showStatusBar configuration", () => {
    (vscode.workspace.getConfiguration as any).mockReturnValue({
      get: vi.fn((key: string) => {
        if (key === "showStatusBar") return false;
        return true;
      }),
    });

    statusBarManager.show();
    expect(mockStatusBarItem.show).not.toHaveBeenCalled();
    expect(mockStatusBarItem.hide).toHaveBeenCalled();
  });

  it("should dispose correctly", () => {
    statusBarManager.dispose();
    expect(mockStatusBarItem.dispose).toHaveBeenCalled();
  });
});
