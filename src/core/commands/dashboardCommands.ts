import * as vscode from "vscode";
import type { TmuxSessionManager } from "../../services/TmuxSessionManager";
import type { InstanceStore } from "../../services/InstanceStore";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import type { OutputChannelService } from "../../services/OutputChannelService";
import { TmuxDashboardSessionDto } from "../../types";

export interface DashboardCommandDependencies {
  provider: TerminalProvider | undefined;
  tmuxManager: TmuxSessionManager | undefined;
  instanceStore: InstanceStore | undefined;
  outputChannel: OutputChannelService | undefined;
}

export function registerDashboardCommands(
  deps: DashboardCommandDependencies,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand("opencodeTui.toggleDashboard", () => {
      deps.provider?.toggleDashboard();
    }),
  );

  disposables.push(
    vscode.commands.registerCommand(
      "opencodeTui.toggleTmuxCommandToolbar",
      () => {
        deps.provider?.toggleTmuxCommandToolbar();
      },
    ),
  );

  disposables.push(
    vscode.commands.registerCommand("opencodeTui.openDashboardInEditor", () => {
      void openDashboardInEditor(deps);
    }),
  );

  return disposables;
}

async function openDashboardInEditor(
  deps: DashboardCommandDependencies,
): Promise<void> {
  if (!deps.tmuxManager) {
    void vscode.window.showErrorMessage("Tmux session manager not available");
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "opencodeTui.dashboardEditor",
    "Terminal Managers",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = getDashboardHtml();
  await updateDashboardWebview(panel.webview, deps);

  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case "refresh":
        await updateDashboardWebview(panel.webview, deps);
        break;
      case "activate":
        if (message.sessionId) {
          await vscode.commands.executeCommand(
            "opencodeTui.switchTmuxSession",
            message.sessionId,
          );
        }
        break;
      case "killSession":
        if (message.sessionId) {
          await vscode.commands.executeCommand(
            "opencodeTui.killTmuxSession",
            message.sessionId,
          );
          await updateDashboardWebview(panel.webview, deps);
        }
        break;
      case "create":
        await vscode.commands.executeCommand("opencodeTui.createTmuxSession");
        await updateDashboardWebview(panel.webview, deps);
        break;
    }
  }, undefined);

  panel.onDidChangeViewState(() => {
    if (panel.visible) {
      void updateDashboardWebview(panel.webview, deps);
    }
  });
}

async function updateDashboardWebview(
  webview: vscode.Webview,
  deps: DashboardCommandDependencies,
): Promise<void> {
  if (!deps.tmuxManager) return;

  try {
    const sessions = await deps.tmuxManager.discoverSessions();
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceName = workspacePath
      ? workspacePath.split("/").pop()
      : undefined;

    const payload: TmuxDashboardSessionDto[] = [];
    for (const session of sessions) {
      payload.push({
        id: session.id,
        name: session.name,
        workspace: session.workspace,
        isActive: session.isActive,
      });
    }

    await webview.postMessage({
      type: "updateDashboard",
      sessions: payload,
      workspace: workspaceName ?? "No workspace",
    });
  } catch (error) {
    deps.outputChannel?.error(
      `[Dashboard] Failed to update: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getDashboardHtml(): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal Dashboard</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      gap: 12px;
    }
    .header-main { flex: 1; }
    .title { font-size: 14px; font-weight: 600; }
    .workspace { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .actions { display: flex; gap: 6px; }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .session-list { display: flex; flex-direction: column; gap: 10px; }
    .session-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      cursor: pointer;
    }
    .session-card:hover { border-color: var(--vscode-focusBorder); }
    .session-card.active { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
    .row { display: flex; justify-content: space-between; align-items: center; }
    .status { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-top: 2px; }
    .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
    .preview {
      margin-top: 6px;
      padding: 4px 6px;
      background: var(--vscode-terminal-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 8px;
      line-height: 1.3;
      max-height: 60px;
      overflow: hidden;
      opacity: 0.85;
    }
    .preview-line { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; text-align: center; padding: 8px; font-size: 8px; }
    .kill-btn { background: transparent; border: 1px solid var(--vscode-input-border); color: var(--vscode-descriptionForeground); padding: 2px 6px; font-size: 11px; }
    .kill-btn:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-main">
      <div class="title">Terminal Dashboard</div>
      <div class="workspace" id="workspace">Workspace: -</div>
    </div>
    <div class="actions">
      <button id="create" class="primary">New tmux</button>
      <button id="refresh">Refresh</button>
    </div>
  </div>
  <div id="session-list" class="session-list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function render(sessions, workspace) {
      document.getElementById("workspace").textContent = "Workspace: " + (workspace || "-");
      const list = document.getElementById("session-list");

      if (!sessions || sessions.length === 0) {
        list.innerHTML = '<div class="empty">No tmux sessions for this workspace.</div>';
        return;
      }

      list.innerHTML = sessions.map(s => {
        const activeClass = s.isActive ? " active" : "";
        const statusText = s.isActive ? "Current" : "Available";
        const previewHtml = s.preview
          ? '<div class="preview">' + s.preview.split(/\\r?\n/).filter(l => l.trim()).slice(-4)
              .map(l => '<div class="preview-line">' + escapeHtml(l) + '</div>').join("") + '</div>'
          : '<div class="preview empty">No preview available</div>';

        return '<div class="session-card' + activeClass + '" data-session-id="' + escapeHtml(s.id) + '">' +
          '<div class="row">' +
            '<div><strong>' + escapeHtml(s.name) + '</strong><div class="status">' + statusText + '</div></div>' +
            '<button class="kill-btn" data-action="kill" data-id="' + escapeHtml(s.id) + '">✕</button>' +
          '</div>' +
          '<div class="meta">tmux: ' + escapeHtml(s.id) + ' · workspace: ' + escapeHtml(s.workspace) + '</div>' +
          previewHtml +
        '</div>';
      }).join("");
    }

    window.addEventListener("message", event => {
      const message = event.data;
      if (message.type === "updateDashboard") {
        render(message.sessions, message.workspace);
      }
    });

    document.addEventListener("click", event => {
      const target = event.target;
      if (target.id === "create") {
        vscode.postMessage({ type: "create" });
      } else if (target.id === "refresh") {
        vscode.postMessage({ type: "refresh" });
      } else if (target.dataset.action === "kill") {
        vscode.postMessage({ type: "killSession", sessionId: target.dataset.id });
      } else {
        const card = target.closest(".session-card");
        if (card && card.dataset.sessionId) {
          vscode.postMessage({ type: "activate", sessionId: card.dataset.sessionId });
        }
      }
    });

    vscode.postMessage({ type: "refresh" });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
