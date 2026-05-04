import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type * as vscodeTypes from "../../test/mocks/vscode";
import {
  TmuxSessionManager,
  type TmuxPane,
} from "../../services/TmuxSessionManager";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import { InstanceStore } from "../../services/InstanceStore";
import {
  ZellijSessionManager,
  type ZellijPane,
  type ZellijTab,
} from "../../services/ZellijSessionManager";
import {
  registerTmuxPaneCommands,
  type TmuxPaneCommandDependencies,
} from "./tmuxPaneCommands";

const vscodeMock = await vi.importActual<typeof vscodeTypes>(
  "../../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../../test/mocks/vscode");
  return actual;
});

type RegisteredCommandHandler = (argument?: unknown) => Promise<void>;

type WindowEntry = {
  windowId: string;
  index: number;
  name: string;
  isActive: boolean;
};

type Harness = {
  deps: TmuxPaneCommandDependencies;
  tmuxManager: TmuxSessionManager;
  resolveActiveTmuxSessionId: ReturnType<
    typeof vi.fn<() => string | undefined>
  >;
  provider: TerminalProvider;
  handlers: Map<string, RegisteredCommandHandler>;
  selectPane: ReturnType<typeof vi.fn>;
  listPanes: ReturnType<typeof vi.fn>;
  splitPane: ReturnType<typeof vi.fn>;
  sendTextToPane: ReturnType<typeof vi.fn>;
  resizePane: ReturnType<typeof vi.fn>;
  swapPanes: ReturnType<typeof vi.fn>;
  killPane: ReturnType<typeof vi.fn>;
  nextWindow: ReturnType<typeof vi.fn>;
  prevWindow: ReturnType<typeof vi.fn>;
  createWindow: ReturnType<typeof vi.fn>;
  listWindows: ReturnType<typeof vi.fn>;
  killWindow: ReturnType<typeof vi.fn>;
  selectWindow: ReturnType<typeof vi.fn>;
  killSession: ReturnType<typeof vi.fn>;
};

type ZellijHarness = {
  deps: TmuxPaneCommandDependencies;
  zellijManager: ZellijSessionManager;
  handlers: Map<string, RegisteredCommandHandler>;
  selectPane: ReturnType<typeof vi.fn>;
  listPanes: ReturnType<typeof vi.fn>;
  splitPane: ReturnType<typeof vi.fn>;
  sendTextToPane: ReturnType<typeof vi.fn>;
  resizePane: ReturnType<typeof vi.fn>;
  killPane: ReturnType<typeof vi.fn>;
  nextTab: ReturnType<typeof vi.fn>;
  prevTab: ReturnType<typeof vi.fn>;
  createTab: ReturnType<typeof vi.fn>;
  listTabs: ReturnType<typeof vi.fn>;
  killTab: ReturnType<typeof vi.fn>;
  selectTab: ReturnType<typeof vi.fn>;
  killSession: ReturnType<typeof vi.fn>;
};

const defaultPanes: TmuxPane[] = [
  {
    paneId: "%1",
    index: 0,
    title: "editor",
    isActive: true,
  },
  {
    paneId: "%2",
    index: 1,
    title: "shell",
    isActive: false,
  },
];

const defaultWindows: WindowEntry[] = [
  {
    windowId: "@1",
    index: 1,
    name: "main",
    isActive: true,
  },
  {
    windowId: "@2",
    index: 2,
    name: "logs",
    isActive: false,
  },
];

const defaultZellijPanes: ZellijPane[] = [
  { id: "terminal_1", title: "editor", isFocused: true, isFloating: false },
  { id: "terminal_2", title: "shell", isFocused: false, isFloating: false },
];

const defaultZellijTabs: ZellijTab[] = [
  { index: 1, name: "main", isActive: true },
  { index: 2, name: "logs", isActive: false },
];

function createHarness(options?: {
  sessionId?: string | undefined;
  panes?: TmuxPane[];
  windows?: WindowEntry[];
}): Harness {
  const tmuxManager = new TmuxSessionManager();
  const provider = new vscodeMock.Disposable(
    () => {},
  ) as unknown as TerminalProvider;
  const resolveActiveTmuxSessionId = vi.fn<() => string | undefined>(() =>
    options && "sessionId" in options ? options.sessionId : "session-1",
  );
  const resolveActiveTmuxFocus = vi.fn(async () =>
    resolveActiveTmuxSessionId()
      ? {
          sessionId: resolveActiveTmuxSessionId()!,
          windowId: "@1",
          paneId: "%1",
        }
      : undefined,
  );
  const panes = options?.panes ?? defaultPanes;
  const windows = options?.windows ?? defaultWindows;

  const selectPane = vi
    .spyOn(tmuxManager, "selectPane")
    .mockResolvedValue(undefined);
  const listPanes = vi.spyOn(tmuxManager, "listPanes").mockResolvedValue(panes);
  const splitPane = vi
    .spyOn(tmuxManager, "splitPane")
    .mockResolvedValue("%new");
  const sendTextToPane = vi
    .spyOn(tmuxManager, "sendTextToPane")
    .mockResolvedValue(undefined);
  const resizePane = vi
    .spyOn(tmuxManager, "resizePane")
    .mockResolvedValue(undefined);
  const swapPanes = vi
    .spyOn(tmuxManager, "swapPanes")
    .mockResolvedValue(undefined);
  const killPane = vi
    .spyOn(tmuxManager, "killPane")
    .mockResolvedValue(undefined);
  const nextWindow = vi
    .spyOn(tmuxManager, "nextWindow")
    .mockResolvedValue(undefined);
  const prevWindow = vi
    .spyOn(tmuxManager, "prevWindow")
    .mockResolvedValue(undefined);
  const createWindow = vi
    .spyOn(tmuxManager, "createWindow")
    .mockResolvedValue({ windowId: "@new", paneId: "%new" });
  const listWindows = vi
    .spyOn(tmuxManager, "listWindows")
    .mockResolvedValue(windows);
  const killWindow = vi
    .spyOn(tmuxManager, "killWindow")
    .mockResolvedValue(undefined);
  const selectWindow = vi
    .spyOn(tmuxManager, "selectWindow")
    .mockResolvedValue(undefined);
  const killSession = vi
    .spyOn(tmuxManager, "killSession")
    .mockResolvedValue(undefined);

  const deps: TmuxPaneCommandDependencies = {
    tmuxManager,
    zellijManager: undefined,
    instanceStore: undefined,
    resolveActiveTmuxSessionId,
    resolveActiveTmuxFocus,
    resolveWorkspacePath: vi.fn(() => "/test/workspace"),
    provider,
  };
  registerTmuxPaneCommands(deps);

  const handlers = new Map(
    vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([id, callback]) => [
        id,
        callback as RegisteredCommandHandler,
      ]),
  );

  return {
    deps,
    tmuxManager,
    resolveActiveTmuxSessionId,
    provider,
    handlers,
    selectPane,
    listPanes,
    splitPane,
    sendTextToPane,
    resizePane,
    swapPanes,
    killPane,
    nextWindow,
    prevWindow,
    createWindow,
    listWindows,
    killWindow,
    selectWindow,
    killSession,
  };
}

function createZellijHarness(options?: {
  sessionId?: string | undefined;
  panes?: ZellijPane[];
  tabs?: ZellijTab[];
}): ZellijHarness {
  const zellijManager = new ZellijSessionManager();
  const tmuxManager = new TmuxSessionManager();
  const provider = new vscodeMock.Disposable(
    () => {},
  ) as unknown as TerminalProvider;
  const instanceStore = new InstanceStore();
  instanceStore.upsert({
    config: { id: "instance-1", label: "Instance 1" },
    runtime: {
      terminalBackend: "zellij",
      zellijSessionId:
        options && "sessionId" in options ? options.sessionId : "zellij-1",
    },
    state: "connected",
  });

  const selectPane = vi
    .spyOn(zellijManager, "selectPane")
    .mockResolvedValue(undefined);
  const listPanes = vi
    .spyOn(zellijManager, "listPanes")
    .mockResolvedValue(options?.panes ?? defaultZellijPanes);
  const splitPane = vi
    .spyOn(zellijManager, "splitPane")
    .mockResolvedValue("terminal_new");
  const sendTextToPane = vi
    .spyOn(zellijManager, "sendTextToPane")
    .mockResolvedValue(undefined);
  const resizePane = vi
    .spyOn(zellijManager, "resizePane")
    .mockResolvedValue(undefined);
  const killPane = vi
    .spyOn(zellijManager, "killPane")
    .mockResolvedValue(undefined);
  const nextTab = vi.spyOn(zellijManager, "nextTab").mockResolvedValue(undefined);
  const prevTab = vi.spyOn(zellijManager, "prevTab").mockResolvedValue(undefined);
  const createTab = vi
    .spyOn(zellijManager, "createTab")
    .mockResolvedValue(undefined);
  const listTabs = vi
    .spyOn(zellijManager, "listTabs")
    .mockResolvedValue(options?.tabs ?? defaultZellijTabs);
  const killTab = vi.spyOn(zellijManager, "killTab").mockResolvedValue(undefined);
  const selectTab = vi
    .spyOn(zellijManager, "selectTab")
    .mockResolvedValue(undefined);
  const killSession = vi
    .spyOn(zellijManager, "killSession")
    .mockResolvedValue(undefined);
  const tmuxSplitPane = vi.spyOn(tmuxManager, "splitPane");

  const deps: TmuxPaneCommandDependencies = {
    tmuxManager,
    zellijManager,
    instanceStore,
    resolveActiveTmuxSessionId: vi.fn(() => undefined),
    resolveActiveTmuxFocus: vi.fn(async () => undefined),
    resolveWorkspacePath: vi.fn(() => "/test/workspace"),
    provider,
  };
  registerTmuxPaneCommands(deps);

  const handlers = new Map(
    vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([id, callback]) => [
        id,
        callback as RegisteredCommandHandler,
      ]),
  );
  expect(tmuxSplitPane).not.toHaveBeenCalled();

  return {
    deps,
    zellijManager,
    handlers,
    selectPane,
    listPanes,
    splitPane,
    sendTextToPane,
    resizePane,
    killPane,
    nextTab,
    prevTab,
    createTab,
    listTabs,
    killTab,
    selectTab,
    killSession,
  };
}

function panePick(paneId: string, label: string, description: string) {
  return { label, description, paneId };
}

function windowPick(windowId: string, label: string, description: string) {
  return { label, description, windowId };
}

function mockQuickPickOnce(value: unknown): void {
  vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(value as never);
}

function mockInputBoxOnce(value: string | undefined): void {
  vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(value);
}

function mockWarningOnce(value: string | undefined): void {
  vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
    value as never,
  );
}

function getHandler(
  harness: { handlers: Map<string, RegisteredCommandHandler> },
  commandId: string,
): RegisteredCommandHandler {
  const handler = harness.handlers.get(commandId);
  expect(handler).toBeDefined();
  return handler as RegisteredCommandHandler;
}

describe("registerTmuxPaneCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all 15 tmux pane commands", () => {
    const harness = createHarness();

    expect(harness.handlers.size).toBe(15);
    expect([...harness.handlers.keys()]).toEqual([
      "opencodeTui.tmuxSwitchPane",
      "opencodeTui.tmuxSplitPaneH",
      "opencodeTui.tmuxSplitPaneV",
      "opencodeTui.tmuxSplitPaneWithCommand",
      "opencodeTui.tmuxSendTextToPane",
      "opencodeTui.tmuxResizePane",
      "opencodeTui.tmuxSwapPane",
      "opencodeTui.tmuxKillPane",
      "opencodeTui.tmuxNextWindow",
      "opencodeTui.tmuxPrevWindow",
      "opencodeTui.tmuxCreateWindow",
      "opencodeTui.tmuxKillWindow",
      "opencodeTui.tmuxSelectWindow",
      "opencodeTui.tmuxKillSession",
      "opencodeTui.tmuxRefresh",
    ]);
  });

  it("switches panes via direct arg and quick pick selection with active markers", async () => {
    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxSwitchPane");

    await handler({ paneId: "%2" });
    expect(harness.selectPane).toHaveBeenCalledWith("%2");

    mockQuickPickOnce(undefined);
    await handler();
    expect(harness.listPanes).toHaveBeenCalledWith("session-1");
    expect(harness.selectPane).toHaveBeenCalledTimes(1);

    mockQuickPickOnce(panePick("%1", "$(check) Pane 0: editor", "%1"));
    await handler();

    expect(harness.selectPane).toHaveBeenLastCalledWith("%1");

    const quickPickCall = vi.mocked(vscode.window.showQuickPick).mock.calls[0];
    const items = quickPickCall?.[0] as Array<{
      label: string;
      description: string;
    }>;
    expect(items[0]).toEqual({
      label: "$(check) Pane 0: editor",
      description: "%1",
      paneId: "%1",
    });
    expect(items[1]).toEqual({
      label: "Pane 1: shell",
      description: "%2",
      paneId: "%2",
    });
  });

  it("splits panes horizontally and vertically with session fallback, no-session return, and errors", async () => {
    const horizontalHarness = createHarness();
    const horizontal = getHandler(
      horizontalHarness,
      "opencodeTui.tmuxSplitPaneH",
    );

    await horizontal({ paneId: "%2", sessionId: "session-2" });
    await horizontal({ sessionId: "session-2" });

    expect(horizontalHarness.splitPane).toHaveBeenNthCalledWith(1, "%2", "h", {
      workingDirectory: "/test/workspace",
    });
    expect(horizontalHarness.splitPane).toHaveBeenNthCalledWith(2, "%1", "h", {
      workingDirectory: "/test/workspace",
    });

    const noSessionHarness = createHarness({ sessionId: undefined });
    await getHandler(noSessionHarness, "opencodeTui.tmuxSplitPaneV")();
    expect(noSessionHarness.splitPane).not.toHaveBeenCalled();

    const verticalHarness = createHarness();
    verticalHarness.splitPane.mockRejectedValueOnce(new Error("boom"));

    await getHandler(
      verticalHarness,
      "opencodeTui.tmuxSplitPaneV",
    )({
      sessionId: "session-3",
    });

    expect(verticalHarness.splitPane).toHaveBeenCalledWith("%1", "v", {
      workingDirectory: "/test/workspace",
    });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to split pane",
    );
  });

  it("splits pane with command for cancel, success, and error paths", async () => {
    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxSplitPaneWithCommand");

    mockInputBoxOnce(undefined);
    await handler({ sessionId: "session-1" });
    expect(harness.splitPane).not.toHaveBeenCalled();

    mockInputBoxOnce("htop");
    await handler({ paneId: "%1", sessionId: "session-1" });
    expect(harness.splitPane).toHaveBeenCalledWith("%1", "v", {
      command: "htop",
      workingDirectory: "/test/workspace",
    });

    harness.splitPane.mockRejectedValueOnce(new Error("boom"));
    mockInputBoxOnce("npm run dev");
    await handler({ sessionId: "session-1" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to split pane",
    );
  });

  it("sends text to panes from direct args and quick-pick selection", async () => {
    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxSendTextToPane");

    mockInputBoxOnce(undefined);
    mockInputBoxOnce("ls -la");
    mockInputBoxOnce("pwd");

    await handler({ paneId: "%2" });
    expect(harness.sendTextToPane).not.toHaveBeenCalled();

    await handler({ paneId: "%2" });
    expect(harness.sendTextToPane).toHaveBeenCalledWith("%2", "ls -la");

    mockQuickPickOnce(undefined);
    mockQuickPickOnce(panePick("%1", "Pane 0: editor", "%1"));

    await handler();
    expect(harness.sendTextToPane).toHaveBeenCalledTimes(1);

    await handler();
    expect(harness.sendTextToPane).toHaveBeenLastCalledWith("%1", "pwd");
  });

  it("resizes panes across cancel, validation, success, and error branches", async () => {
    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxResizePane");

    mockQuickPickOnce(undefined);
    mockQuickPickOnce(panePick("%1", "Pane 0: editor", "%1"));
    mockQuickPickOnce(undefined);
    mockQuickPickOnce(panePick("%1", "Pane 0: editor", "%1"));
    mockQuickPickOnce("Left");
    mockQuickPickOnce(panePick("%1", "Pane 0: editor", "%1"));
    mockQuickPickOnce("Down");
    mockQuickPickOnce("Up");

    mockInputBoxOnce(undefined);
    mockInputBoxOnce("7");
    mockInputBoxOnce("3");

    await handler();
    await handler();
    await handler();
    await handler();
    expect(harness.resizePane).toHaveBeenCalledWith("%1", "D", 7);

    const resizePromptCall = vi.mocked(vscode.window.showInputBox).mock
      .calls[0];
    const validateInput = resizePromptCall?.[0]?.validateInput;
    expect(validateInput?.("abc")).toBe("Must be a positive number");
    expect(validateInput?.("5")).toBeUndefined();

    harness.resizePane.mockRejectedValueOnce(new Error("boom"));
    await handler({ paneId: "%2" });
    expect(harness.resizePane).toHaveBeenLastCalledWith("%2", "U", 3);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to resize pane",
    );
  });

  it("swaps panes across cancellation, last-target prevention, success, and error paths", async () => {
    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxSwapPane");

    mockQuickPickOnce(undefined);
    mockQuickPickOnce(panePick("%1", "Pane 0: editor", "%1"));
    mockQuickPickOnce(undefined);
    mockQuickPickOnce(panePick("%1", "Pane 0: editor", "%1"));
    mockQuickPickOnce(panePick("%2", "Pane 1: shell", "%2"));
    mockQuickPickOnce(panePick("%2", "Pane 1: shell", "%2"));

    await handler();
    await handler();
    expect(harness.swapPanes).not.toHaveBeenCalled();

    await handler();
    expect(harness.swapPanes).toHaveBeenCalledWith("%1", "%2");

    const singlePaneHarness = createHarness({ panes: [defaultPanes[0]] });
    const singlePaneHandler = getHandler(
      singlePaneHarness,
      "opencodeTui.tmuxSwapPane",
    );
    vi.mocked(vscode.window.showQuickPick).mockReset();
    mockQuickPickOnce(panePick("%1", "Pane 0: editor", "%1"));
    await singlePaneHandler();
    expect(singlePaneHarness.swapPanes).not.toHaveBeenCalled();

    vi.mocked(vscode.window.showQuickPick).mockReset();
    mockQuickPickOnce(panePick("%2", "Pane 1: shell", "%2"));
    harness.swapPanes.mockRejectedValueOnce(new Error("boom"));
    await handler({ paneId: "%1" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to swap panes",
    );
  });

  it("kills panes with last-pane prevention, destructive confirmation, cancellation, and error handling", async () => {
    const multiPaneHarness = createHarness();
    const handler = getHandler(multiPaneHarness, "opencodeTui.tmuxKillPane");

    mockQuickPickOnce(undefined);
    mockQuickPickOnce(panePick("%2", "Pane 1: shell", "%2"));
    mockWarningOnce("Kill");
    mockWarningOnce("Cancel");
    mockWarningOnce("Kill");

    await handler();
    expect(multiPaneHarness.killPane).not.toHaveBeenCalled();

    await handler();
    expect(multiPaneHarness.killPane).toHaveBeenCalledWith("%2");

    await handler({ paneId: "%2" });
    expect(multiPaneHarness.killPane).toHaveBeenCalledTimes(1);

    multiPaneHarness.killPane.mockRejectedValueOnce(new Error("boom"));
    await handler({ paneId: "%2" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to kill pane",
    );

    const singlePaneHarness = createHarness({ panes: [defaultPanes[0]] });
    const singlePaneHandler = getHandler(
      singlePaneHarness,
      "opencodeTui.tmuxKillPane",
    );

    await singlePaneHandler();
    await singlePaneHandler({ paneId: "%1" });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Cannot kill the last pane — use 'Kill Session' instead",
    );
  });

  it.each([
    [
      "opencodeTui.tmuxNextWindow",
      "nextWindow",
      "Failed to switch to next window",
    ],
    [
      "opencodeTui.tmuxPrevWindow",
      "prevWindow",
      "Failed to switch to previous window",
    ],
    ["opencodeTui.tmuxCreateWindow", "createWindow", "Failed to create window"],
  ] as const)(
    "%s navigates tmux windows and reports command errors",
    async (commandId, methodName, errorMessage) => {
      const noSessionHarness = createHarness({ sessionId: undefined });
      await getHandler(noSessionHarness, commandId)();
      expect(noSessionHarness[methodName]).not.toHaveBeenCalled();

      const harness = createHarness();
      const handler = getHandler(harness, commandId);

      await handler();
      if (methodName === "createWindow") {
        expect(harness[methodName]).toHaveBeenCalledWith(
          "session-1",
          "/test/workspace",
        );
      } else {
        expect(harness[methodName]).toHaveBeenCalledWith("session-1");
      }

      harness[methodName].mockRejectedValueOnce(new Error("boom"));
      await handler();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(errorMessage);
    },
  );

  it("kills windows through quick pick, confirmation, direct args, and error handling", async () => {
    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxKillWindow");

    mockQuickPickOnce(undefined);
    mockQuickPickOnce(windowPick("@1", "$(check) Window 1: main", "@1"));
    mockWarningOnce("Kill");
    mockWarningOnce("Cancel");
    mockWarningOnce("Kill");

    await handler();
    expect(harness.killWindow).not.toHaveBeenCalled();

    await handler();
    expect(harness.killWindow).toHaveBeenCalledWith("@1");

    await handler({ windowId: "@2" });
    expect(harness.killWindow).toHaveBeenCalledTimes(1);

    const windowItems = vi.mocked(vscode.window.showQuickPick).mock
      .calls[1]?.[0] as Array<{
      label: string;
      windowId: string;
    }>;
    expect(windowItems[0]).toEqual({
      label: "$(check) Window 1: main",
      description: "@1",
      windowId: "@1",
    });

    harness.killWindow.mockRejectedValueOnce(new Error("boom"));
    await handler({ windowId: "@2" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to kill window",
    );
  });

  it("selects windows from quick picks or direct args and handles errors", async () => {
    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxSelectWindow");

    mockQuickPickOnce(undefined);
    mockQuickPickOnce(windowPick("@2", "Window 2: logs", "@2"));

    await handler();
    expect(harness.selectWindow).not.toHaveBeenCalled();

    await handler();
    expect(harness.selectWindow).toHaveBeenCalledWith("@2");

    harness.selectWindow.mockRejectedValueOnce(new Error("boom"));
    await handler({ windowId: "@1" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to select window",
    );
  });

  it("kills sessions only after confirmation and surfaces failures", async () => {
    const noSessionHarness = createHarness({ sessionId: undefined });
    await getHandler(noSessionHarness, "opencodeTui.tmuxKillSession")();
    expect(noSessionHarness.killSession).not.toHaveBeenCalled();

    const harness = createHarness();
    const handler = getHandler(harness, "opencodeTui.tmuxKillSession");

    mockWarningOnce("Cancel");
    mockWarningOnce("Kill");
    mockWarningOnce("Kill");

    await handler();
    expect(harness.killSession).not.toHaveBeenCalled();

    await handler({ sessionId: "session-2" });
    expect(harness.killSession).toHaveBeenCalledWith("session-2");

    harness.killSession.mockRejectedValueOnce(new Error("boom"));
    await handler();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to kill session",
    );
  });

  it("routes pane operations to zellij when zellij is active", async () => {
    const harness = createZellijHarness();

    await getHandler(harness, "opencodeTui.tmuxSwitchPane")({
      paneId: "terminal_2",
    });
    expect(harness.selectPane).toHaveBeenCalledWith("terminal_2");

    await getHandler(harness, "opencodeTui.tmuxSplitPaneH")({
      paneId: "terminal_1",
      sessionId: "zellij-1",
    });
    expect(harness.selectPane).toHaveBeenLastCalledWith("terminal_1");
    expect(harness.splitPane).toHaveBeenCalledWith("h", {
      workingDirectory: "/test/workspace",
    });

    mockInputBoxOnce("pwd");
    await getHandler(harness, "opencodeTui.tmuxSendTextToPane")({
      paneId: "terminal_2",
    });
    expect(harness.selectPane).toHaveBeenLastCalledWith("terminal_2");
    expect(harness.sendTextToPane).toHaveBeenCalledWith("pwd");

    mockQuickPickOnce("Left");
    mockInputBoxOnce("4");
    await getHandler(harness, "opencodeTui.tmuxResizePane")({
      paneId: "terminal_2",
    });
    expect(harness.resizePane).toHaveBeenCalledWith("left", 4);
  });

  it("routes zellij tab and session commands and disables swap", async () => {
    const harness = createZellijHarness();

    await getHandler(harness, "opencodeTui.tmuxNextWindow")();
    await getHandler(harness, "opencodeTui.tmuxPrevWindow")();
    await getHandler(harness, "opencodeTui.tmuxCreateWindow")();
    expect(harness.nextTab).toHaveBeenCalledTimes(1);
    expect(harness.prevTab).toHaveBeenCalledTimes(1);
    expect(harness.createTab).toHaveBeenCalledWith({
      workingDirectory: "/test/workspace",
    });

    mockQuickPickOnce(windowPick("2", "Tab 2: logs", "2"));
    await getHandler(harness, "opencodeTui.tmuxSelectWindow")();
    expect(harness.listTabs).toHaveBeenCalledTimes(1);
    expect(harness.selectTab).toHaveBeenCalledWith(2);

    mockWarningOnce("Kill");
    await getHandler(harness, "opencodeTui.tmuxKillWindow")({ windowId: "2" });
    expect(harness.selectTab).toHaveBeenLastCalledWith(2);
    expect(harness.killTab).toHaveBeenCalledTimes(1);

    await getHandler(harness, "opencodeTui.tmuxSwapPane")({
      paneId: "terminal_1",
    });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Swap pane is not supported for zellij",
    );

    mockWarningOnce("Kill");
    await getHandler(harness, "opencodeTui.tmuxKillSession")();
    expect(harness.killSession).toHaveBeenCalledWith("zellij-1");
  });

  it("no-ops pane commands for native backend", async () => {
    const harness = createZellijHarness();
    harness.deps.instanceStore?.upsert({
      config: { id: "instance-1", label: "Instance 1" },
      runtime: { terminalBackend: "native" },
      state: "connected",
    });

    await getHandler(harness, "opencodeTui.tmuxSwitchPane")({
      paneId: "terminal_2",
    });
    await getHandler(harness, "opencodeTui.tmuxNextWindow")();

    expect(harness.selectPane).not.toHaveBeenCalled();
    expect(harness.nextTab).not.toHaveBeenCalled();
  });

  it("refreshes the terminal manager", async () => {
    const harness = createHarness();

    await getHandler(harness, "opencodeTui.tmuxRefresh")();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencodeTui.openTerminalManager",
    );
  });
});
