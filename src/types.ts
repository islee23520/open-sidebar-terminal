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
  | { type: "filesDropped"; files: string[]; shiftKey: boolean }
  | { type: "getClipboard" }
  | { type: "setClipboard"; text: string }
  | { type: "triggerPaste" }
  | { type: "imagePasted"; data: string }
  | { type: "switchSession"; sessionId: string }
  | { type: "killSession"; sessionId: string }
  | { type: "createTmuxSession" }
  | { type: "switchNativeShell" };

export type AiTool = "opencode" | "claude" | "codex";

export const AI_TOOLS: readonly {
  id: AiTool;
  label: string;
  command: string;
}[] = [
  { id: "opencode", label: "OpenCode", command: "opencode" },
  { id: "claude", label: "Claude", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
] as const;

export type TmuxDashboardActionMessage =
  | { action: "refresh" }
  | { action: "create" }
  | { action: "switchNativeShell" }
  | { action: "activate"; sessionId: string }
  | { action: "expandPanes"; sessionId: string }
  | { action: "killSession"; sessionId: string }
  | { action: "switchPane"; sessionId: string; paneId: string }
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
  | {
      action: "sendTextToPane";
      sessionId: string;
      paneId: string;
      text: string;
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
      tool: AiTool;
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
};

export type TmuxDashboardHostMessage =
  | {
      type: "updateTmuxSessions";
      sessions: TmuxDashboardSessionDto[];
      workspace: string;
      panes?: Record<string, TmuxDashboardPaneDto[]>;
      showingAll?: boolean;
    }
  | {
      type: "showAiToolSelector";
      sessionId: string;
      sessionName: string;
      defaultTool?: AiTool;
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
