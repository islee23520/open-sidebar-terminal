import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExtensionLifecycle } from "./ExtensionLifecycle";
import { TerminalDashboardProvider } from "../providers/TerminalDashboardProvider";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceRegistry } from "../services/InstanceRegistry";
import { InstanceStore } from "../services/InstanceStore";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { TmuxSessionManager } from "../services/TmuxSessionManager";
import type * as vscodeTypes from "../test/mocks/vscode";

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

describe("ExtensionLifecycle", () => {
  let lifecycle: ExtensionLifecycle;
  let mockContext: any;

  const getRegisteredCommandHandler = <T extends Function>(
    commandId: string,
  ): T => {
    const commandCall = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find((call) => call[0] === commandId);

    expect(commandCall).toBeDefined();
    return commandCall?.[1] as T;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    OutputChannelService.resetInstance();
    vi.spyOn(TmuxSessionManager.prototype, "isAvailable").mockResolvedValue(
      true,
    );
    lifecycle = new ExtensionLifecycle();
    mockContext = new vscode.ExtensionContext();
  });

  describe("activate", () => {
    it("should initialize terminal manager", async () => {
      await lifecycle.activate(mockContext);

      expect(mockContext.subscriptions.length).toBeGreaterThan(0);
    });

    it("should register webview provider", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
        "opencodeTui",
        expect.any(Object),
        expect.objectContaining({
          webviewOptions: { retainContextWhenHidden: true },
        }),
      );

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "opencodeTui.openTerminalManager",
        expect.any(Function),
      );
    });

    it("should skip tmux dashboard registration when tmux is unavailable", async () => {
      vi.spyOn(TmuxSessionManager.prototype, "isAvailable").mockResolvedValue(
        false,
      );

      await lifecycle.activate(mockContext);

      expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
        "opencodeTui",
        expect.any(Object),
        expect.objectContaining({
          webviewOptions: { retainContextWhenHidden: true },
        }),
      );
      expect(
        vscode.window.registerWebviewViewProvider,
      ).not.toHaveBeenCalledWith("opencodeTui.tmuxSessions", expect.anything());
    });

    it("should register commands", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "opencodeTui.start",
        expect.any(Function),
      );
    });

    it("should initialize core services without creating a status bar item", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.window.createOutputChannel).toHaveBeenCalledWith(
        "OpenCode Sidebar TUI",
        { log: true },
      );
    });

    it("should initialize ContextManager with OutputChannelService", async () => {
      await lifecycle.activate(mockContext);

      const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
        .results[0].value;
      expect(outputChannel.info).toHaveBeenCalledWith(
        expect.stringContaining("ContextManager initialized"),
      );
    });

    it("should register code actions provider for all languages", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.languages.registerCodeActionsProvider).toHaveBeenCalledWith(
        "*",
        expect.any(Object),
        expect.objectContaining({
          providedCodeActionKinds: expect.any(Array),
        }),
      );
    });

    it("should hydrate the instance registry and wire terminal close cleanup", async () => {
      const hydrateSpy = vi.spyOn(InstanceRegistry.prototype, "hydrate");
      const cleanupSpy = vi.spyOn(OutputCaptureManager.prototype, "cleanup");

      await lifecycle.activate(mockContext);

      expect(hydrateSpy).toHaveBeenCalledTimes(1);
      expect(hydrateSpy.mock.calls[0]?.[0]).toBeInstanceOf(InstanceStore);

      const closeListener = vi.mocked(vscode.window.onDidCloseTerminal).mock
        .calls[0]?.[0] as (terminal: unknown) => void;
      const terminal = { name: "closed-terminal" };

      closeListener(terminal);

      expect(cleanupSpy).toHaveBeenCalledWith(terminal);
    });

    it("should log native shell fallback when tmux is unavailable", async () => {
      vi.spyOn(TmuxSessionManager.prototype, "isAvailable").mockResolvedValue(
        false,
      );

      await lifecycle.activate(mockContext);

      const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
        .results[0].value;
      expect(outputChannel.info).toHaveBeenCalledWith(
        expect.stringContaining("tmux not detected"),
      );
    });

    it("should open the terminal dashboard through the registered command", async () => {
      const showSpy = vi
        .spyOn(TerminalDashboardProvider.prototype, "show")
        .mockImplementation(() => undefined);

      await lifecycle.activate(mockContext);

      const openTerminalManager = getRegisteredCommandHandler<() => void>(
        "opencodeTui.openTerminalManager",
      );

      openTerminalManager();

      expect(showSpy).toHaveBeenCalledTimes(1);
    });

    it("should handle activation errors", async () => {
      vi.mocked(vscode.window.registerWebviewViewProvider).mockImplementation(
        () => {
          throw new Error("Registration failed");
        },
      );

      await lifecycle.activate(mockContext);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to activate"),
      );
    });
  });

  describe("deactivate", () => {
    it("should safely no-op when services were never initialized", async () => {
      await expect(lifecycle.deactivate()).resolves.toBeUndefined();
    });

    it("should dispose providers", async () => {
      await lifecycle.activate(mockContext);
      await lifecycle.deactivate();

      expect(mockContext.subscriptions).toBeDefined();
    });

    it("should dispose wave services", async () => {
      await lifecycle.activate(mockContext);
      await lifecycle.deactivate();

      const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
        .results[0].value;

      expect(outputChannel.dispose).toHaveBeenCalled();
    });

    it("should dispose all initialized collaborators and clear references", async () => {
      const promptKillSpy = vi
        .spyOn(lifecycle as any, "promptKillTmuxSessions")
        .mockResolvedValue(undefined);
      const logger = { info: vi.fn(), dispose: vi.fn() };
      const tuiProvider = { dispose: vi.fn() };
      const terminalManager = { dispose: vi.fn() };
      const contextManager = { dispose: vi.fn() };
      const instanceDiscoveryService = { dispose: vi.fn() };
      const instanceRegistry = { dispose: vi.fn() };
      const terminalDashboardProvider = { dispose: vi.fn() };

      Reflect.set(lifecycle, "outputChannelService", logger);
      Reflect.set(lifecycle, "tuiProvider", tuiProvider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "contextManager", contextManager);
      Reflect.set(
        lifecycle,
        "instanceDiscoveryService",
        instanceDiscoveryService,
      );
      Reflect.set(lifecycle, "instanceRegistry", instanceRegistry);
      Reflect.set(lifecycle, "instanceStore", new InstanceStore());
      Reflect.set(
        lifecycle,
        "terminalDashboardProvider",
        terminalDashboardProvider,
      );

      await lifecycle.deactivate();

      expect(promptKillSpy).toHaveBeenCalledTimes(1);
      expect(tuiProvider.dispose).toHaveBeenCalledTimes(1);
      expect(terminalManager.dispose).toHaveBeenCalledTimes(1);
      expect(logger.dispose).toHaveBeenCalledTimes(1);
      expect(contextManager.dispose).toHaveBeenCalledTimes(1);
      expect(instanceDiscoveryService.dispose).toHaveBeenCalledTimes(1);
      expect(instanceRegistry.dispose).toHaveBeenCalledTimes(1);
      expect(terminalDashboardProvider.dispose).toHaveBeenCalledTimes(1);
      expect(Reflect.get(lifecycle, "tuiProvider")).toBeUndefined();
      expect(Reflect.get(lifecycle, "terminalManager")).toBeUndefined();
      expect(Reflect.get(lifecycle, "outputChannelService")).toBeUndefined();
      expect(Reflect.get(lifecycle, "contextManager")).toBeUndefined();
      expect(
        Reflect.get(lifecycle, "instanceDiscoveryService"),
      ).toBeUndefined();
      expect(Reflect.get(lifecycle, "instanceRegistry")).toBeUndefined();
      expect(Reflect.get(lifecycle, "instanceStore")).toBeUndefined();
      expect(
        Reflect.get(lifecycle, "terminalDashboardProvider"),
      ).toBeUndefined();
      expect(logger.info).toHaveBeenLastCalledWith(
        "OpenCode Sidebar TUI deactivated",
      );
    });
  });

  describe("private helpers", () => {
    it("should expose live command dependencies and helper closures", async () => {
      const provider = { sendPrompt: vi.fn().mockResolvedValue(undefined) };
      const tmuxSessionManager = { kind: "tmux" };
      const terminalManager = { kind: "terminal" };
      const contextSharingService = { kind: "share" };
      const contextManager = { kind: "context" };
      const instanceStore = new InstanceStore();
      const instanceController = { kind: "controller" };
      const instanceQuickPick = { kind: "picker" };
      const outputChannelService = { kind: "logger" };
      const getActiveTerminalIdSpy = vi
        .spyOn(lifecycle as any, "getActiveTerminalId")
        .mockReturnValue("terminal-42");
      const sendTerminalCwdSpy = vi
        .spyOn(lifecycle as any, "sendTerminalCwd")
        .mockImplementation(() => undefined);
      const resolveActiveTmuxSessionIdSpy = vi
        .spyOn(lifecycle as any, "resolveActiveTmuxSessionId")
        .mockReturnValue("tmux-42");

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "tmuxSessionManager", tmuxSessionManager);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "contextSharingService", contextSharingService);
      Reflect.set(lifecycle, "contextManager", contextManager);
      Reflect.set(lifecycle, "instanceStore", instanceStore);
      Reflect.set(lifecycle, "instanceController", instanceController);
      Reflect.set(lifecycle, "instanceQuickPick", instanceQuickPick);
      Reflect.set(lifecycle, "outputChannelService", outputChannelService);

      const deps = (lifecycle as any).getCommandDependencies();

      expect(deps.provider).toBe(provider);
      expect(deps.tmuxManager).toBe(tmuxSessionManager);
      expect(deps.terminalManager).toBe(terminalManager);
      expect(deps.contextSharingService).toBe(contextSharingService);
      expect(deps.contextManager).toBe(contextManager);
      expect(deps.instanceStore).toBe(instanceStore);
      expect(deps.instanceController).toBe(instanceController);
      expect(deps.instanceQuickPick).toBe(instanceQuickPick);
      expect(deps.outputChannel).toBe(outputChannelService);
      expect(deps.getActiveTerminalId()).toBe("terminal-42");
      deps.sendTerminalCwd();
      await deps.sendPrompt("hello");
      expect(deps.resolveActiveTmuxSessionId()).toBe("tmux-42");

      expect(getActiveTerminalIdSpy).toHaveBeenCalledTimes(1);
      expect(sendTerminalCwdSpy).toHaveBeenCalledTimes(1);
      expect(provider.sendPrompt).toHaveBeenCalledWith("hello");
      expect(resolveActiveTmuxSessionIdSpy).toHaveBeenCalledTimes(1);
    });

    it("should resolve the active terminal id from runtime terminal key", () => {
      const instanceStore = {
        getActive: vi.fn(() => ({
          config: { id: "instance-1" },
          runtime: { terminalKey: "terminal-1", tmuxSessionId: "tmux-1" },
        })),
      };

      Reflect.set(lifecycle, "instanceStore", instanceStore);

      expect((lifecycle as any).getActiveTerminalId()).toBe("terminal-1");
    });

    it("should fall back to config id when runtime terminal key is missing", () => {
      const warn = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { warn });
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => ({ config: { id: "instance-2" }, runtime: {} })),
      });

      expect((lifecycle as any).getActiveTerminalId()).toBe("instance-2");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NO terminalKey"),
      );
    });

    it("should fall back to the static terminal id when no instance is active", () => {
      const warn = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { warn });
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => undefined),
      });

      expect((lifecycle as any).getActiveTerminalId()).toBe("opencode-main");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NO active instance"),
      );
    });

    it("should handle active terminal id resolution errors", () => {
      const error = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { error });
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => {
          throw new Error("boom");
        }),
      });

      expect((lifecycle as any).getActiveTerminalId()).toBe("opencode-main");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("ERROR: boom"),
      );
    });

    it("should return undefined when resolving the active tmux session id throws", () => {
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => {
          throw new Error("broken store");
        }),
      });

      expect((lifecycle as any).resolveActiveTmuxSessionId()).toBeUndefined();
    });

    it("should return false when no discovery service is available", async () => {
      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(false);
    });

    it("should return false when discovery finds no instances", async () => {
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([]),
      });

      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(false);
    });

    it("should send prompts via discovered instances when available", async () => {
      const info = vi.fn();
      const appendPromptSpy = vi
        .spyOn(OpenCodeApiClient.prototype, "appendPrompt")
        .mockResolvedValue(undefined);
      Reflect.set(lifecycle, "outputChannelService", { info });
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([{ port: 4317 }]),
      });

      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(true);

      expect(appendPromptSpy).toHaveBeenCalledWith("hello");
      expect(info).toHaveBeenCalledWith(expect.stringContaining("port 4317"));
    });

    it("should warn and return false when discovered instance forwarding fails", async () => {
      const warn = vi.fn();
      vi.spyOn(OpenCodeApiClient.prototype, "appendPrompt").mockRejectedValue(
        new Error("offline"),
      );
      Reflect.set(lifecycle, "outputChannelService", { warn });
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([{ port: 9999 }]),
      });

      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(false);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to send prompt via discovered instance",
        ),
      );
    });
  });

  describe("prompt routing", () => {
    it("should throw if sendPromptToOpenCode is called before initialization", async () => {
      await expect(
        (lifecycle as any).sendPromptToOpenCode("hello"),
      ).rejects.toThrow("OpenCode provider is not initialized");
    });

    it("should start OpenCode and send the prompt through HTTP when needed", async () => {
      vi.useFakeTimers();

      const appendPrompt = vi.fn().mockResolvedValue(undefined);
      const focus = vi.fn();
      const startOpenCode = vi.fn().mockResolvedValue(undefined);
      const provider = {
        startOpenCode,
        getApiClient: vi.fn(() => ({ appendPrompt })),
        isHttpAvailable: vi.fn(() => true),
        focus,
      };
      const terminalManager = {
        getTerminal: vi.fn(() => undefined),
        writeToTerminal: vi.fn(),
      };
      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([]),
      });

      const sendPromise = (lifecycle as any).sendPromptToOpenCode("ship it");
      await sendPromise;
      await vi.runAllTimersAsync();

      expect(startOpenCode).toHaveBeenCalledTimes(1);
      expect(appendPrompt).toHaveBeenCalledWith("ship it");
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "opencodeTui.focus",
      );
      expect(focus).toHaveBeenCalledTimes(1);
      expect(terminalManager.writeToTerminal).not.toHaveBeenCalled();
    });

    it("should prefer discovered instances before starting OpenCode", async () => {
      const appendPromptSpy = vi
        .spyOn(OpenCodeApiClient.prototype, "appendPrompt")
        .mockResolvedValue(undefined);
      const provider = {
        startOpenCode: vi.fn().mockResolvedValue(undefined),
        getApiClient: vi.fn(),
        isHttpAvailable: vi.fn(() => false),
      };
      const terminalManager = {
        getTerminal: vi.fn(() => undefined),
        writeToTerminal: vi.fn(),
      };

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([{ port: 7777 }]),
      });

      await (lifecycle as any).sendPromptToOpenCode("hello");

      expect(appendPromptSpy).toHaveBeenCalledWith("hello");
      expect(provider.startOpenCode).not.toHaveBeenCalled();
      expect(provider.getApiClient).not.toHaveBeenCalled();
    });

    it("should fall back to terminal input when the HTTP API append fails", async () => {
      const warn = vi.fn();
      const provider = {
        getApiClient: vi.fn(() => ({
          appendPrompt: vi.fn().mockRejectedValue(new Error("http down")),
        })),
        isHttpAvailable: vi.fn(() => true),
      };
      const terminalManager = {
        getTerminal: vi.fn(() => ({ id: "terminal" })),
        writeToTerminal: vi.fn(),
      };

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "outputChannelService", { warn });

      await (lifecycle as any).sendPromptToOpenCode("hello");

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to terminal input"),
      );
      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-main",
        "hello\n",
      );
    });

    it("should write directly to the terminal when HTTP is unavailable", async () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => false),
        inspect: vi.fn(() => undefined),
        update: vi.fn(),
      } as never);

      const provider = {
        getApiClient: vi.fn(() => undefined),
        isHttpAvailable: vi.fn(() => false),
        focus: vi.fn(),
      };
      const terminalManager = {
        getTerminal: vi.fn(() => ({ id: "terminal" })),
        writeToTerminal: vi.fn(),
      };

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);

      await (lifecycle as any).sendPromptToOpenCode("fallback");

      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-main",
        "fallback\n",
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        "opencodeTui.focus",
      );
    });
  });

  describe("terminal cwd forwarding", () => {
    it("should warn when there is no active terminal", () => {
      vscode.window.activeTerminal = undefined;

      (lifecycle as any).sendTerminalCwd();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "No active terminal",
      );
    });

    it("should warn when shell integration does not expose a cwd", () => {
      vscode.window.activeTerminal = { shellIntegration: {} };

      (lifecycle as any).sendTerminalCwd();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Could not determine terminal working directory",
        ),
      );
    });

    it("should send a relative cwd reference when a workspace is open", async () => {
      vi.useFakeTimers();

      const focus = vi.fn();
      const terminalManager = { writeToTerminal: vi.fn() };
      vscode.window.activeTerminal = {
        shellIntegration: { cwd: { fsPath: "/repo/packages/core" } },
      };
      vscode.workspace.workspaceFolders = [
        { uri: { fsPath: "/repo" } },
      ] as never;
      vi.mocked(vscode.workspace.asRelativePath).mockReturnValue(
        "packages/core",
      );
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "tuiProvider", { focus });

      (lifecycle as any).sendTerminalCwd();
      await vi.runAllTimersAsync();

      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-main",
        "@packages/core ",
      );
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "opencodeTui.focus",
      );
      expect(focus).toHaveBeenCalledTimes(1);
    });

    it("should send an absolute cwd reference when no workspace is open", () => {
      const terminalManager = { writeToTerminal: vi.fn() };
      vscode.window.activeTerminal = {
        shellIntegration: { cwd: { fsPath: "/tmp/project" } },
      };
      vscode.workspace.workspaceFolders = undefined;
      Reflect.set(lifecycle, "terminalManager", terminalManager);

      (lifecycle as any).sendTerminalCwd();

      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-main",
        "@/tmp/project ",
      );
    });
  });

  describe("tmux shutdown prompt", () => {
    it("should return early when there are no tmux sessions to kill", async () => {
      const tmuxManager = {
        discoverSessions: vi.fn().mockResolvedValue([]),
        killSession: vi.fn(),
      };
      Reflect.set(lifecycle, "tmuxSessionManager", tmuxManager);

      await (lifecycle as any).promptKillTmuxSessions();

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(tmuxManager.killSession).not.toHaveBeenCalled();
    });

    it("should keep tmux sessions running when the user declines shutdown", async () => {
      const tmuxManager = {
        discoverSessions: vi.fn().mockResolvedValue([{ id: "session-1" }]),
        killSession: vi.fn(),
      };
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
        "Keep Running" as never,
      );
      Reflect.set(lifecycle, "tmuxSessionManager", tmuxManager);

      await (lifecycle as any).promptKillTmuxSessions();

      expect(tmuxManager.killSession).not.toHaveBeenCalled();
    });

    it("should route tmux session shutdown through provider and manager safely", async () => {
      const tmuxManager = {
        discoverSessions: vi
          .fn()
          .mockResolvedValue([
            { id: "instance-session" },
            { id: "external-session" },
          ]),
        killSession: vi.fn().mockResolvedValue(undefined),
      };
      const killTmuxSession = vi.fn().mockResolvedValue(undefined);
      const instanceStore = new InstanceStore();
      instanceStore.upsert({
        config: { id: "instance-1", label: "OpenCode" },
        runtime: { tmuxSessionId: "instance-session" },
        state: "connected",
      });
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
        "Kill Sessions" as never,
      );
      Reflect.set(lifecycle, "tmuxSessionManager", tmuxManager);
      Reflect.set(lifecycle, "instanceStore", instanceStore);
      Reflect.set(lifecycle, "tuiProvider", { killTmuxSession });

      await (lifecycle as any).promptKillTmuxSessions();

      expect(killTmuxSession).toHaveBeenCalledWith("instance-session");
      expect(tmuxManager.killSession).toHaveBeenCalledWith("external-session");
    });
  });

  describe("commands", () => {
    beforeEach(async () => {
      await lifecycle.activate(mockContext);
    });

    it("should register start command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const startCall = calls.find((call) => call[0] === "opencodeTui.start");

      expect(startCall).toBeDefined();
    });

    it("should register sendToTerminal command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const sendCall = calls.find(
        (call) => call[0] === "opencodeTui.sendToTerminal",
      );

      expect(sendCall).toBeDefined();
    });

    it("should register sendAtMention command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const mentionCall = calls.find(
        (call) => call[0] === "opencodeTui.sendAtMention",
      );

      expect(mentionCall).toBeDefined();
    });

    it("should register sendAllOpenFiles command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const allFilesCall = calls.find(
        (call) => call[0] === "opencodeTui.sendAllOpenFiles",
      );

      expect(allFilesCall).toBeDefined();
    });

    it("should register sendFileToTerminal command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const fileCall = calls.find(
        (call) => call[0] === "opencodeTui.sendFileToTerminal",
      );

      expect(fileCall).toBeDefined();
    });

    it("should register and execute tmux management commands", async () => {
      const createTmuxSession = vi.fn().mockResolvedValue(undefined);
      const switchToNativeShell = vi.fn().mockResolvedValue(undefined);

      Reflect.set(lifecycle, "tuiProvider", {
        createTmuxSession,
        switchToNativeShell,
      });

      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const createCall = calls.find(
        (call) => call[0] === "opencodeTui.createTmuxSession",
      );
      const nativeCall = calls.find(
        (call) => call[0] === "opencodeTui.switchNativeShell",
      );

      expect(createCall).toBeDefined();
      expect(nativeCall).toBeDefined();

      const createHandler = createCall?.[1] as () => Promise<void>;
      const nativeHandler = nativeCall?.[1] as () => Promise<void>;

      await createHandler();
      await nativeHandler();

      expect(createTmuxSession).toHaveBeenCalledTimes(1);
      expect(switchToNativeShell).toHaveBeenCalledTimes(1);
    });

    describe("opencode.spawnForWorkspace", () => {
      const getSpawnForWorkspaceHandler = () => {
        (lifecycle as any).registerCommands(mockContext);
        const commandCall = vi
          .mocked(vscode.commands.registerCommand)
          .mock.calls.find((call) => call[0] === "opencode.spawnForWorkspace");

        expect(commandCall).toBeDefined();
        return commandCall?.[1] as (uri?: {
          toString(): string;
        }) => Promise<void>;
      };

      it("should focus reusable existing workspace instance instead of creating duplicate", async () => {
        const workspaceUri = "file:///workspace/reused";
        const instanceStore = new InstanceStore();
        instanceStore.upsert({
          config: {
            id: "existing-workspace-instance",
            workspaceUri,
            label: "Existing Workspace",
          },
          runtime: {},
          state: "connected",
        });

        const spawnSpy = vi.fn().mockResolvedValue(undefined);
        (lifecycle as any).instanceStore = instanceStore;
        (lifecycle as any).instanceController = { spawn: spawnSpy };

        const spawnForWorkspace = getSpawnForWorkspaceHandler();
        await spawnForWorkspace({ toString: () => workspaceUri });

        expect(spawnSpy).not.toHaveBeenCalled();
        expect(instanceStore.getAll()).toHaveLength(1);
        expect(instanceStore.getActive().config.id).toBe(
          "existing-workspace-instance",
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          "opencodeTui.focus",
        );
      });

      it("should spawn matching disconnected workspace instance instead of focus-only no-op", async () => {
        const workspaceUri = "file:///workspace/disconnected";
        const instanceStore = new InstanceStore();
        instanceStore.upsert({
          config: {
            id: "disconnected-workspace-instance",
            workspaceUri,
            label: "Disconnected Workspace",
          },
          runtime: {},
          state: "disconnected",
        });

        const spawnSpy = vi.fn().mockResolvedValue(undefined);
        (lifecycle as any).instanceStore = instanceStore;
        (lifecycle as any).instanceController = { spawn: spawnSpy };

        const spawnForWorkspace = getSpawnForWorkspaceHandler();
        await spawnForWorkspace({ toString: () => workspaceUri });

        expect(spawnSpy).toHaveBeenCalledTimes(1);
        expect(spawnSpy).toHaveBeenCalledWith(
          "disconnected-workspace-instance",
        );
        expect(instanceStore.getAll()).toHaveLength(1);
        expect(instanceStore.getActive().config.id).toBe(
          "disconnected-workspace-instance",
        );
      });

      it("should persist workspace metadata for new workspace instances before spawn", async () => {
        const instanceStore = new InstanceStore();
        const spawnSpy = vi.fn().mockResolvedValue(undefined);
        (lifecycle as any).instanceStore = instanceStore;
        (lifecycle as any).instanceController = { spawn: spawnSpy };

        const workspaceUri = "file:///workspace/new";
        const spawnForWorkspace = getSpawnForWorkspaceHandler();
        await spawnForWorkspace({ toString: () => workspaceUri });

        expect(spawnSpy).toHaveBeenCalledTimes(1);
        const spawnedId = spawnSpy.mock.calls[0]?.[0] as string;
        const createdRecord = instanceStore.get(spawnedId);

        expect(createdRecord).toBeDefined();
        expect(createdRecord?.config.workspaceUri).toBe(workspaceUri);
        expect(createdRecord?.config.label).toBe("OpenCode (Workspace)");
      });
    });
  });
});
