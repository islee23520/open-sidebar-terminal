import * as vscode from "vscode";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import type { ContextSharingService } from "../../services/ContextSharingService";
import type { OutputChannelService } from "../../services/OutputChannelService";
import type { TerminalManager } from "../../terminals/TerminalManager";

let fileSendAccumulator: vscode.Uri[] = [];
let fileSendTimeout: NodeJS.Timeout | undefined;

export interface TerminalCommandDependencies {
  provider: TerminalProvider | undefined;
  terminalManager: TerminalManager | undefined;
  contextSharingService: ContextSharingService | undefined;
  outputChannel: OutputChannelService | undefined;
  getActiveTerminalId: () => string;
  sendTerminalCwd: () => void;
  sendPrompt: (prompt: string) => Promise<void>;
}

function focusSidebarIfConfigured(
  provider: TerminalProvider | undefined,
): void {
  const config = vscode.workspace.getConfiguration("opencodeTui");
  if (config.get<boolean>("autoFocusOnSend", true)) {
    vscode.commands.executeCommand("opencodeTui.focus");
    setTimeout(() => {
      provider?.focus();
    }, 100);
  }
}

export function registerTerminalCommands(
  deps: TerminalCommandDependencies,
): vscode.Disposable[] {
  const startCommand = vscode.commands.registerCommand(
    "opencodeTui.start",
    () => {
      deps.provider?.startOpenCode();
    },
  );

  const sendToTerminalCommand = vscode.commands.registerCommand(
    "opencodeTui.sendToTerminal",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const selectedText = editor.document.getText(editor.selection);
        const terminalId = deps.getActiveTerminalId();
        deps.outputChannel?.info(
          `[DIAG:sendToTerminal] terminalId="${terminalId}" textLength=${selectedText.length}`,
        );
        void deps.sendPrompt(selectedText + "\n");
        focusSidebarIfConfigured(deps.provider);
      }
    },
  );

  const sendAtMentionCommand = vscode.commands.registerCommand(
    "opencodeTui.sendAtMention",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const fileRef = deps.provider?.formatEditorReference(editor);
        if (!fileRef) {
          deps.outputChannel?.warn(
            `[DIAG:sendAtMention] skipped — provider=${!!deps.provider} editor=${!!editor}`,
          );
          deps.sendTerminalCwd();
          return;
        }
        const terminalId = deps.getActiveTerminalId();
        deps.outputChannel?.info(
          `[DIAG:sendAtMention] terminalId="${terminalId}" fileRef="${fileRef}"`,
        );
        void deps.sendPrompt(fileRef + " ");
        focusSidebarIfConfigured(deps.provider);
      } else {
        deps.outputChannel?.warn(
          `[DIAG:sendAtMention] skipped — editor=${!!editor} contextSharingService=${!!deps.contextSharingService}`,
        );
        deps.sendTerminalCwd();
      }
    },
  );

  const sendAllOpenFilesCommand = vscode.commands.registerCommand(
    "opencodeTui.sendAllOpenFiles",
    () => {
      const fileRefs: string[] = [];

      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            const uri = tab.input.uri;
            if (!uri.scheme.startsWith("untitled") && deps.provider) {
              fileRefs.push(deps.provider.formatUriReference(uri));
            }
          }
        }
      }

      const openFiles = fileRefs.join(" ");
      if (openFiles) {
        const terminalId = deps.getActiveTerminalId();
        deps.outputChannel?.info(
          `[DIAG:sendAllOpenFiles] terminalId="${terminalId}" fileCount=${fileRefs.length} refs="${openFiles}"`,
        );
        void deps.sendPrompt(openFiles + " ");
        focusSidebarIfConfigured(deps.provider);
      }
    },
  );

  const sendFileToTerminalCommand = vscode.commands.registerCommand(
    "opencodeTui.sendFileToTerminal",
    (...args: unknown[]) => {
      if (!deps.contextSharingService) {
        return;
      }

      let uris: vscode.Uri[];
      if (args.length > 0 && Array.isArray(args[args.length - 1])) {
        uris = args[args.length - 1] as vscode.Uri[];
      } else if (args.length > 0 && args[0] instanceof vscode.Uri) {
        uris = [args[0]];
      } else {
        return;
      }

      fileSendAccumulator.push(...uris);

      if (fileSendTimeout) {
        clearTimeout(fileSendTimeout);
      }

      fileSendTimeout = setTimeout(() => {
        if (fileSendAccumulator.length === 0) {
          return;
        }

        if (!deps.provider) {
          fileSendAccumulator = [];
          return;
        }

        const uniqueUris = [
          ...new Map(
            fileSendAccumulator.map((u: vscode.Uri) => [u.fsPath, u]),
          ).values(),
        ];

        const fileRefs = uniqueUris.map((u: vscode.Uri) =>
          deps.provider!.formatUriReference(u),
        );
        const allRefs = fileRefs.join(" ");

        const terminalId = deps.getActiveTerminalId();
        deps.outputChannel?.info(
          `[DIAG:sendFileToTerminal] terminalId="${terminalId}" fileCount=${uniqueUris.length} refs="${allRefs}"`,
        );
        void deps.sendPrompt(allRefs + " ");

        focusSidebarIfConfigured(deps.provider);
        fileSendAccumulator = [];
      }, 100);
    },
  );

  const restartCommand = vscode.commands.registerCommand(
    "opencodeTui.restart",
    () => {
      deps.provider?.restart();
      vscode.window.showInformationMessage("OpenCode restarted");
    },
  );

  const pasteCommand = vscode.commands.registerCommand(
    "opencodeTui.paste",
    async () => {
      try {
        const text = await vscode.env.clipboard.readText();
        if (text && deps.provider) {
          deps.provider.pasteText(text);
        }
      } catch (error) {
        deps.outputChannel?.error(
          `[TerminalProvider] Failed to paste: ${error instanceof Error ? error.message : String(error)}`,
        );
        vscode.window.showErrorMessage("Failed to paste from clipboard");
      }
    },
  );

  const focusCommand = vscode.commands.registerCommand(
    "opencodeTui.focus",
    () => {
      vscode.commands.executeCommand("workbench.view.focus", "opencodeTui");
    },
  );

  return [
    startCommand,
    sendToTerminalCommand,
    sendAtMentionCommand,
    sendAllOpenFilesCommand,
    sendFileToTerminalCommand,
    restartCommand,
    pasteCommand,
    focusCommand,
  ];
}
