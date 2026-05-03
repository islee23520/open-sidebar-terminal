export const TMUX_WEBVIEW_COMMAND_IDS = [
  "opencodeTui.browseTmuxSessions",
  "opencodeTui.createTmuxSession",
  "opencodeTui.tmuxSwitchPane",
  "opencodeTui.tmuxCreateWindow",
  "opencodeTui.tmuxNextWindow",
  "opencodeTui.tmuxPrevWindow",
  "opencodeTui.tmuxSelectWindow",
  "opencodeTui.tmuxKillWindow",
  "opencodeTui.tmuxSplitPaneH",
  "opencodeTui.tmuxSplitPaneV",
  "opencodeTui.tmuxSplitPaneWithCommand",
  "opencodeTui.tmuxSendTextToPane",
  "opencodeTui.tmuxResizePane",
  "opencodeTui.tmuxSwapPane",
  "opencodeTui.tmuxKillPane",
  "opencodeTui.tmuxKillSession",
  "opencodeTui.tmuxRefresh",
] as const;

export type TmuxWebviewCommandId = (typeof TMUX_WEBVIEW_COMMAND_IDS)[number];

export const TMUX_RAW_ALLOWED_SUBCOMMANDS = [
  "rename-session",
  "rename-window",
  "last-window",
  "last-pane",
  "rotate-window",
  "select-layout",
  "display-panes",
  "copy-mode",
  "clear-history",
  "detach-client",
  "move-window",
  "move-pane",
  "respawn-pane",
  "choose-tree",
] as const;

export type TmuxRawSubcommand = (typeof TMUX_RAW_ALLOWED_SUBCOMMANDS)[number];

export interface DroppedBlobFile {
  name: string;
  data: string;
}

export type TerminalBackendType = "native" | "tmux" | "zellij";

export interface TerminalBackendAvailability {
  native: boolean;
  tmux: boolean;
  zellij: boolean;
}

export type WebviewMessage =
  | { type: "terminalInput"; data: string }
  | { type: "terminalResize"; cols: number; rows: number }
  | { type: "listTerminals" }
  | {
      type: "openFile";
      path: string;
      line?: number;
      endLine?: number;
      column?: number;
    }
  | { type: "openUrl"; url: string }
  | { type: "ready"; cols: number; rows: number }
  | {
      type: "filesDropped";
      files: string[];
      shiftKey: boolean;
      dropCell?: { col: number; row: number };
      blobFiles?: DroppedBlobFile[];
    }
  | { type: "setClipboard"; text: string }
  | { type: "triggerPaste" }
  | { type: "imagePasted"; data: string }
  | { type: "switchSession"; sessionId: string }
  | { type: "killSession"; sessionId: string }
  | { type: "createTmuxSession" }
  | {
      type: "launchAiTool";
      sessionId: string;
      tool: string;
      savePreference: boolean;
      targetPaneId?: string;
    }
  | { type: "zoomTmuxPane" }
  | { type: "toggleDashboard" }
  | { type: "toggleEditorAttachment" }
  | { type: "sendTmuxPromptChoice"; choice: "tmux" | "shell" | "zellij" }
  | { type: "selectTerminalBackend"; backend: TerminalBackendType }
  | { type: "cycleTerminalBackend" }
  | { type: "requestAiToolSelector" }
  | { type: "executeTmuxCommand"; commandId: TmuxWebviewCommandId }
  | {
      type: "executeTmuxRawCommand";
      subcommand: TmuxRawSubcommand;
      args?: string[];
    }
  | { type: "requestRestart" };

export type AiTool = string;

export interface AiToolConfig {
  name: string;
  label: string;
  path: string;
  args: string[];
  aliases?: string[];
  operator?: string;
}

export const DEFAULT_AI_TOOLS: readonly AiToolConfig[] = [
  {
    name: "opencode",
    label: "OpenCode",
    path: "",
    args: ["-c"],
    aliases: [],
    operator: "opencode",
  },
  {
    name: "claude",
    label: "Claude Code",
    path: "",
    args: [],
    aliases: ["claude"],
    operator: "claude",
  },
  {
    name: "codex",
    label: "Codex",
    path: "",
    args: [],
    aliases: [],
    operator: "codex",
  },
] as const;

export function resolveAiToolConfigs(
  userTools: readonly unknown[],
): AiToolConfig[] {
  if (!Array.isArray(userTools) || userTools.length === 0) {
    return [...DEFAULT_AI_TOOLS];
  }
  return userTools
    .filter(
      (t): t is Record<string, unknown> =>
        t !== null &&
        typeof t === "object" &&
        typeof (t as Record<string, unknown>).name === "string" &&
        typeof (t as Record<string, unknown>).label === "string",
    )
    .map((t) => ({
      name: String(t.name),
      label: String(t.label),
      path: typeof t.path === "string" ? t.path : "",
      args: Array.isArray(t.args) ? t.args.map(String) : [],
      aliases: Array.isArray(t.aliases) ? t.aliases.map(String) : undefined,
      operator: typeof t.operator === "string" ? t.operator : undefined,
    }));
}

export function getToolLaunchCommand(tool: AiToolConfig): string {
  const exe = tool.path || tool.name;
  const args = tool.args.length > 0 ? ` ${tool.args.join(" ")}` : "";
  return exe + args;
}

export function getToolDetectionPatterns(tool: AiToolConfig): string[] {
  const patterns = new Set<string>([tool.name, `${tool.name}.exe`]);
  if (tool.operator) {
    patterns.add(tool.operator);
    patterns.add(`${tool.operator}.exe`);
  }
  for (const alias of tool.aliases ?? []) {
    patterns.add(alias);
    patterns.add(`${alias}.exe`);
  }
  patterns.add(tool.label);
  if (tool.path) {
    const basename = tool.path
      .split("/")
      .pop()
      ?.split("\\")
      .pop()
      ?.replace(/\.exe$/i, "");
    if (basename && basename !== tool.name) {
      patterns.add(basename);
    }
  }
  return [...patterns];
}

export function detectAiToolName(
  text: string | undefined,
  tools: readonly AiToolConfig[],
): string | undefined {
  const haystack = text?.toLowerCase();
  if (!haystack) {
    return undefined;
  }

  for (const tool of tools) {
    const patterns = getToolDetectionPatterns(tool).map((pattern) =>
      pattern.toLowerCase(),
    );
    if (patterns.some((pattern) => pattern && haystack.includes(pattern))) {
      return tool.name;
    }
  }

  return undefined;
}

export type NativeShellDto = {
  id: string;
  label?: string;
  state: string;
  isActive: boolean;
};

export type TmuxDashboardActionMessage =
  | { action: "refresh" }
  | { action: "toggleScope" }
  | { action: "create" }
  | { action: "createNativeShell" }
  | { action: "switchNativeShell" }
  | { action: "activateNativeShell"; instanceId: string }
  | { action: "killNativeShell"; instanceId: string }
  | { action: "activate"; sessionId: string }
  | {
      action: "showAiToolSelector";
      sessionId: string;
      sessionName: string;
      targetPaneId?: string;
    }
  | { action: "expandPanes"; sessionId: string }
  | { action: "createWindow"; sessionId: string }
  | { action: "nextWindow"; sessionId: string }
  | { action: "prevWindow"; sessionId: string }
  | { action: "killWindow"; sessionId: string; windowId: string }
  | { action: "killSession"; sessionId: string }
  | { action: "selectWindow"; sessionId: string; windowId: string }
  | {
      action: "switchPane";
      sessionId: string;
      paneId: string;
      windowId?: string;
    }
  | {
      action: "splitPane";
      sessionId: string;
      paneId?: string;
      direction: "h" | "v";
    }
  | {
      action: "splitPaneWithCommand";
      sessionId: string;
      paneId?: string;
      direction: "h" | "v";
      command: string;
    }
  | { action: "killPane"; sessionId: string; paneId: string }
  | {
      action: "resizePane";
      sessionId: string;
      paneId: string;
      direction: string;
      amount: number;
    }
  | {
      action: "swapPane";
      sessionId: string;
      sourcePaneId: string;
      targetPaneId: string;
    }
  | {
      action: "launchAiTool";
      sessionId: string;
      tool: string;
      savePreference: boolean;
      targetPaneId?: string;
    };

export type TmuxDashboardSessionDto = {
  id: string;
  name: string;
  workspace: string;
  isActive: boolean;
  paneCount?: number;
  preview?: string;
};

export type TmuxDashboardPaneDto = {
  paneId: string;
  index: number;
  title: string;
  isActive: boolean;
  currentCommand?: string;
  panePid?: number;
  resolvedTool?: string;
  windowId?: string;
  currentPath?: string;
  paneLeft?: number;
  paneTop?: number;
  paneWidth?: number;
  paneHeight?: number;
};

export type TmuxDashboardWindowDto = {
  windowId: string;
  index: number;
  name: string;
  isActive: boolean;
  panes: TmuxDashboardPaneDto[];
};

export type TmuxDashboardHostMessage =
  | {
      type: "updateTmuxSessions";
      sessions: TmuxDashboardSessionDto[];
      nativeShells?: NativeShellDto[];
      workspace: string;
      windows?: Record<string, TmuxDashboardWindowDto[]>;
      panes?: Record<string, TmuxDashboardPaneDto[]>;
      showingAll?: boolean;
      tools?: AiToolConfig[];
      tmuxAvailable?: boolean;
    }
  | {
      type: "showAiToolSelector";
      sessionId: string;
      sessionName: string;
      defaultTool?: string;
      tools?: AiToolConfig[];
      targetPaneId?: string;
    };

export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export interface TmuxSession {
  id: string;
  name: string;
  workspace: string;
  isActive: boolean;
}

export interface TreeSnapshot {
  type: "treeSnapshot";
  sessions: TmuxSession[];
  activeSessionId: string | null;
  emptyState?: "no-workspace" | "no-tmux" | "no-sessions";
}

export type HostMessage =
  | { type: "requestPaste" }
  | { type: "clipboardContent"; text: string }
  | { type: "terminalList"; terminals: Array<{ name: string; cwd: string }> }
  | { type: "terminalOutput"; data: string }
  | { type: "terminalExited" }
  | { type: "clearTerminal" }
  | { type: "focusTerminal" }
  | { type: "webviewVisible" }
  | {
      type: "platformInfo";
      platform: string;
      tmuxAvailable?: boolean;
      zellijAvailable?: boolean;
      backendAvailability?: TerminalBackendAvailability;
      activeBackend?: TerminalBackendType;
    }
  | {
      type: "terminalConfig";
      fontSize: number;
      fontFamily: string;
      cursorBlink: boolean;
      cursorStyle: "block" | "underline" | "bar";
      scrollback: number;
    }
  | {
      type: "activeSession";
      sessionName: string;
      sessionId: string;
      windowIndex?: number;
      windowName?: string;
      canKillPane?: boolean;
      backend?: TerminalBackendType;
    }
  | { type: "activeSession"; backend?: TerminalBackendType }
  | {
      type: "showAiToolSelector";
      sessionId: string;
      sessionName: string;
      defaultTool?: string;
      tools?: AiToolConfig[];
      targetPaneId?: string;
    }
  | {
      type: "updateDashboard";
      sessions: TmuxDashboardSessionDto[];
      workspace: string;
      showingAll?: boolean;
    }
  | { type: "toggleDashboard"; visible: boolean }
  | { type: "toggleTmuxCommandToolbar" }
  | {
      type: "showTmuxPrompt";
      workspaceName: string;
      tmuxAvailable?: boolean;
      zellijAvailable?: boolean;
      activeBackend?: TerminalBackendType;
    };

export type LogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface ExtensionConfig {
  autoStart: boolean;
  command: string;
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  autoFocusOnSend: boolean;
  autoStartOnOpen: boolean;
  shellPath: string;
  shellArgs: string[];
  autoShareContext: boolean;
  httpTimeout: number;
  enableHttpApi: boolean;
  logLevel: LogLevel;
  contextDebounceMs: number;
  maxDiagnosticLength: number;
  enableAutoSpawn: boolean;
  codeActionSeverities: DiagnosticSeverity[];
  collapseSecondaryBarOnEditorOpen: boolean;
  terminalBackend: TerminalBackendType;
}
