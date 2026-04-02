import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExtensionLifecycle } from "./ExtensionLifecycle";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceStore } from "../services/InstanceStore";
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

  beforeEach(() => {
    vi.clearAllMocks();
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

      expect(vscode.window.registerWebviewViewProvider).toHaveBeenNthCalledWith(
        2,
        "opencodeTui.terminalDashboard",
        expect.any(Object),
        expect.objectContaining({
          webviewOptions: { retainContextWhenHidden: true },
        }),
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
            command: "opencode --backend existing",
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
            command: "opencode --backend existing",
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

      it("should persist configured command for new workspace instances before spawn", async () => {
        const configuredCommand = "opencode --backend claude";
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
          get: vi.fn((key: string, defaultValue?: unknown) =>
            key === "command" ? configuredCommand : defaultValue,
          ),
          update: vi.fn(),
        } as any);

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
        expect(createdRecord?.config.command).toBe(configuredCommand);
      });
    });
  });
});
