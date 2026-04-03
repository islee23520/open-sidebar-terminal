export type WebviewMessage =
  | { type: "terminalInput"; data: string }
  | { type: "terminalResize"; cols: number; rows: number }
  | { type: "listTerminals" }
  | {
      type: "terminalAction";
      action: "focus" | "sendCommand" | "capture";
      terminalName: string;
      command?: string;
    }
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
    }
  | { type: "getClipboard" }
  | { type: "setClipboard"; text: string }
  | { type: "triggerPaste" }
  | { type: "imagePasted"; data: string }
  | { type: "switchSession"; sessionId: string }
  | { type: "killSession"; sessionId: string }
  | { type: "createTmuxSession" }
  | { type: "createTmuxWindow" }
  | { type: "navigateTmuxWindow"; direction: "next" | "prev" }
  | { type: "navigateTmuxSession"; direction: "next" | "prev" }
  | { type: "switchNativeShell" }
  | {
      type: "launchAiTool";
      sessionId: string;
      tool: string;
      savePreference: boolean;
    }
  | { type: "splitTmuxPane"; direction: "h" | "v" }
  | { type: "killTmuxPane" };

export type AiTool = string;

export interface AiToolConfig {
  name: string;
  label: string;
  path: string;
  args: string[];
  aliases?: string[];
  operator?: string;
}

/** Built-in default tools — used when no user config exists */
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
    name: "claude-code",
    label: "Claude Code",
    path: "",
    args: [],
    aliases: ["claude"],
    operator: "claude-code",
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

/** @deprecated Use resolveAiToolConfigs() instead */
export const AI_TOOLS = DEFAULT_AI_TOOLS;

/** Resolves AI tool configs from VS Code settings, merging with defaults */
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

/** Get the launch command string for a tool config */
export function getToolLaunchCommand(tool: AiToolConfig): string {
  const exe = tool.path || tool.name;
  const args = tool.args.length > 0 ? ` ${tool.args.join(" ")}` : "";
  return exe + args;
}

/** Get detection patterns for matching pane_current_command */
export function getToolDetectionPatterns(tool: AiToolConfig): string[] {
  const patterns: string[] = [tool.name];
  patterns.push(`${tool.name}.exe`);
  if (tool.path) {
    const basename = tool.path
      .split("/")
      .pop()
      ?.split("\\")
      .pop()
      ?.replace(/\.exe$/i, "");
    if (basename && basename !== tool.name) {
      patterns.push(basename);
    }
  }
  return patterns;
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
    };

export type TmuxDashboardSessionDto = {
  id: string;
  name: string;
  workspace: string;
  isActive: boolean;
  paneCount?: number;
};

export type TmuxDashboardPaneDto = {
  paneId: string;
  index: number;
  title: string;
  isActive: boolean;
  currentCommand?: string;
  windowId?: string;
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
    }
  | {
      type: "showAiToolSelector";
      sessionId: string;
      sessionName: string;
      defaultTool?: string;
      tools?: AiToolConfig[];
    };

export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

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
  | { type: "clipboardContent"; text: string }
  | { type: "terminalList"; terminals: Array<{ name: string; cwd: string }> }
  | { type: "terminalOutput"; data: string }
  | { type: "terminalExited" }
  | { type: "clearTerminal" }
  | { type: "focusTerminal" }
  | { type: "webviewVisible" }
  | { type: "platformInfo"; platform: string }
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
    }
  | { type: "activeSession" }
  | {
      type: "showAiToolSelector";
      sessionId: string;
      sessionName: string;
      defaultTool?: string;
      tools?: AiToolConfig[];
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
}
