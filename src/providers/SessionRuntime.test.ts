import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import type * as vscodeTypes from "../test/mocks/vscode";
import { SessionRuntime } from "./SessionRuntime";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { PortManager } from "../services/PortManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceStore } from "../services/InstanceStore";
import {
  TmuxSessionManager,
  TmuxUnavailableError,
} from "../services/TmuxSessionManager";
import { AiToolOperatorRegistry } from "../services/aiTools/AiToolOperatorRegistry";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

vi.mock("node-pty", async () => {
  const actual = await vi.importActual("../test/mocks/node-pty");
  return actual;
});

describe("SessionRuntime - Workspace Session Resolution", () => {
  const flushAsyncWork = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  let sessionRuntime: SessionRuntime;
  let mockTmuxSessionManager: TmuxSessionManager;
  let mockTerminalManager: TerminalManager;
  let mockPortManager: PortManager;
  let mockAiToolRegistry: AiToolOperatorRegistry;
  let mockContextSharingService: ContextSharingService;
  let instanceStore: InstanceStore;
  let mockLogger: OutputChannelService;
  let postMessageMock: ReturnType<typeof vi.fn<(message: unknown) => void>>;
  let onActiveInstanceChangedMock: ReturnType<
    typeof vi.fn<(instanceId: string) => void>
  >;
  let requestStartOpenCodeMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let showAiToolSelectorMock: ReturnType<
    typeof vi.fn<
      (sessionId: string, sessionName: string, forceShow?: boolean) => void
    >
  >;
  let exitHandler:
    | ((id: string) => void)
    | undefined;
  let mockCallbacks: {
    postMessage: (message: unknown) => void;
    onActiveInstanceChanged: (instanceId: string) => void;
    requestStartOpenCode: () => Promise<void>;
    showAiToolSelector: (
      sessionId: string,
      sessionName: string,
      forceShow?: boolean,
    ) => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    OutputChannelService.resetInstance();

    // Setup workspace folders
    vscode.workspace.workspaceFolders = [
      {
        uri: { fsPath: "/workspace/project-a" },
        name: "project-a",
        index: 0,
      },
    ];

    // Create mock tmux session manager with all required methods
    mockTmuxSessionManager = {
      listPanes: vi.fn(),
      listWindows: vi.fn(),
      discoverSessions: vi.fn(),
      createWindow: vi.fn(),
      createSession: vi.fn(),
      selectWindow: vi.fn(),
      splitPane: vi.fn(),
      ensureSession: vi.fn(),
      nextWindow: vi.fn(),
      prevWindow: vi.fn(),
      zoomPane: vi.fn(),
      killPane: vi.fn(),
      killWindow: vi.fn(),
      killSession: vi.fn(),
      registerSessionHooks: vi.fn(),
      setMouseOn: vi.fn(),
      showBuffer: vi.fn(),
      onExternalPaneChange: vi.fn(),
      selectPane: vi.fn(),
      sendTextToPane: vi.fn(),
      listVisiblePaneGeometry: vi.fn(),
      listSessions: vi.fn(),
      findSessionForWorkspace: vi.fn(),
      getSessionInfo: vi.fn(),
    } as unknown as TmuxSessionManager;

    mockTerminalManager = {
      getByInstance: vi.fn(),
      getTerminal: vi.fn(),
      killByInstance: vi.fn(),
      killTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
      createTerminal: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn((callback: (id: string) => void) => {
        exitHandler = callback;
        return { dispose: vi.fn() };
      }),
    } as unknown as TerminalManager;

    mockPortManager = {
      releaseTerminalPorts: vi.fn(),
      assignPortToTerminal: vi.fn(),
    } as unknown as PortManager;

    mockAiToolRegistry = {
      getForConfig: vi.fn(),
      getByToolName: vi.fn(),
      matchesName: vi.fn((tool, toolName) => tool.name === toolName),
    } as unknown as AiToolOperatorRegistry;

    mockContextSharingService = {
      getCurrentContext: vi.fn(),
    } as unknown as ContextSharingService;

    // Create real instance store (following pattern from TerminalProvider.test.ts)
    instanceStore = new InstanceStore();

    // Create mock logger
    mockLogger = OutputChannelService.getInstance();
    vi.spyOn(mockLogger, "warn");
    vi.spyOn(mockLogger, "error");
    vi.spyOn(mockLogger, "info");

    // Create mock callbacks
    postMessageMock = vi.fn();
    onActiveInstanceChangedMock = vi.fn();
    requestStartOpenCodeMock = vi.fn().mockResolvedValue(undefined);
    showAiToolSelectorMock = vi.fn();
    mockCallbacks = {
      postMessage: (message) => {
        postMessageMock(message);
      },
      onActiveInstanceChanged: (instanceId) => {
        onActiveInstanceChangedMock(instanceId);
      },
      requestStartOpenCode: () => requestStartOpenCodeMock(),
      showAiToolSelector: (sessionId, sessionName, forceShow) => {
        showAiToolSelectorMock(sessionId, sessionName, forceShow);
      },
    };

    // Create SessionRuntime instance with proper typing
    sessionRuntime = new SessionRuntime(
      mockTerminalManager,
      {} as OutputCaptureManager,
      undefined as unknown as OpenCodeApiClient,
      mockPortManager,
      mockTmuxSessionManager,
      instanceStore,
      mockLogger,
      mockContextSharingService,
      mockAiToolRegistry,
      mockCallbacks,
    );

    exitHandler = undefined;
  });

  afterEach(() => {
    sessionRuntime.dispose();
    OutputChannelService.resetInstance();
  });

  const upsertInstance = (options?: {
    id?: string;
    workspaceUri?: string;
    tmuxSessionId?: string;
    selectedAiTool?: string;
  }) => {
    const id = options?.id ?? "default";
    instanceStore.upsert({
      config: {
        id,
        workspaceUri: options?.workspaceUri,
        selectedAiTool: options?.selectedAiTool,
      },
      runtime: {
        terminalKey: id,
        tmuxSessionId: options?.tmuxSessionId,
      },
      state: "connected",
    });
    return id;
  };

  describe("checkPaneChanges", () => {
    it("falls back to discovered sessions and posts active session metadata", async () => {
      vi.mocked(mockTmuxSessionManager.discoverSessions).mockResolvedValue([
        { id: "fallback-session", isActive: true },
      ] as unknown as Awaited<
        ReturnType<TmuxSessionManager["discoverSessions"]>
      >);
      vi.mocked(mockTmuxSessionManager.listPanes).mockResolvedValue([
        { paneId: "%1", isActive: true, currentCommand: "/bin/bash" },
      ] as unknown as Awaited<ReturnType<TmuxSessionManager["listPanes"]>>);
      vi.mocked(mockTmuxSessionManager.listWindows).mockResolvedValue([
        { windowId: "@1", isActive: true, index: 1, name: "main" },
      ] as unknown as Awaited<ReturnType<TmuxSessionManager["listWindows"]>>);

      await (
        sessionRuntime as unknown as { checkPaneChanges: () => Promise<void> }
      ).checkPaneChanges();

      expect(postMessageMock).toHaveBeenCalledWith({
        type: "activeSession",
        sessionName: "fallback-session",
        sessionId: "fallback-session",
        windowIndex: 1,
        windowName: "main",
        canKillPane: false,
      });

      postMessageMock.mockClear();
      await (
        sessionRuntime as unknown as { checkPaneChanges: () => Promise<void> }
      ).checkPaneChanges();
      expect(postMessageMock).not.toHaveBeenCalled();
    });

    it("posts updates when window focus changes", async () => {
      upsertInstance({ tmuxSessionId: "workspace-session" });
      (
        sessionRuntime as unknown as { knownActiveWindowId?: string }
      ).knownActiveWindowId = "@1";

      vi.mocked(mockTmuxSessionManager.listPanes).mockResolvedValue([
        { paneId: "%1", isActive: false, currentCommand: "zsh" },
        { paneId: "%2", isActive: true, currentCommand: "claude" },
      ] as unknown as Awaited<ReturnType<TmuxSessionManager["listPanes"]>>);
      vi.mocked(mockTmuxSessionManager.listWindows).mockResolvedValue([
        { windowId: "@2", isActive: true, index: 2, name: "agent" },
        { windowId: "@1", isActive: false, index: 1, name: "main" },
      ] as unknown as Awaited<ReturnType<TmuxSessionManager["listWindows"]>>);

      await (
        sessionRuntime as unknown as { checkPaneChanges: () => Promise<void> }
      ).checkPaneChanges();

      expect(postMessageMock).toHaveBeenCalledWith({
        type: "activeSession",
        sessionName: "workspace-session",
        sessionId: "workspace-session",
        windowIndex: 2,
        windowName: "agent",
        canKillPane: true,
      });
    });

    it("silently ignores tmux polling errors", async () => {
      upsertInstance({ tmuxSessionId: "workspace-session" });
      vi.mocked(mockTmuxSessionManager.listPanes).mockRejectedValue(
        new Error("tmux unavailable"),
      );

      await expect(
        (
          sessionRuntime as unknown as { checkPaneChanges: () => Promise<void> }
        ).checkPaneChanges(),
      ).resolves.toBeUndefined();
      expect(postMessageMock).not.toHaveBeenCalled();
    });
  });

  describe("terminal exit restoration", () => {
    it("switches to a replacement workspace tmux session when the attached tmux process exits", async () => {
      upsertInstance({
        tmuxSessionId: "workspace-session",
        workspaceUri: "file:///workspace/project-a",
      });
      (sessionRuntime as unknown as { isStarted: boolean }).isStarted = true;
      (
        sessionRuntime as unknown as { selectedTmuxSessionId?: string }
      ).selectedTmuxSessionId = "workspace-session";

      vi.mocked(
        mockTmuxSessionManager.findSessionForWorkspace,
      ).mockResolvedValue({
        id: "replacement-session",
      } as Awaited<ReturnType<TmuxSessionManager["findSessionForWorkspace"]>>);

      const switchSpy = vi
        .spyOn(sessionRuntime, "switchToTmuxSession")
        .mockResolvedValue();

      sessionRuntime.reconnectListeners();
      expect(exitHandler).toBeDefined();

      exitHandler?.("default");

      await flushAsyncWork();

      expect(switchSpy).toHaveBeenCalledWith("replacement-session");

      expect(instanceStore.get("default")?.runtime.tmuxSessionId).toBeUndefined();
      expect(mockPortManager.releaseTerminalPorts).toHaveBeenCalledWith(
        "default",
      );
      expect(postMessageMock).not.toHaveBeenCalledWith({
        type: "terminalExited",
      });
    });

    it("falls back to native shell when the attached tmux process exits with no replacement", async () => {
      upsertInstance({
        tmuxSessionId: "workspace-session",
        workspaceUri: "file:///workspace/project-a",
      });
      (sessionRuntime as unknown as { isStarted: boolean }).isStarted = true;

      const nativeShellSpy = vi
        .spyOn(sessionRuntime, "switchToNativeShell")
        .mockResolvedValue();

      sessionRuntime.reconnectListeners();
      expect(exitHandler).toBeDefined();

      exitHandler?.("default");

      await flushAsyncWork();

      expect(nativeShellSpy).toHaveBeenCalled();

      expect(instanceStore.get("default")?.runtime.tmuxSessionId).toBeUndefined();
      expect(mockPortManager.releaseTerminalPorts).toHaveBeenCalledWith(
        "default",
      );
      expect(postMessageMock).not.toHaveBeenCalledWith({
        type: "terminalExited",
      });
    });
  });

  describe("session and shell switching", () => {
    it("switches to a tmux session with a preferred tool and persists the selection", async () => {
      upsertInstance({
        id: "workspace-instance",
        workspaceUri: "file:///workspace/project-a",
      });

      const switchToInstanceSpy = vi
        .spyOn(sessionRuntime, "switchToInstance")
        .mockResolvedValue();
      const startMonitoringSpy = vi
        .spyOn(
          sessionRuntime as unknown as {
            startExternalChangeMonitoring: (sessionId: string) => Promise<void>;
          },
          "startExternalChangeMonitoring",
        )
        .mockResolvedValue();

      await sessionRuntime.switchToTmuxSessionWithTool(
        "project-a",
        "preferred-tool",
      );

      expect(mockTmuxSessionManager.registerSessionHooks).toHaveBeenCalledWith(
        "project-a",
        process.pid,
      );
      expect(startMonitoringSpy).toHaveBeenCalledWith("project-a");
      expect(switchToInstanceSpy).toHaveBeenCalledWith("workspace-instance", {
        forceRestart: true,
        preferredToolName: "preferred-tool",
      });
      expect(sessionRuntime.getSelectedTmuxSessionId()).toBe("project-a");
      expect(
        instanceStore.get("workspace-instance")?.config.selectedAiTool,
      ).toBe("preferred-tool");
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "activeSession",
        sessionName: "project-a",
        sessionId: "project-a",
      });
    });

    it("switches back to native shell and clears the stored tmux session", async () => {
      upsertInstance({
        tmuxSessionId: "workspace-session",
        workspaceUri: "file:///workspace/project-a",
      });

      const switchToInstanceSpy = vi
        .spyOn(sessionRuntime, "switchToInstance")
        .mockResolvedValue();

      await sessionRuntime.switchToNativeShell();

      expect(sessionRuntime.getSelectedTmuxSessionId()).toBeUndefined();
      expect(
        instanceStore.get("default")?.runtime.tmuxSessionId,
      ).toBeUndefined();
      expect(switchToInstanceSpy).toHaveBeenCalledWith("default", {
        forceRestart: true,
      });
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "activeSession",
      });
    });
  });

  describe("resolveInstanceIdFromSessionId", () => {
    it("prefers direct instance IDs, then tmux mappings, then workspace name mappings", () => {
      upsertInstance({
        id: "direct-instance",
        workspaceUri: "file:///workspace/direct",
      });
      upsertInstance({ id: "tmux-instance", tmuxSessionId: "tmux-session" });
      upsertInstance({
        id: "workspace-instance",
        workspaceUri: "file:///workspace/project-a",
      });

      expect(
        sessionRuntime.resolveInstanceIdFromSessionId("direct-instance"),
      ).toBe("direct-instance");
      expect(
        sessionRuntime.resolveInstanceIdFromSessionId("tmux-session"),
      ).toBe("tmux-instance");
      expect(sessionRuntime.resolveInstanceIdFromSessionId("project-a")).toBe(
        "workspace-instance",
      );
    });

    it("falls back to the active instance when no mapping exists or no store is available", () => {
      upsertInstance({
        id: "active-instance",
        workspaceUri: "not-a-valid-uri",
      });
      instanceStore.setActive("active-instance");
      (
        sessionRuntime as unknown as { activeInstanceId: string }
      ).activeInstanceId = "active-instance";

      expect(
        sessionRuntime.resolveInstanceIdFromSessionId("missing-session"),
      ).toBe("active-instance");

      const runtimeWithoutStore = new SessionRuntime(
        mockTerminalManager,
        {} as OutputCaptureManager,
        undefined as unknown as OpenCodeApiClient,
        mockPortManager,
        mockTmuxSessionManager,
        undefined,
        mockLogger,
        {} as ContextSharingService,
        mockAiToolRegistry,
        mockCallbacks,
      );

      expect(
        runtimeWithoutStore.resolveInstanceIdFromSessionId("anything"),
      ).toBe("opencode-main");

      runtimeWithoutStore.dispose();
    });
  });

  describe("instance switching and startup", () => {
    it("reuses an existing terminal for an instance and restores HTTP listeners", async () => {
      upsertInstance({ id: "instance-2", selectedAiTool: "preferred-tool" });
      sessionRuntime.setLastKnownTerminalSize(120, 40);

      vi.mocked(mockTerminalManager.getByInstance).mockReturnValue({
        port: 4312,
      } as ReturnType<TerminalManager["getByInstance"]>);
      vi.spyOn(
        sessionRuntime as unknown as {
          resolveStoredTool: (
            instanceId?: string,
          ) => { name: string } | undefined;
        },
        "resolveStoredTool",
      ).mockReturnValue({ name: "preferred-tool" });
      vi.spyOn(sessionRuntime, "pollForHttpReadiness").mockResolvedValue();
      vi.mocked(mockAiToolRegistry.getForConfig).mockReturnValue({
        supportsHttpApi: vi.fn(() => true),
      } as never);

      await sessionRuntime.switchToInstance("instance-2");

      expect(mockPortManager.releaseTerminalPorts).toHaveBeenCalledWith(
        "default",
      );
      expect(mockPortManager.releaseTerminalPorts).toHaveBeenCalledWith(
        "instance-2",
      );
      expect(postMessageMock).toHaveBeenCalledWith({ type: "clearTerminal" });
      expect(sessionRuntime.getActiveInstanceId()).toBe("instance-2");
      expect(sessionRuntime.isStartedFlag()).toBe(true);
      expect(mockTerminalManager.resizeTerminal).toHaveBeenCalledWith(
        "instance-2",
        120,
        40,
      );
      expect(sessionRuntime.getApiClient()).toBeDefined();
    });

    it("resolves active terminal backend ids from non-tmux runtime terminal keys", async () => {
      instanceStore.upsert({
        config: { id: "native-instance" },
        runtime: { terminalKey: "native-terminal-key" },
        state: "connected",
      });
      instanceStore.setActive("native-instance");
      (
        sessionRuntime as unknown as { activeInstanceId: string }
      ).activeInstanceId = "native-instance";

      expect(sessionRuntime.getActiveInstanceId()).toBe("native-instance");
      expect(sessionRuntime.getActiveTerminalId()).toBe("native-terminal-key");
    });

    it("force restarts an existing instance by killing its terminal and requesting a relaunch", async () => {
      upsertInstance({ id: "instance-2" });
      vi.mocked(mockTerminalManager.getByInstance).mockReturnValue({
        port: 4312,
      } as ReturnType<TerminalManager["getByInstance"]>);

      await sessionRuntime.switchToInstance("instance-2", {
        forceRestart: true,
        preferredToolName: "preferred-tool",
      });

      expect(mockTerminalManager.killByInstance).toHaveBeenCalledWith(
        "instance-2",
      );
      expect(mockTerminalManager.killTerminal).toHaveBeenCalledWith(
        "instance-2",
      );
      expect(requestStartOpenCodeMock).toHaveBeenCalled();
    });

    it("starts a native shell session and updates the instance store without tmux metadata", async () => {
      upsertInstance({ workspaceUri: "file:///workspace/project-a" });
      (
        sessionRuntime as unknown as { forceNativeShellNextStart: boolean }
      ).forceNativeShellNextStart = true;

      await sessionRuntime.startOpenCode();

      expect(mockTerminalManager.createTerminal).toHaveBeenCalledWith(
        "default",
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        "default",
        "/workspace/project-a",
      );
      expect(sessionRuntime.isStartedFlag()).toBe(true);
      expect(postMessageMock).toHaveBeenCalledWith({ type: "activeSession" });
      expect(
        instanceStore.get("default")?.runtime.tmuxSessionId,
      ).toBeUndefined();
    });

    it("launches the selected tool directly when tmux is unavailable", async () => {
      upsertInstance({
        workspaceUri: "file:///workspace/project-a",
        selectedAiTool: "preferred-tool",
      });
      sessionRuntime = new SessionRuntime(
        mockTerminalManager,
        {} as OutputCaptureManager,
        undefined as unknown as OpenCodeApiClient,
        mockPortManager,
        undefined,
        instanceStore,
        mockLogger,
        mockContextSharingService,
        mockAiToolRegistry,
        mockCallbacks,
      );
      vi.spyOn(
        sessionRuntime as unknown as {
          resolveToolForStartup: () => Promise<{ name: string }>;
        },
        "resolveToolForStartup",
      ).mockResolvedValue({ name: "preferred-tool" });
      vi.mocked(mockAiToolRegistry.getForConfig).mockReturnValue({
        getLaunchCommand: vi.fn(() => "run-tool"),
        supportsHttpApi: vi.fn(() => true),
      } as never);
      vi.mocked(mockPortManager.assignPortToTerminal).mockReturnValue(4312);
      vi.spyOn(sessionRuntime, "pollForHttpReadiness").mockResolvedValue();

      await sessionRuntime.startOpenCode();

      expect(mockTerminalManager.createTerminal).toHaveBeenCalledWith(
        "default",
        "run-tool",
        {
          _EXTENSION_OPENCODE_PORT: "4312",
          OPENCODE_CALLER: "vscode",
        },
        4312,
        undefined,
        undefined,
        "default",
        "/workspace/project-a",
      );
      expect(instanceStore.get("default")?.runtime.tmuxSessionId).toBeUndefined();
      expect(instanceStore.get("default")?.runtime.port).toBe(4312);
    });

    it("starts a tmux-backed tool session with HTTP enabled", async () => {
      upsertInstance({ workspaceUri: "file:///workspace/project-a" });
      vi.spyOn(
        sessionRuntime as unknown as {
          resolveToolForStartup: () => Promise<{ name: string }>;
        },
        "resolveToolForStartup",
      ).mockResolvedValue({ name: "preferred-tool" });
      vi.spyOn(
        sessionRuntime as unknown as {
          startExternalChangeMonitoring: (sessionId: string) => Promise<void>;
        },
        "startExternalChangeMonitoring",
      ).mockResolvedValue();
      vi.spyOn(sessionRuntime, "pollForHttpReadiness").mockResolvedValue();
      vi.mocked(mockTmuxSessionManager.ensureSession).mockResolvedValue({
        action: "created",
        session: {
          id: "workspace-session",
          name: "project-a",
          workspace: "/workspace/project-a",
          isActive: true,
        },
      });
      vi.mocked(mockAiToolRegistry.getForConfig).mockReturnValue({
        getLaunchCommand: vi.fn(() => "run-tool"),
        supportsHttpApi: vi.fn(() => true),
      } as never);
      vi.mocked(mockPortManager.assignPortToTerminal).mockReturnValue(4312);

      await sessionRuntime.startOpenCode();

      expect(mockTmuxSessionManager.setMouseOn).toHaveBeenCalledWith(
        "workspace-session",
      );
      expect(mockTmuxSessionManager.registerSessionHooks).toHaveBeenCalledWith(
        "workspace-session",
        process.pid,
      );
      expect(mockTerminalManager.createTerminal).toHaveBeenCalledWith(
        "default",
        "tmux attach-session -t workspace-session \\; set-option -u status off",
        {
          _EXTENSION_OPENCODE_PORT: "4312",
          OPENCODE_CALLER: "vscode",
        },
        4312,
        undefined,
        undefined,
        "default",
        "/workspace/project-a",
      );
      expect(instanceStore.get("default")?.runtime.tmuxSessionId).toBe(
        "workspace-session",
      );
      expect(instanceStore.get("default")?.runtime.port).toBe(4312);
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "activeSession",
        sessionName: "workspace-session",
        sessionId: "workspace-session",
      });
    });
  });

  describe("HTTP readiness and auto-context", () => {
    it("marks HTTP as available when the API health check succeeds", async () => {
      (
        sessionRuntime as unknown as {
          apiClient?: { healthCheck: () => Promise<boolean> };
        }
      ).apiClient = {
        healthCheck: vi.fn().mockResolvedValue(true),
      };
      vi.spyOn(
        sessionRuntime as unknown as { sendAutoContext: () => Promise<void> },
        "sendAutoContext",
      ).mockResolvedValue();

      await sessionRuntime.pollForHttpReadiness();

      expect(sessionRuntime.isHttpAvailable()).toBe(true);
    });

    it("sends auto-context through the active operator when HTTP is ready", async () => {
      (sessionRuntime as unknown as { httpAvailable: boolean }).httpAvailable =
        true;
      (
        sessionRuntime as unknown as { activeTool?: { name: string } }
      ).activeTool = {
        name: "preferred-tool",
      };
      (
        sessionRuntime as unknown as {
          apiClient?: { appendPrompt: (value: string) => Promise<void> };
        }
      ).apiClient = {
        appendPrompt: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(mockContextSharingService.getCurrentContext).mockReturnValue({
        filePath: "src/providers/SessionRuntime.ts",
        selectionStart: 10,
        selectionEnd: 20,
      } as ReturnType<ContextSharingService["getCurrentContext"]>);
      vi.mocked(mockAiToolRegistry.getForConfig).mockReturnValue({
        supportsAutoContext: vi.fn(() => true),
        formatFileReference: vi.fn(
          () => "@src/providers/SessionRuntime.ts#L10-L20",
        ),
      } as never);

      await (
        sessionRuntime as unknown as { sendAutoContext: () => Promise<void> }
      ).sendAutoContext();

      expect(
        (
          sessionRuntime as unknown as {
            apiClient?: { appendPrompt: ReturnType<typeof vi.fn> };
          }
        ).apiClient?.appendPrompt,
      ).toHaveBeenCalledWith("@src/providers/SessionRuntime.ts#L10-L20");
    });
  });

  describe("workspace and tmux resolution helpers", () => {
    it("prefers instance workspace, then workspace folder, then home directory for startup", () => {
      upsertInstance({
        workspaceUri: "file:///workspace/project-a",
      });
      expect(sessionRuntime.resolveStartupWorkspacePath()).toEqual({
        workspacePath: "/workspace/project-a",
        isWorkspaceScoped: true,
      });

      instanceStore.upsert({
        config: { id: "default", workspaceUri: undefined },
        runtime: { terminalKey: "default" },
        state: "connected",
      });
      expect(sessionRuntime.resolveStartupWorkspacePath()).toEqual({
        workspacePath: "/workspace/project-a",
        isWorkspaceScoped: true,
      });

      vscode.workspace.workspaceFolders = undefined;
      expect(sessionRuntime.resolveStartupWorkspacePath()).toEqual({
        workspacePath: os.homedir(),
        isWorkspaceScoped: false,
      });
    });

    it("ensures workspace sessions and handles tmux resolution failures gracefully", async () => {
      vi.mocked(mockTmuxSessionManager.ensureSession)
        .mockResolvedValueOnce({
          action: "attached",
          session: {
            id: "workspace-session",
            name: "project-a",
            workspace: "/workspace/project-a",
            isActive: true,
          },
        })
        .mockRejectedValueOnce(new TmuxUnavailableError())
        .mockRejectedValueOnce(new Error("boom"));

      await expect(
        sessionRuntime.ensureWorkspaceSession("/workspace/project-a"),
      ).resolves.toBe("workspace-session");
      await expect(
        sessionRuntime.ensureWorkspaceSession("/workspace/project-a"),
      ).resolves.toBeUndefined();
      await expect(
        sessionRuntime.ensureWorkspaceSession("/workspace/project-a"),
      ).resolves.toBeUndefined();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("tmux session attached"),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to ensure tmux session"),
      );
    });

    it("resolves fallback tmux sessions and warns on errors", async () => {
      vi.mocked(mockTmuxSessionManager.discoverSessions)
        .mockResolvedValueOnce([
          {
            id: "session-1",
            name: "one",
            workspace: "/workspace/one",
            isActive: false,
          },
          {
            id: "session-2",
            name: "two",
            workspace: "/workspace/two",
            isActive: true,
          },
        ])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("discover failed"));

      await expect(sessionRuntime.resolveFallbackTmuxSessionId()).resolves.toBe(
        "session-2",
      );
      await expect(
        sessionRuntime.resolveFallbackTmuxSessionId(),
      ).resolves.toBeUndefined();
      await expect(
        sessionRuntime.resolveFallbackTmuxSessionId(),
      ).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to resolve fallback tmux session"),
      );
    });
  });

  describe("tmux session lifecycle helpers", () => {
    it("creates a unique tmux session name for the current workspace", async () => {
      vi.mocked(mockTmuxSessionManager.discoverSessions).mockResolvedValue([
        {
          id: "project-a",
          name: "project-a",
          workspace: "/workspace/project-a",
          isActive: true,
        },
        {
          id: "project-a-2",
          name: "project-a-2",
          workspace: "/workspace/project-a",
          isActive: false,
        },
      ] as unknown as Awaited<
        ReturnType<TmuxSessionManager["discoverSessions"]>
      >);
      vi.mocked(mockTmuxSessionManager.createSession).mockResolvedValue();

      const switchSpy = vi
        .spyOn(sessionRuntime, "switchToTmuxSessionWithTool")
        .mockResolvedValue();

      await expect(sessionRuntime.createTmuxSession()).resolves.toBe(
        "project-a-3",
      );

      expect(mockTmuxSessionManager.createSession).toHaveBeenCalledWith(
        "project-a-3",
        "/workspace/project-a",
      );
      expect(switchSpy).toHaveBeenCalledWith("project-a-3");
    });

    it("zooms the active pane", async () => {
      upsertInstance({
        tmuxSessionId: "workspace-session",
        workspaceUri: "file:///workspace/project-a",
      });
      vi.mocked(mockTmuxSessionManager.ensureSession).mockResolvedValue({
        action: "attached" as const,
        session: {
          id: "workspace-session",
          name: "project-a",
          workspace: "/workspace/project-a",
          isActive: true,
        },
      });
      vi.mocked(mockTmuxSessionManager.listPanes).mockResolvedValue([
        { paneId: "%1", isActive: false },
        { paneId: "%2", isActive: true },
      ] as unknown as Awaited<ReturnType<TmuxSessionManager["listPanes"]>>);

      await sessionRuntime.zoomTmuxPane();

      expect(mockTmuxSessionManager.zoomPane).toHaveBeenCalledWith("%2");
    });

    it("kills tmux sessions and switches to a replacement workspace session when available", async () => {
      upsertInstance({
        tmuxSessionId: "workspace-session",
        workspaceUri: "file:///workspace/project-a",
      });
      (sessionRuntime as unknown as { isStarted: boolean }).isStarted = true;
      (
        sessionRuntime as unknown as { selectedTmuxSessionId?: string }
      ).selectedTmuxSessionId = "workspace-session";

      vi.mocked(
        mockTmuxSessionManager.findSessionForWorkspace,
      ).mockResolvedValue({
        id: "replacement-session",
      } as Awaited<ReturnType<TmuxSessionManager["findSessionForWorkspace"]>>);

      const switchSpy = vi
        .spyOn(sessionRuntime, "switchToTmuxSession")
        .mockResolvedValue();

      await sessionRuntime.killTmuxSession("workspace-session");

      expect(mockTmuxSessionManager.killSession).toHaveBeenCalledWith(
        "workspace-session",
      );
      expect(
        instanceStore.get("default")?.runtime.tmuxSessionId,
      ).toBeUndefined();
      expect(switchSpy).toHaveBeenCalledWith("replacement-session");
      expect(mockPortManager.releaseTerminalPorts).toHaveBeenCalledWith(
        "default",
      );
    });

    it("falls back to native shell after killing the active tmux session when no replacement exists", async () => {
      upsertInstance({
        tmuxSessionId: "workspace-session",
        workspaceUri: "file:///workspace/project-a",
      });
      (sessionRuntime as unknown as { isStarted: boolean }).isStarted = true;

      const nativeShellSpy = vi
        .spyOn(sessionRuntime, "switchToNativeShell")
        .mockResolvedValue();

      await sessionRuntime.killTmuxSession("workspace-session");

      expect(nativeShellSpy).toHaveBeenCalled();
    });
  });

  describe("pane routing and formatting helpers", () => {
    it("routes dropped text into the pane under the drop coordinates", async () => {
      upsertInstance({
        tmuxSessionId: "workspace-session",
        workspaceUri: "file:///workspace/project-a",
      });
      vi.mocked(mockTmuxSessionManager.ensureSession).mockResolvedValue({
        action: "attached" as const,
        session: {
          id: "workspace-session",
          name: "project-a",
          workspace: "/workspace/project-a",
          isActive: true,
        },
      });
      vi.mocked(
        mockTmuxSessionManager.listVisiblePaneGeometry,
      ).mockResolvedValue([
        {
          paneId: "%1",
          paneLeft: 0,
          paneTop: 0,
          paneWidth: 10,
          paneHeight: 10,
        },
        {
          paneId: "%2",
          paneLeft: 10,
          paneTop: 0,
          paneWidth: 10,
          paneHeight: 10,
        },
      ] as unknown as Awaited<
        ReturnType<TmuxSessionManager["listVisiblePaneGeometry"]>
      >);

      await expect(
        sessionRuntime.routeDroppedTextToTmuxPane("hello", { col: 12, row: 2 }),
      ).resolves.toBe(true);

      expect(mockTmuxSessionManager.selectPane).toHaveBeenCalledWith("%2");
      expect(mockTmuxSessionManager.sendTextToPane).toHaveBeenCalledWith(
        "%2",
        "hello",
        { submit: false },
      );
    });

    it("returns false when dropped text does not intersect any pane", async () => {
      upsertInstance({ tmuxSessionId: "workspace-session" });
      vi.mocked(
        mockTmuxSessionManager.listVisiblePaneGeometry,
      ).mockResolvedValue([
        { paneId: "%1", paneLeft: 0, paneTop: 0, paneWidth: 5, paneHeight: 5 },
      ] as unknown as Awaited<
        ReturnType<TmuxSessionManager["listVisiblePaneGeometry"]>
      >);

      await expect(
        sessionRuntime.routeDroppedTextToTmuxPane("hello", {
          col: 20,
          row: 20,
        }),
      ).resolves.toBe(false);
      expect(mockTmuxSessionManager.selectPane).not.toHaveBeenCalled();
    });

    it("uses the active operator for dropped files, file references, and pasted images", () => {
      (
        sessionRuntime as unknown as { activeTool?: { name: string } }
      ).activeTool = {
        name: "preferred-tool",
      };
      vi.mocked(mockAiToolRegistry.getForConfig).mockReturnValue({
        formatDroppedFiles: vi.fn(() => "@a @b"),
        formatFileReference: vi.fn(() => "@file.ts#L1-L5"),
        formatPastedImage: vi.fn(() => "@image.png"),
      } as never);

      expect(
        sessionRuntime.formatDroppedFiles(["a", "b"], { useAtSyntax: true }),
      ).toBe("@a @b");
      expect(
        sessionRuntime.formatFileReference({
          path: "file.ts",
          selectionStart: 1,
          selectionEnd: 5,
        }),
      ).toBe("@file.ts#L1-L5");
      expect(sessionRuntime.formatPastedImage("image.png")).toBe("@image.png");
    });
  });
});
