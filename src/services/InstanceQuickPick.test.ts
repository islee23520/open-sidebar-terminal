import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { InstanceQuickPick } from "./InstanceQuickPick";
import { InstanceDiscoveryService } from "./InstanceDiscoveryService";
import { InstanceRecord, InstanceStore } from "./InstanceStore";

vi.mock("vscode");

type QuickPickTestItem = vscode.QuickPickItem & {
  action:
    | { type: "select"; instanceId: string }
    | { type: "connect"; instanceId: string; port: number }
    | { type: "disconnect"; instanceId: string }
    | { type: "spawn" }
    | { type: "refresh" };
};

type QuickPickDouble = {
  items: QuickPickTestItem[];
  activeItems: QuickPickTestItem[];
  selectedItems: QuickPickTestItem[];
  placeholder: string;
  title: string;
  busy: boolean;
  enabled: boolean;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  value: string;
  onDidAccept: ReturnType<typeof vi.fn>;
  onDidHide: ReturnType<typeof vi.fn>;
  show: () => void;
  hide: () => void;
  dispose: () => void;
};

function createRecord(
  overrides: Partial<InstanceRecord> & { config: { id: string } },
): InstanceRecord {
  return {
    config: {
      ...overrides.config,
    },
    runtime: overrides.runtime ?? {},
    state: overrides.state ?? "disconnected",
    health: overrides.health,
    error: overrides.error,
  };
}

describe("InstanceQuickPick", () => {
  let instanceStore: InstanceStore;
  let discoveryService: InstanceDiscoveryService;
  let quickPicks: QuickPickDouble[];
  let acceptHandlers: Array<() => void | Promise<void>>;
  let hideHandlers: Array<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();

    instanceStore = new InstanceStore();
    discoveryService = new InstanceDiscoveryService();
    quickPicks = [];
    acceptHandlers = [];
    hideHandlers = [];

    vi.mocked(vscode.window.createQuickPick).mockImplementation(() => {
      const quickPick: vscode.QuickPick<QuickPickTestItem> & QuickPickDouble = {
        items: [],
        activeItems: [],
        selectedItems: [],
        buttons: [],
        placeholder: "",
        prompt: "",
        title: "",
        step: undefined,
        totalSteps: undefined,
        busy: false,
        enabled: true,
        ignoreFocusOut: false,
        canSelectMany: false,
        matchOnDescription: false,
        matchOnDetail: false,
        keepScrollPosition: false,
        value: "",
        onDidChangeValue: vi.fn(() => ({ dispose: vi.fn() })),
        onDidTriggerButton: vi.fn(() => ({ dispose: vi.fn() })),
        onDidTriggerItemButton: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeActive: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
        onDidAccept: vi.fn((handler: () => void | Promise<void>) => {
          acceptHandlers.push(handler);
          return { dispose: vi.fn() };
        }),
        onDidHide: vi.fn((handler: () => void) => {
          hideHandlers.push(handler);
          return { dispose: vi.fn() };
        }),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      };

      quickPicks.push(quickPick);
      return quickPick;
    });
  });

  it("shows merged store and discovered items, dedupes ports, and disposes on hide", async () => {
    const activeRecord = createRecord({
      config: { id: "active", label: "Primary" },
      runtime: { port: 4100 },
      state: "connected",
      health: { ok: true, sessionTitle: "alpha", model: "gpt-5" },
    });
    const connectingRecord = createRecord({
      config: { id: "connecting", label: "Secondary" },
      runtime: { port: 4200 },
      state: "connecting",
    });
    const errorRecord = createRecord({
      config: { id: "broken" },
      runtime: {},
      state: "error",
    });

    vi.spyOn(instanceStore, "getAll").mockReturnValue([
      activeRecord,
      connectingRecord,
      errorRecord,
    ]);
    vi.spyOn(instanceStore, "getActive").mockReturnValue(activeRecord);
    vi.spyOn(discoveryService, "discoverInstances").mockResolvedValue([
      { port: 4200, pid: 1, workspacePath: "/duplicate" },
      { port: 4300, pid: 2, workspacePath: "/workspace/external" },
    ]);

    await new InstanceQuickPick(instanceStore, discoveryService).show();

    const quickPick = quickPicks[0];
    expect(quickPick.title).toBe("OpenCode Tmux Sessions");
    expect(quickPick.placeholder).toBe("Select a tmux session to connect...");
    expect(quickPick.show).toHaveBeenCalledOnce();
    expect(quickPick.busy).toBe(false);
    expect(quickPick.items).toHaveLength(7);
    expect(quickPick.items[0]).toMatchObject({
      label: "$(circle-filled) Primary:4100 $(check)",
      description: "connected — alpha",
      detail: "Model: gpt-5",
      action: { type: "select", instanceId: "active" },
    });
    expect(quickPick.items[1]).toMatchObject({
      label: "$(loading~spin) Secondary:4200",
      description: "connecting",
      action: { type: "connect", instanceId: "connecting", port: 4200 },
    });
    expect(quickPick.items[2]).toMatchObject({
      label: "$(error) broken",
      description: "error",
      action: { type: "select", instanceId: "broken" },
    });
    expect(quickPick.items[3]).toMatchObject({
      label: "$(circle-large-outline) External :4300",
      description: "PID 2 — /workspace/external",
      detail: "Discovered externally-running tmux session",
      action: { type: "connect", instanceId: "discovered-4300", port: 4300 },
    });
    expect(quickPick.items.map((item) => item.label)).not.toContain(
      "$(circle-large-outline) External :4200",
    );
    expect(quickPick.items[4]).toMatchObject({
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
      action: { type: "refresh" },
    });
    expect(quickPick.items[5]).toMatchObject({
      label: "$(add) Spawn New Tmux Session",
      action: { type: "spawn" },
    });
    expect(quickPick.items[6]).toMatchObject({
      label: "$(refresh) Refresh",
      action: { type: "refresh" },
    });

    hideHandlers[0]();
    expect(quickPick.dispose).toHaveBeenCalledOnce();
  });

  it("swallows active and discovery lookup failures and keeps action items for empty state", async () => {
    vi.spyOn(instanceStore, "getAll").mockReturnValue([]);
    vi.spyOn(instanceStore, "getActive").mockImplementation(() => {
      throw new Error("no active instance");
    });
    vi.spyOn(discoveryService, "discoverInstances").mockRejectedValue(
      new Error("discovery failed"),
    );

    await new InstanceQuickPick(instanceStore, discoveryService).show();

    expect(quickPicks[0].items).toEqual([
      expect.objectContaining({
        label: "$(add) Spawn New Tmux Session",
        action: { type: "spawn" },
      }),
      expect.objectContaining({
        label: "$(refresh) Refresh",
        action: { type: "refresh" },
      }),
    ]);
  });

  it("falls back when item building fails and can spawn a new session", async () => {
    vi.spyOn(instanceStore, "getAll").mockImplementation(() => {
      throw new Error("store failure");
    });

    await new InstanceQuickPick(instanceStore, discoveryService).show();

    const quickPick = quickPicks[0];
    expect(quickPick.items).toEqual([
      expect.objectContaining({
        label: "$(warning) Failed to discover instances",
        action: { type: "spawn" },
      }),
      expect.objectContaining({
        label: "$(refresh) Refresh",
        action: { type: "refresh" },
      }),
    ]);

    quickPick.selectedItems = [quickPick.items[0]];
    await acceptHandlers[0]();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.start",
    );
    expect(quickPick.dispose).toHaveBeenCalledOnce();
  });

  it("disposes immediately when nothing is selected and selects connected sessions", async () => {
    const connectedRecord = createRecord({
      config: { id: "connected", label: "Connected" },
      runtime: { port: 4500 },
      state: "connected",
    });

    vi.spyOn(instanceStore, "getAll").mockReturnValue([connectedRecord]);
    vi.spyOn(instanceStore, "getActive").mockReturnValue(connectedRecord);
    const setActiveSpy = vi
      .spyOn(instanceStore, "setActive")
      .mockImplementation(() => {
        return undefined;
      });
    vi.spyOn(discoveryService, "discoverInstances").mockResolvedValue([]);

    const picker = new InstanceQuickPick(instanceStore, discoveryService);
    await picker.show();

    const firstQuickPick = quickPicks[0];
    await acceptHandlers[0]();
    expect(firstQuickPick.dispose).toHaveBeenCalledOnce();
    expect(setActiveSpy).not.toHaveBeenCalled();

    await picker.show();

    const secondQuickPick = quickPicks[1];
    secondQuickPick.selectedItems = [secondQuickPick.items[0]];
    await acceptHandlers[1]();

    expect(setActiveSpy).toHaveBeenCalledWith("connected");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Switched to tmux session: connected",
    );
    expect(secondQuickPick.dispose).toHaveBeenCalledOnce();
  });

  it("reports selection errors", async () => {
    const connectedRecord = createRecord({
      config: { id: "connected" },
      runtime: { port: 4500 },
      state: "connected",
    });

    vi.spyOn(instanceStore, "getAll").mockReturnValue([connectedRecord]);
    vi.spyOn(instanceStore, "getActive").mockReturnValue(connectedRecord);
    vi.spyOn(instanceStore, "setActive").mockImplementation(() => {
      throw new Error("cannot switch");
    });
    vi.spyOn(discoveryService, "discoverInstances").mockResolvedValue([]);

    await new InstanceQuickPick(instanceStore, discoveryService).show();

    quickPicks[0].selectedItems = [quickPicks[0].items[0]];
    await acceptHandlers[0]();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to select tmux session: cannot switch",
    );
  });

  it("connects through the controller, upserts without a controller, and reports connect errors", async () => {
    const connectController = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const connectStore = new InstanceStore();
    const connectDiscovery = new InstanceDiscoveryService();
    const connectSetActiveSpy = vi
      .spyOn(connectStore, "setActive")
      .mockImplementation(() => undefined);
    vi.spyOn(connectStore, "getAll").mockReturnValue([]);
    vi.spyOn(connectStore, "getActive").mockImplementation(() => {
      throw new Error("empty");
    });
    vi.spyOn(connectDiscovery, "discoverInstances").mockResolvedValue([
      { port: 4600, pid: 9, workspacePath: "/controller" },
    ]);

    const controllerPicker = new InstanceQuickPick(
      connectStore,
      connectDiscovery,
    );
    Reflect.set(controllerPicker, "controller", connectController);

    await controllerPicker.show();
    quickPicks[0].selectedItems = [quickPicks[0].items[0]];
    await acceptHandlers[0]();

    expect(connectController.connect).toHaveBeenCalledWith(
      "discovered-4600",
      4600,
    );
    expect(connectSetActiveSpy).toHaveBeenCalledWith("discovered-4600");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Connected to tmux session on port 4600",
    );

    const noControllerStore = new InstanceStore();
    const noControllerDiscovery = new InstanceDiscoveryService();
    const upsertSpy = vi
      .spyOn(noControllerStore, "upsert")
      .mockImplementation(() => undefined);
    const noControllerSetActiveSpy = vi
      .spyOn(noControllerStore, "setActive")
      .mockImplementation(() => undefined);
    vi.spyOn(noControllerStore, "getAll").mockReturnValue([]);
    vi.spyOn(noControllerStore, "getActive").mockImplementation(() => {
      throw new Error("empty");
    });
    vi.spyOn(noControllerDiscovery, "discoverInstances").mockResolvedValue([
      { port: 4700, pid: 10, workspacePath: "/no-controller" },
    ]);

    await new InstanceQuickPick(
      noControllerStore,
      noControllerDiscovery,
    ).show();
    quickPicks[1].selectedItems = [quickPicks[1].items[0]];
    await acceptHandlers[1]();

    expect(upsertSpy).toHaveBeenCalledWith({
      config: { id: "discovered-4700", preferredPort: 4700 },
      runtime: { port: 4700 },
      state: "connected",
    });
    expect(noControllerSetActiveSpy).toHaveBeenCalledWith("discovered-4700");

    const errorController = {
      connect: vi.fn().mockRejectedValue(new Error("refused")),
      disconnect: vi.fn(),
    };
    const errorStore = new InstanceStore();
    const errorDiscovery = new InstanceDiscoveryService();
    vi.spyOn(errorStore, "getAll").mockReturnValue([]);
    vi.spyOn(errorStore, "getActive").mockImplementation(() => {
      throw new Error("empty");
    });
    vi.spyOn(errorDiscovery, "discoverInstances").mockResolvedValue([
      { port: 4800, pid: 11, workspacePath: "/error" },
    ]);

    const errorPicker = new InstanceQuickPick(errorStore, errorDiscovery);
    Reflect.set(errorPicker, "controller", errorController);

    await errorPicker.show();
    quickPicks[2].selectedItems = [quickPicks[2].items[0]];
    await acceptHandlers[2]();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to connect: refused",
    );
  });

  it("disconnects through the controller and reports disconnect errors", async () => {
    const controller = {
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    const picker = new InstanceQuickPick(instanceStore, discoveryService);
    Reflect.set(picker, "controller", controller);
    vi.spyOn(instanceStore, "getAll").mockReturnValue([]);
    vi.spyOn(instanceStore, "getActive").mockImplementation(() => {
      throw new Error("empty");
    });
    vi.spyOn(discoveryService, "discoverInstances").mockResolvedValue([]);

    await picker.show();
    quickPicks[0].selectedItems = [
      {
        label: "Disconnect",
        action: { type: "disconnect", instanceId: "active" },
      },
    ];
    await acceptHandlers[0]();

    expect(controller.disconnect).toHaveBeenCalledWith("active");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Disconnected from tmux session",
    );

    controller.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));

    await picker.show();
    quickPicks[1].selectedItems = [
      {
        label: "Disconnect",
        action: { type: "disconnect", instanceId: "active" },
      },
    ];
    await acceptHandlers[1]();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to disconnect: disconnect failed",
    );
  });

  it("refreshes by reopening the quick pick", async () => {
    vi.spyOn(instanceStore, "getAll").mockReturnValue([]);
    vi.spyOn(instanceStore, "getActive").mockImplementation(() => {
      throw new Error("empty");
    });
    vi.spyOn(discoveryService, "discoverInstances").mockResolvedValue([]);

    const picker = new InstanceQuickPick(instanceStore, discoveryService);
    await picker.show();

    quickPicks[0].selectedItems = [quickPicks[0].items[1]];
    await acceptHandlers[0]();

    expect(vscode.window.createQuickPick).toHaveBeenCalledTimes(2);
    expect(quickPicks[0].dispose).toHaveBeenCalledOnce();
    expect(quickPicks[1].show).toHaveBeenCalledOnce();
  });
});
