import { describe, it, expect } from "vitest";
import type {
  HostMessage,
  TmuxDashboardActionMessage,
  TmuxDashboardHostMessage,
  WebviewMessage,
} from "./types";
import { DEFAULT_AI_TOOLS, TMUX_RAW_ALLOWED_SUBCOMMANDS } from "./types";

describe("Types", () => {
  describe("WebviewMessage", () => {
    it("should accept terminalInput message", () => {
      const message: WebviewMessage = {
        type: "terminalInput",
        data: "test input",
      };

      expect(message.type).toBe("terminalInput");
      expect(message.data).toBe("test input");
    });

    it("should accept terminalResize message", () => {
      const message: WebviewMessage = {
        type: "terminalResize",
        cols: 80,
        rows: 24,
      };

      expect(message.type).toBe("terminalResize");
      expect(message.cols).toBe(80);
      expect(message.rows).toBe(24);
    });

    it("should accept openFile message with line", () => {
      const message: WebviewMessage = {
        type: "openFile",
        path: "/test/file.ts",
        line: 10,
      };

      expect(message.type).toBe("openFile");
      expect(message.path).toBe("/test/file.ts");
      expect(message.line).toBe(10);
    });

    it("should accept openFile message with line and column", () => {
      const message: WebviewMessage = {
        type: "openFile",
        path: "/test/file.ts",
        line: 10,
        column: 5,
      };

      expect(message.type).toBe("openFile");
      expect(message.path).toBe("/test/file.ts");
      expect(message.line).toBe(10);
      expect(message.column).toBe(5);
    });

    it("should accept openUrl message", () => {
      const message: WebviewMessage = {
        type: "openUrl",
        url: "https://example.com",
      };

      expect(message.type).toBe("openUrl");
      expect(message.url).toBe("https://example.com");
    });

    it("should accept ready message", () => {
      const message: WebviewMessage = {
        type: "ready",
        cols: 80,
        rows: 24,
      };

      expect(message.type).toBe("ready");
      expect(message.cols).toBe(80);
      expect(message.rows).toBe(24);
    });

    it("should accept filesDropped message", () => {
      const message: WebviewMessage = {
        type: "filesDropped",
        files: ["/file1.ts", "/file2.ts"],
        shiftKey: true,
      };

      expect(message.type).toBe("filesDropped");
      expect(message.files).toEqual(["/file1.ts", "/file2.ts"]);
      expect(message.shiftKey).toBe(true);
    });

    it("should accept filesDropped blob fallback message", () => {
      const message: WebviewMessage = {
        type: "filesDropped",
        files: [],
        shiftKey: false,
        blobFiles: [
          {
            name: "note.txt",
            data: "data:text/plain;base64,SGVsbG8=",
          },
        ],
      };

      expect(message.type).toBe("filesDropped");
      expect(message.files).toEqual([]);
      expect(message.blobFiles).toEqual([
        {
          name: "note.txt",
          data: "data:text/plain;base64,SGVsbG8=",
        },
      ]);
    });

    it("should accept tmux session control messages", () => {
      const switchMessage: WebviewMessage = {
        type: "switchSession",
        sessionId: "workspace-a",
      };
      const killMessage: WebviewMessage = {
        type: "killSession",
        sessionId: "workspace-a",
      };
      const createMessage: WebviewMessage = {
        type: "createTmuxSession",
      };

      expect(switchMessage.type).toBe("switchSession");
      expect(switchMessage.sessionId).toBe("workspace-a");
      expect(killMessage.type).toBe("killSession");
      expect(killMessage.sessionId).toBe("workspace-a");
      expect(createMessage.type).toBe("createTmuxSession");
    });

    it("should accept executeTmuxCommand messages for supported toolbar commands", () => {
      const message: WebviewMessage = {
        type: "executeTmuxCommand",
        commandId: "opencodeTui.tmuxCreateWindow",
      };

      expect(message.type).toBe("executeTmuxCommand");
      expect(message.commandId).toBe("opencodeTui.tmuxCreateWindow");
    });

    it("should accept executeTmuxRawCommand messages for supported native tmux commands", () => {
      const message: WebviewMessage = {
        type: "executeTmuxRawCommand",
        subcommand: "rename-session",
        args: ["workspace-renamed"],
      };

      expect(message.type).toBe("executeTmuxRawCommand");
      expect(message.subcommand).toBe("rename-session");
      expect(message.args).toEqual(["workspace-renamed"]);
      expect(TMUX_RAW_ALLOWED_SUBCOMMANDS).toContain("choose-tree");
    });

    it("should accept tmux command toolbar host messages", () => {
      const message: HostMessage = {
        type: "toggleTmuxCommandToolbar",
      };

      expect(message.type).toBe("toggleTmuxCommandToolbar");
    });
  });

  describe("Tmux dashboard messages", () => {
    it("should accept tmux dashboard action messages", () => {
      const createMessage: TmuxDashboardActionMessage = {
        action: "create",
      };
      const switchNativeMessage: TmuxDashboardActionMessage = {
        action: "switchNativeShell",
      };
      const activateMessage: TmuxDashboardActionMessage = {
        action: "activate",
        sessionId: "workspace-a-2",
      };

      expect(createMessage.action).toBe("create");
      expect(switchNativeMessage.action).toBe("switchNativeShell");
      expect(activateMessage.action).toBe("activate");
      expect(activateMessage.sessionId).toBe("workspace-a-2");

      const launchMessage: TmuxDashboardActionMessage = {
        action: "launchAiTool",
        sessionId: "workspace-a-2",
        tool: "custom-tool",
        savePreference: true,
      };
      expect(launchMessage.action).toBe("launchAiTool");
      expect(launchMessage.tool).toBe("custom-tool");
    });

    it("should accept tmux dashboard host messages", () => {
      const message: TmuxDashboardHostMessage = {
        type: "updateTmuxSessions",
        workspace: "repo-a",
        sessions: [
          {
            id: "repo-a-2",
            name: "repo-a-2",
            workspace: "repo-a",
            isActive: true,
          },
        ],
      };

      expect(message.type).toBe("updateTmuxSessions");
      expect(message.workspace).toBe("repo-a");
      expect(message.sessions[0]?.isActive).toBe(true);
    });

    it("uses default AI tools baseline", () => {
      expect(DEFAULT_AI_TOOLS[0]?.name).toBe("opencode");
      expect(DEFAULT_AI_TOOLS[0]?.args).toEqual(["-c"]);
      expect(DEFAULT_AI_TOOLS[1]?.name).toBe("claude");
      expect(DEFAULT_AI_TOOLS[1]?.aliases).toContain("claude");
    });
  });

  describe("HostMessage", () => {
    it("should accept terminalOutput message", () => {
      const message: HostMessage = {
        type: "terminalOutput",
        data: "output data",
      };

      expect(message.type).toBe("terminalOutput");
      expect(message.data).toBe("output data");
    });

    it("should accept terminalExited message", () => {
      const message: HostMessage = {
        type: "terminalExited",
      };

      expect(message.type).toBe("terminalExited");
    });

    it("should accept focusTerminal message", () => {
      const message: HostMessage = {
        type: "focusTerminal",
      };

      expect(message.type).toBe("focusTerminal");
    });
  });
});
