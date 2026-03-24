import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as nodePtyTypes from "../test/mocks/node-pty";
import type * as vscodeTypes from "../test/mocks/vscode";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { InstanceStore } from "../services/InstanceStore";
import { OutputChannelService } from "../services/OutputChannelService";
import { TerminalManager } from "../terminals/TerminalManager";
import { TreeSnapshot } from "../webview/sidebar/types";
import { OpenCodeTuiProvider } from "./OpenCodeTuiProvider";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);
await vi.importActual<typeof nodePtyTypes>("../test/mocks/node-pty");

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

vi.mock("node-pty", async () => {
  const actual = await vi.importActual("../test/mocks/node-pty");
  return actual;
});

describe("OpenCodeTuiProvider", () => {
  let terminalManager: TerminalManager;
  let captureManager: OutputCaptureManager;
  let provider: OpenCodeTuiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    OutputChannelService.resetInstance();
    terminalManager = new TerminalManager();
    captureManager = new OutputCaptureManager();
  });

  afterEach(() => {
    provider?.dispose();
    terminalManager.dispose();
    OutputChannelService.resetInstance();
  });

  function mockConfiguration(options?: {
    autoStartOnOpen?: boolean;
    enableHttpApi?: boolean;
    command?: string;
  }): void {
    const {
      autoStartOnOpen = false,
      enableHttpApi = false,
      command = "opencode -c",
    } = options ?? {};

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "autoStartOnOpen") {
          return autoStartOnOpen;
        }
        if (key === "enableHttpApi") {
          return enableHttpApi;
        }
        if (key === "command") {
          return command;
        }
        if (key === "httpTimeout") {
          return 5000;
        }
        if (key === "logLevel") {
          return "error";
        }
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);
  }

  function createProvider(instanceStore?: InstanceStore): OpenCodeTuiProvider {
    const context = new vscode.ExtensionContext();
    return new OpenCodeTuiProvider(
      context as any,
      terminalManager,
      captureManager,
      instanceStore,
    );
  }

  function resolveProvider(target: OpenCodeTuiProvider) {
    const view = vscode.WebviewView() as any;
    target.resolveWebviewView(view, {} as any, {} as any);
    const messageHandler = vi.mocked(view.webview.onDidReceiveMessage).mock
      .calls[0]?.[0] as (message: any) => void;

    return { view, messageHandler };
  }

  it("handles switchSession messages by delegating to instance switching", () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const switchSpy = vi
      .spyOn(provider, "switchToInstance")
      .mockResolvedValue(undefined);

    messageHandler({ type: "switchSession", sessionId: "workspace-b" });

    expect(switchSpy).toHaveBeenCalledWith("workspace-b");
  });

  it("starts the default terminal path without sidebar tree interaction", () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    provider = createProvider();
    const createTerminalSpy = vi.spyOn(terminalManager, "createTerminal");
    const { messageHandler } = resolveProvider(provider);

    messageHandler({ type: "ready", cols: 120, rows: 40 });

    expect(createTerminalSpy).toHaveBeenCalledWith(
      "opencode-main",
      "opencode -c",
      {},
      undefined,
      120,
      40,
      "opencode-main",
    );
  });

  it("ignores treeSnapshot payloads in the provider message handler", () => {
    mockConfiguration();
    provider = createProvider();
    const { messageHandler } = resolveProvider(provider);
    const switchSpy = vi
      .spyOn(provider, "switchToInstance")
      .mockResolvedValue(undefined);
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();
    const snapshot: TreeSnapshot = {
      type: "treeSnapshot",
      sessions: [
        {
          id: "workspace-a",
          name: "workspace-a",
          workspace: "repo-a",
          isActive: true,
        },
      ],
      activeSessionId: "workspace-a",
    };

    messageHandler(snapshot as any);

    expect(switchSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("switches active instances without respawning when a terminal already exists", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: { id: "session-a" },
      runtime: { terminalKey: "session-a" },
      state: "connected",
    });
    instanceStore.upsert({
      config: { id: "session-b" },
      runtime: { terminalKey: "session-b" },
      state: "connected",
    });

    provider = createProvider(instanceStore);
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();
    const resizeSpy = vi.spyOn(terminalManager, "resizeTerminal");
    terminalManager.createTerminal(
      "session-b",
      "opencode -c",
      {},
      undefined,
      undefined,
      undefined,
      "session-b",
    );

    const { view } = resolveProvider(provider);
    (provider as any).lastKnownCols = 90;
    (provider as any).lastKnownRows = 30;

    instanceStore.setActive("session-b");
    await Promise.resolve();

    expect((provider as any).activeInstanceId).toBe("session-b");
    expect(startSpy).not.toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "clearTerminal",
    });
    expect(resizeSpy).toHaveBeenCalledWith("session-b", 90, 30);
  });

  it("switches active instances and spawns a new terminal when it does not exist", async () => {
    mockConfiguration({ autoStartOnOpen: false, enableHttpApi: false });
    const instanceStore = new InstanceStore();
    instanceStore.upsert({
      config: { id: "session-a" },
      runtime: { terminalKey: "session-a" },
      state: "connected",
    });
    instanceStore.upsert({
      config: { id: "session-c" },
      runtime: { terminalKey: "session-c" },
      state: "connected",
    });

    provider = createProvider(instanceStore);
    const startSpy = vi.spyOn(provider, "startOpenCode").mockResolvedValue();

    const { view } = resolveProvider(provider);

    instanceStore.setActive("session-c");
    await Promise.resolve();

    expect((provider as any).activeInstanceId).toBe("session-c");
    expect(startSpy).toHaveBeenCalled();
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: "clearTerminal",
    });
  });
});
