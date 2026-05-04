import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscodeTypes from "../../test/mocks/vscode";
import { registerTmuxSessionCommands } from "./tmuxSessionCommands";
import { InstanceStore } from "../../services/InstanceStore";
import { TerminalProvider } from "../../providers/TerminalProvider";
import { InstanceController } from "../../services/InstanceController";
import { InstanceQuickPick } from "../../services/InstanceQuickPick";
import { OutputChannelService } from "../../services/OutputChannelService";
import { TmuxSessionManager } from "../../services/TmuxSessionManager";
import { ZellijSessionManager } from "../../services/ZellijSessionManager";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../../test/mocks/vscode");
  return actual;
});

type SessionSummary = {
  id: string;
  name: string;
  workspace: string;
  isActive?: boolean;
};

type CommandHandlers = {
  openInNewWindow: () => Promise<void>;
  spawnForWorkspace: (uri?: { toString(): string }) => Promise<void>;
  selectInstance: () => void;
  switchTmuxSession: (sessionId?: string) => Promise<void>;
  createTmuxSession: () => Promise<void>;
  killTmuxSession: (sessionId?: string) => Promise<void>;
  switchNativeShell: () => Promise<void>;
  browseTmuxSessions: () => Promise<void>;
  killNativeShell: (instanceId?: string) => Promise<void>;
};

function createProvider(): TerminalProvider {
  return Object.assign(Object.create(TerminalProvider.prototype), {
    switchToTmuxSession: vi.fn().mockResolvedValue(undefined),
    switchToZellijSession: vi.fn().mockResolvedValue(undefined),
    createTmuxSession: vi.fn().mockResolvedValue(undefined),
    killTmuxSession: vi.fn().mockResolvedValue(undefined),
    switchToNativeShell: vi.fn().mockResolvedValue(undefined),
  });
}

function createInstanceController(): InstanceController {
  return Object.assign(Object.create(InstanceController.prototype), {
    spawn: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  });
}

function createInstanceQuickPick(): InstanceQuickPick {
  return Object.assign(Object.create(InstanceQuickPick.prototype), {
    show: vi.fn(),
  });
}

function createOutputChannel(): OutputChannelService {
  const outputChannel = OutputChannelService.getInstance();
  vi.spyOn(outputChannel, "error").mockImplementation(() => {});
  return outputChannel;
}

function createTmuxManager(
  sessions: SessionSummary[] = [],
): TmuxSessionManager {
  return Object.assign(Object.create(TmuxSessionManager.prototype), {
    discoverSessions: vi.fn().mockResolvedValue(sessions),
  });
}

function createZellijManager(
  sessions: SessionSummary[] = [],
): ZellijSessionManager {
  return Object.assign(Object.create(ZellijSessionManager.prototype), {
    discoverSessions: vi.fn().mockResolvedValue(sessions),
  });
}

function createInstanceStore(
  records: Array<Parameters<InstanceStore["upsert"]>[0]> = [],
) {
  const store = new InstanceStore();
  for (const record of records) {
    store.upsert(record);
  }
  return store;
}

function getCommandHandlers(): CommandHandlers {
  const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;

  const getHandler = (commandId: string) => {
    const call = calls.find((entry) => entry[0] === commandId);
    expect(call).toBeDefined();
    return call?.[1];
  };

  return {
    openInNewWindow: getHandler(
      "opencode.openInNewWindow",
    ) as () => Promise<void>,
    spawnForWorkspace: getHandler("opencode.spawnForWorkspace") as (uri?: {
      toString(): string;
    }) => Promise<void>,
    selectInstance: getHandler("opencodeTui.selectInstance") as () => void,
    switchTmuxSession: getHandler("opencodeTui.switchTmuxSession") as (
      sessionId?: string,
    ) => Promise<void>,
    createTmuxSession: getHandler(
      "opencodeTui.createTmuxSession",
    ) as () => Promise<void>,
    killTmuxSession: getHandler("opencodeTui.killTmuxSession") as (
      sessionId?: string,
    ) => Promise<void>,
    switchNativeShell: getHandler(
      "opencodeTui.switchNativeShell",
    ) as () => Promise<void>,
    browseTmuxSessions: getHandler(
      "opencodeTui.browseTmuxSessions",
    ) as () => Promise<void>,
    killNativeShell: getHandler("opencodeTui.killNativeShell") as (
      instanceId?: string,
    ) => Promise<void>,
  };
}

describe("registerTmuxSessionCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    OutputChannelService.resetInstance();
    vscode.workspace.workspaceFolders = undefined;
    Reflect.set(vscode.workspace, "name", undefined);
  });

  it("registers all 9 tmux session commands", () => {
    const disposables = registerTmuxSessionCommands({
      provider: undefined,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    expect(disposables).toHaveLength(9);
    expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(9);
  });

  it("shows an error when openInNewWindow runs without an instance store", async () => {
    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().openInNewWindow();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Instance store is not initialized",
    );
  });

  it("creates a new window record, opens the workspace folder, and reports success", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(12345);
    const instanceStore = createInstanceStore([
      {
        config: {
          id: "active",
          workspaceUri: "file:///workspace/main",
          label: "Main Workspace",
        },
        runtime: {},
        state: "connected",
      },
    ]);

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().openInNewWindow();

    expect(instanceStore.get("12345")).toEqual({
      config: {
        id: "12345",
        workspaceUri: "file:///workspace/main",
        label: "Main Workspace (New Window)",
      },
      runtime: {},
      state: "disconnected",
    });
    expect(vscode.Uri.parse).toHaveBeenCalledWith("file:///workspace/main");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.objectContaining({ path: "/workspace/main" }),
      true,
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Opened in new window: Main Workspace (New Window)",
    );

    dateNowSpy.mockRestore();
  });

  it("logs and shows errors when openInNewWindow fails", async () => {
    const outputChannel = createOutputChannel();
    const instanceStore = createInstanceStore();
    vi.spyOn(instanceStore, "getActive").mockImplementation(() => {
      throw new Error("boom");
    });

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel,
      tmuxManager: undefined,
    });

    await getCommandHandlers().openInNewWindow();

    expect(outputChannel.error).toHaveBeenCalledWith(
      "Failed to open in new window: boom",
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to open in new window: boom",
    );
  });

  it("shows an error when spawnForWorkspace runs without an instance store", async () => {
    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().spawnForWorkspace();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Instance store is not initialized",
    );
  });

  it("warns when spawnForWorkspace has no workspace available", async () => {
    const instanceStore = createInstanceStore();

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().spawnForWorkspace();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "No workspace folder available",
    );
  });

  it("focuses a reusable workspace instance instead of spawning a duplicate", async () => {
    const instanceStore = createInstanceStore([
      {
        config: {
          id: "existing",
          workspaceUri: "file:///workspace/reused",
          label: "Reusable Workspace",
        },
        runtime: {},
        state: "connected",
      },
    ]);
    const instanceController = createInstanceController();

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().spawnForWorkspace({
      toString: () => "file:///workspace/reused",
    });

    expect(instanceController.spawn).not.toHaveBeenCalled();
    expect(instanceStore.getActive().config.id).toBe("existing");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.focus",
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Focused existing OpenCode for workspace: Reusable Workspace",
    );
  });

  it("respawns an existing disconnected workspace instance", async () => {
    const instanceStore = createInstanceStore([
      {
        config: {
          id: "stopped",
          workspaceUri: "file:///workspace/stopped",
          label: "Stopped Workspace",
        },
        runtime: {},
        state: "disconnected",
      },
    ]);
    const instanceController = createInstanceController();

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().spawnForWorkspace({
      toString: () => "file:///workspace/stopped",
    });

    expect(instanceController.spawn).toHaveBeenCalledWith("stopped");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Spawned OpenCode for workspace: Stopped Workspace",
    );
  });

  it("creates and spawns a new workspace instance using the current workspace name", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(54321);
    const instanceStore = createInstanceStore();
    const instanceController = createInstanceController();
    Reflect.set(vscode.workspace, "name", "Project Alpha");

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().spawnForWorkspace({
      toString: () => "file:///workspace/new",
    });

    expect(instanceStore.get("54321")).toEqual({
      config: {
        id: "54321",
        workspaceUri: "file:///workspace/new",
        label: "OpenCode (Project Alpha)",
      },
      runtime: {},
      state: "disconnected",
    });
    expect(instanceController.spawn).toHaveBeenCalledWith("54321");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Spawned OpenCode for workspace: OpenCode (Project Alpha)",
    );

    dateNowSpy.mockRestore();
  });

  it("uses the first workspace folder when spawnForWorkspace is called without a uri", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(77777);
    const instanceStore = createInstanceStore();
    const instanceController = createInstanceController();
    vscode.workspace.workspaceFolders = [
      { uri: { toString: () => "file:///workspace/folder" } },
    ];

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().spawnForWorkspace();

    expect(instanceStore.get("77777")?.config.workspaceUri).toBe(
      "file:///workspace/folder",
    );

    dateNowSpy.mockRestore();
  });

  it("logs and shows errors when spawnForWorkspace fails", async () => {
    const outputChannel = createOutputChannel();
    const instanceStore = createInstanceStore();
    const instanceController = createInstanceController();
    vi.mocked(instanceController.spawn).mockRejectedValue(
      new Error("spawn failed"),
    );
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(90001);

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel,
      tmuxManager: undefined,
    });

    await getCommandHandlers().spawnForWorkspace({
      toString: () => "file:///workspace/error",
    });

    expect(outputChannel.error).toHaveBeenCalledWith(
      "Failed to spawn for workspace: spawn failed",
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to spawn for workspace: spawn failed",
    );

    dateNowSpy.mockRestore();
  });

  it("shows the instance picker when selectInstance is invoked", () => {
    const instanceQuickPick = createInstanceQuickPick();

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    getCommandHandlers().selectInstance();

    expect(instanceQuickPick.show).toHaveBeenCalledTimes(1);
  });

  it("switches tmux sessions and focuses the terminal", async () => {
    const provider = createProvider();

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().switchTmuxSession("tmux-1");

    expect(provider.switchToTmuxSession).toHaveBeenCalledWith("tmux-1");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.focus",
    );
  });

  it("ignores switchTmuxSession and killTmuxSession when required inputs are missing", async () => {
    const provider = createProvider();

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    const handlers = getCommandHandlers();
    await handlers.switchTmuxSession();
    await handlers.killTmuxSession();

    expect(provider.switchToTmuxSession).not.toHaveBeenCalled();
    expect(provider.killTmuxSession).not.toHaveBeenCalled();
  });

  it("creates and kills tmux sessions through the provider", async () => {
    const provider = createProvider();

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    const handlers = getCommandHandlers();
    await handlers.createTmuxSession();
    await handlers.killTmuxSession("tmux-2");

    expect(provider.createTmuxSession).toHaveBeenCalledTimes(1);
    expect(provider.killTmuxSession).toHaveBeenCalledWith("tmux-2");
  });

  it("switches to the native shell when a provider is available", async () => {
    const provider = createProvider();

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().switchNativeShell();

    expect(provider.switchToNativeShell).toHaveBeenCalledTimes(1);
  });

  it("warns when browseTmuxSessions has no tmux manager or provider", async () => {
    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().browseTmuxSessions();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "tmux is not available or the terminal provider is not initialized",
    );
  });

  it("reports when no tmux sessions are found while browsing", async () => {
    const provider = createProvider();
    const tmuxManager = createTmuxManager([]);

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager,
    });

    await getCommandHandlers().browseTmuxSessions();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "No tmux sessions found",
    );
  });

  it("returns early when tmux session browsing is cancelled", async () => {
    const provider = createProvider();
    const tmuxManager = createTmuxManager([
      { id: "tmux-a", name: "alpha", workspace: "/a" },
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager,
    });

    await getCommandHandlers().browseTmuxSessions();

    expect(provider.switchToTmuxSession).not.toHaveBeenCalled();
  });

  it("reports when the picked tmux session is already active", async () => {
    const provider = createProvider();
    const tmuxManager = createTmuxManager([
      {
        id: "tmux-active",
        name: "active",
        workspace: "/active",
        isActive: true,
      },
      { id: "tmux-z", name: "zeta", workspace: "/zeta" },
    ]);
    const instanceStore = createInstanceStore([
      {
        config: { id: "instance-1", label: "Instance 1" },
        runtime: { tmuxSessionId: "tmux-active" },
        state: "connected",
      },
    ]);
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
      const quickPickItems = items as Array<{
        label: string;
        session: SessionSummary;
      }>;
      expect(quickPickItems[0]?.session.id).toBe("tmux-active");
      return quickPickItems[0];
    });

    registerTmuxSessionCommands({
      provider,
      instanceStore,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager,
    });

    await getCommandHandlers().browseTmuxSessions();

    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        placeHolder: "Current: tmux-active — select a session to switch",
      }),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Already attached to session "active"',
    );
    expect(provider.switchToTmuxSession).not.toHaveBeenCalled();
  });

  it("switches to the selected tmux session from the browser", async () => {
    const provider = createProvider();
    const tmuxManager = createTmuxManager([
      { id: "tmux-b", name: "beta", workspace: "/beta" },
      { id: "tmux-a", name: "alpha", workspace: "/alpha" },
    ]);
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
      const quickPickItems = items as Array<{
        label: string;
        session: SessionSummary;
      }>;
      expect(quickPickItems.map((item) => item.label)).toEqual([
        "alpha",
        "beta",
      ]);
      return quickPickItems[1];
    });

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager,
    });

    await getCommandHandlers().browseTmuxSessions();

    expect(provider.switchToTmuxSession).toHaveBeenCalledWith("tmux-b");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.focus",
    );
  });

  it("browses and switches zellij sessions when zellij is the active backend", async () => {
    const provider = createProvider();
    const tmuxManager = createTmuxManager([
      { id: "tmux-a", name: "tmux", workspace: "/tmux" },
    ]);
    const zellijManager = createZellijManager([
      { id: "zellij-b", name: "beta", workspace: "/beta" },
      { id: "zellij-a", name: "alpha", workspace: "/alpha" },
    ]);
    const instanceStore = createInstanceStore([
      {
        config: { id: "instance-1", label: "Instance 1" },
        runtime: {
          terminalBackend: "zellij",
          zellijSessionId: "zellij-a",
        },
        state: "connected",
      },
    ]);
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
      const quickPickItems = items as Array<{
        label: string;
        session: SessionSummary;
      }>;
      expect(quickPickItems.map((item) => item.label)).toEqual([
        "alpha",
        "beta",
      ]);
      return quickPickItems[1];
    });

    registerTmuxSessionCommands({
      provider,
      instanceStore,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager,
      zellijManager,
    });

    await getCommandHandlers().browseTmuxSessions();

    expect(tmuxManager.discoverSessions).not.toHaveBeenCalled();
    expect(zellijManager.discoverSessions).toHaveBeenCalledTimes(1);
    expect(provider.switchToZellijSession).toHaveBeenCalledWith("zellij-b");
    expect(provider.switchToTmuxSession).not.toHaveBeenCalled();
  });

  it("logs and shows errors when browsing tmux sessions fails", async () => {
    const provider = createProvider();
    const outputChannel = createOutputChannel();
    const tmuxManager = createTmuxManager();
    vi.mocked(tmuxManager.discoverSessions).mockRejectedValue(
      new Error("tmux failed"),
    );

    registerTmuxSessionCommands({
      provider,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel,
      tmuxManager,
    });

    await getCommandHandlers().browseTmuxSessions();

    expect(outputChannel.error).toHaveBeenCalledWith(
      "Failed to browse tmux sessions: tmux failed",
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to browse tmux sessions: tmux failed",
    );
  });

  it("kills the active native shell, removes it, and activates the next instance", async () => {
    const instanceController = createInstanceController();
    const instanceStore = createInstanceStore([
      {
        config: { id: "native-1", label: "Native One" },
        runtime: {},
        state: "connected",
      },
      {
        config: { id: "native-2", label: "Native Two" },
        runtime: {},
        state: "connected",
      },
    ]);

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().killNativeShell("native-1");

    expect(instanceController.kill).toHaveBeenCalledWith("native-1");
    expect(instanceStore.get("native-1")).toBeUndefined();
    expect(instanceStore.getActive().config.id).toBe("native-2");
  });

  it("kills an inactive native shell without changing the active instance", async () => {
    const instanceController = createInstanceController();
    const instanceStore = createInstanceStore([
      {
        config: { id: "native-1", label: "Native One" },
        runtime: {},
        state: "connected",
      },
      {
        config: { id: "native-2", label: "Native Two" },
        runtime: {},
        state: "connected",
      },
    ]);
    instanceStore.setActive("native-2");

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().killNativeShell("native-1");

    expect(instanceController.kill).toHaveBeenCalledWith("native-1");
    expect(instanceStore.getActive().config.id).toBe("native-2");
  });

  it("ignores killNativeShell when required dependencies are missing", async () => {
    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore: undefined,
      instanceController: undefined,
      instanceQuickPick: undefined,
      outputChannel: undefined,
      tmuxManager: undefined,
    });

    await getCommandHandlers().killNativeShell("native-1");

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("logs errors when killNativeShell fails", async () => {
    const outputChannel = createOutputChannel();
    const instanceController = createInstanceController();
    vi.mocked(instanceController.kill).mockRejectedValue(
      new Error("kill failed"),
    );
    const instanceStore = createInstanceStore([
      {
        config: { id: "native-1", label: "Native One" },
        runtime: {},
        state: "connected",
      },
    ]);

    registerTmuxSessionCommands({
      provider: undefined,
      instanceStore,
      instanceController,
      instanceQuickPick: undefined,
      outputChannel,
      tmuxManager: undefined,
    });

    await getCommandHandlers().killNativeShell("native-1");

    expect(outputChannel.error).toHaveBeenCalledWith(
      "[killNativeShell] Failed to kill native shell native-1: kill failed",
    );
  });
});
