import * as vscode from "vscode";
import type { ContextManager } from "../../services/ContextManager";
import type { ContextSharingService } from "../../services/ContextSharingService";
import type { InstanceController } from "../../services/InstanceController";
import type { InstanceQuickPick } from "../../services/InstanceQuickPick";
import type { InstanceStore } from "../../services/InstanceStore";
import type { OutputChannelService } from "../../services/OutputChannelService";
import type { TerminalManager } from "../../terminals/TerminalManager";
import type { OpenCodeTuiProvider } from "../../providers/OpenCodeTuiProvider";
import type { TmuxSessionManager } from "../../services/TmuxSessionManager";
import {
  registerTerminalCommands,
  type TerminalCommandDependencies,
} from "./terminalCommands";
import {
  registerTmuxSessionCommands,
  type TmuxSessionCommandDependencies,
} from "./tmuxSessionCommands";
import {
  registerTmuxPaneCommands,
  type TmuxPaneCommandDependencies,
} from "./tmuxPaneCommands";

export interface RegisterCommandDependencies
  extends
    TerminalCommandDependencies,
    TmuxSessionCommandDependencies,
    TmuxPaneCommandDependencies {
  provider: OpenCodeTuiProvider | undefined;
  tmuxManager: TmuxSessionManager | undefined;
  terminalManager: TerminalManager | undefined;
  contextSharingService: ContextSharingService | undefined;
  contextManager: ContextManager | undefined;
  instanceStore: InstanceStore | undefined;
  instanceController: InstanceController | undefined;
  instanceQuickPick: InstanceQuickPick | undefined;
  outputChannel: OutputChannelService | undefined;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: RegisterCommandDependencies,
): void {
  const disposables: vscode.Disposable[] = [
    ...registerTerminalCommands(deps),
    ...registerTmuxSessionCommands(deps),
    ...registerTmuxPaneCommands(deps),
  ];

  context.subscriptions.push(...disposables);
}

export {
  registerTerminalCommands,
  registerTmuxSessionCommands,
  registerTmuxPaneCommands,
};
