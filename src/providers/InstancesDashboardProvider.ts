import * as vscode from "vscode";
import {
  InstanceId,
  InstanceRecord,
  InstanceState,
  InstanceStore,
} from "../services/InstanceStore";
import { InstanceController } from "../services/InstanceController";
import { CliToolType } from "../types";

type DashboardMessage = {
  action?:
    | "connect"
    | "disconnect"
    | "restart"
    | "focus"
    | "remove"
    | "openInNewWindow"
    | "newInstance";
  instanceId?: InstanceId;
  toolId?: CliToolType;
};

type DashboardInstanceDto = {
  id: InstanceId;
  label: string;
  port?: number;
  state: InstanceState;
  error?: string;
  sessionTitle?: string;
  model?: string;
  messageCount?: number;
  version?: string;
  toolId?: CliToolType;
};

const TOOL_ICONS: Record<CliToolType, string> = {
  opencode: "$(terminal)",
  claude: "$(comment)",
  codex: "$(code)",
  gemini: "$(star)",
  aider: "$(diff)",
};

const TOOL_COLORS: Record<CliToolType, string> = {
  opencode: "#3b82f6",
  claude: "#d97706",
  codex: "#10b981",
  gemini: "#8b5cf6",
  aider: "#ec4899",
};

export class InstancesDashboardProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "opencodeTui.instancesDashboard";

  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly instanceStore: InstanceStore,
    private readonly instanceController?: InstanceController,
    private readonly outputChannel?: vscode.OutputChannel,
  ) {
    this.subscriptions.push(
      this.instanceStore.onDidChange(() => {
        this.postInstancesToWebview();
      }),
    );

    this.subscriptions.push(
      this.instanceStore.onDidSetActive(() => {
        this.postInstancesToWebview();
      }),
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    this.subscriptions.push(
      webviewView.webview.onDidReceiveMessage((message) => {
        void this.handleWebviewMessage(message as DashboardMessage);
      }),
    );

    this.subscriptions.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.postInstancesToWebview();
        }
      }),
    );

    this.subscriptions.push(
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      }),
    );

    this.postInstancesToWebview();
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode Instances Dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    .header {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 4px;
      border-radius: 2px;
      flex: 1;
    }

    #instances {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .instance-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-sideBar-background) 15%);
    }

    .instance-card.active {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .title {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tool-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      color: #fff;
      font-weight: bold;
      text-transform: uppercase;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      color: #111;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .meta {
      margin: 2px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      word-break: break-word;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 12px;
    }

    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 8px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <div class="header">
    <select id="tool-filter">
      <option value="all">All Tools</option>
      <option value="opencode">OpenCode</option>
      <option value="claude">Claude</option>
      <option value="codex">Codex</option>
      <option value="gemini">Gemini</option>
      <option value="aider">Aider</option>
    </select>
    <select id="new-instance-tool">
      <option value="" disabled selected>+ New Instance</option>
      <option value="opencode">OpenCode</option>
      <option value="claude">Claude</option>
      <option value="codex">Codex</option>
      <option value="gemini">Gemini</option>
      <option value="aider">Aider</option>
    </select>
  </div>
  <div id="instances"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const stateColors = {
      connected: "#28a745",
      disconnected: "#6c757d",
      error: "#dc3545",
      spawning: "#ffc107",
      connecting: "#ffc107",
      resolving: "#ffc107",
      stopping: "#ffc107",
    };

    const toolColors = {
      opencode: '#3b82f6',
      claude: '#d97706',
      codex: '#10b981',
      gemini: '#8b5cf6',
      aider: '#ec4899'
    };

    const toolIcons = {
      opencode: '$(terminal)',
      claude: '$(comment)',
      codex: '$(code)',
      gemini: '$(star)',
      aider: '$(diff)'
    };

    let currentInstances = [];
    let currentActiveId = undefined;
    let currentFilter = 'all';

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function getActions(instance) {
      const id = escapeHtml(instance.id);
      return [
        '<button data-action="connect" data-id="' + id + '">Connect</button>',
        '<button data-action="disconnect" data-id="' + id + '">Disconnect</button>',
        '<button data-action="restart" data-id="' + id + '">Restart</button>',
        '<button data-action="focus" data-id="' + id + '">Focus</button>',
        '<button data-action="openInNewWindow" data-id="' + id + '">Open in New Window</button>',
        '<button data-action="remove" data-id="' + id + '">Remove</button>',
      ].join("");
    }

    function render() {
      const container = document.getElementById("instances");
      if (!container) {
        return;
      }

      const filteredInstances = currentFilter === 'all' 
        ? currentInstances 
        : currentInstances.filter(i => i.toolId === currentFilter);

      if (filteredInstances.length === 0) {
        container.innerHTML = '<div class="empty">No instances found.</div>';
        return;
      }

      container.innerHTML = filteredInstances
        .map((instance) => {
          const label = escapeHtml(instance.label || instance.id);
          const state = escapeHtml(instance.state);
          const stateColor = stateColors[instance.state] || "#6c757d";
          const portText = instance.port !== undefined ? String(instance.port) : "-";
          const sessionTitle = instance.sessionTitle ? escapeHtml(instance.sessionTitle) : "-";
          const model = instance.model ? escapeHtml(instance.model) : "-";
          const messageCount = instance.messageCount !== undefined ? String(instance.messageCount) : "-";
          const version = instance.version ? escapeHtml(instance.version) : "-";
          const error = instance.error ? '<div class="meta">error: ' + escapeHtml(instance.error) + '</div>' : "";
          const isActive = currentActiveId && currentActiveId === instance.id;
          
          const toolId = instance.toolId || 'opencode';
          const toolColor = toolColors[toolId] || toolColors.opencode;
          const toolIcon = toolIcons[toolId] || toolIcons.opencode;

          return [
            '<div class="instance-card' + (isActive ? ' active' : '') + '">',
            '<div class="row">',
            '<div class="title">',
            '<span class="tool-badge" style="background:' + toolColor + ';" title="' + toolIcon + '">' + escapeHtml(toolId) + '</span>',
            label,
            '</div>',
            '<span class="badge" style="background:' + stateColor + ';">' + state + '</span>',
            '</div>',
            '<div class="meta">id: ' + escapeHtml(instance.id) + '</div>',
            '<div class="meta">port: ' + escapeHtml(portText) + '</div>',
            '<div class="meta">session: ' + sessionTitle + '</div>',
            '<div class="meta">model: ' + model + '</div>',
            '<div class="meta">messages: ' + escapeHtml(messageCount) + '</div>',
            '<div class="meta">version: ' + version + '</div>',
            error,
            '<div class="actions">' + getActions(instance) + '</div>',
            '</div>',
          ].join("");
        })
        .join("");
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "updateInstances") {
        currentInstances = Array.isArray(message.instances) ? message.instances : [];
        currentActiveId = message.activeId;
        render();
      }
    });

    document.getElementById("tool-filter")?.addEventListener("change", (event) => {
      currentFilter = event.target.value;
      render();
    });

    document.getElementById("new-instance-tool")?.addEventListener("change", (event) => {
      const toolId = event.target.value;
      if (toolId) {
        vscode.postMessage({ action: "newInstance", toolId });
        event.target.value = ""; // reset selection
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      const action = target.dataset.action;
      const instanceId = target.dataset.id;
      if (!action || !instanceId) {
        return;
      }

      vscode.postMessage({ action, instanceId });
    });

    vscode.postMessage({ action: "ready" });
  </script>
</body>
</html>`;
  }

  private postInstancesToWebview(): void {
    if (!this.view) {
      return;
    }

    const instances: DashboardInstanceDto[] = this.instanceStore
      .getAll()
      .map((record) => this.toDashboardInstance(record));

    let activeId: InstanceId | undefined;
    try {
      activeId = this.instanceStore.getActive().config.id;
    } catch {
      activeId = undefined;
    }

    void this.view.webview.postMessage({
      type: "updateInstances",
      instances,
      activeId,
    });
  }

  private async handleWebviewMessage(message: DashboardMessage): Promise<void> {
    if (!message || !message.action) {
      return;
    }

    try {
      if (message.action === "newInstance" && message.toolId) {
        const newId = `instance-${Date.now()}`;
        this.instanceStore.upsert({
          config: {
            id: newId,
            toolId: message.toolId,
            label: `New ${message.toolId} Instance`,
          },
          runtime: {},
          state: "disconnected",
        });
        await this.instanceController?.spawn(newId);
        return;
      }

      if (!message.instanceId) {
        return;
      }

      switch (message.action) {
        case "connect":
          await this.connectInstance(message.instanceId);
          break;
        case "disconnect":
          await this.instanceController?.disconnect(message.instanceId);
          break;
        case "restart":
          await this.restartInstance(message.instanceId);
          break;
        case "focus":
          this.focusInstance(message.instanceId);
          break;
        case "remove":
          this.instanceStore.remove(message.instanceId);
          break;
        case "openInNewWindow": {
          const instance = this.instanceStore.get(message.instanceId);
          if (instance?.config.workspaceUri) {
            await vscode.commands.executeCommand(
              "vscode.openFolder",
              vscode.Uri.parse(instance.config.workspaceUri),
              { forceNewWindow: true },
            );
          }
          break;
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.outputChannel?.appendLine(
        `[InstancesDashboardProvider] Action '${message.action}' failed: ${errorMessage}`,
      );
      vscode.window.showErrorMessage(
        `Failed to ${message.action}: ${errorMessage}`,
      );
    }
  }

  private async connectInstance(instanceId: InstanceId): Promise<void> {
    if (!this.instanceController) {
      return;
    }

    const record = this.instanceStore.get(instanceId);
    if (!record) {
      return;
    }

    const resolvedPort =
      (await this.instanceController.resolve(instanceId)) ??
      record.runtime.port;

    if (resolvedPort !== undefined) {
      await this.instanceController.connect(instanceId, resolvedPort);
      return;
    }

    await this.instanceController.spawn(instanceId, {
      command: record.config.command,
      args: record.config.args,
      preferredPort: record.config.preferredPort,
    });
  }

  private async restartInstance(instanceId: InstanceId): Promise<void> {
    if (!this.instanceController) {
      return;
    }

    const record = this.instanceStore.get(instanceId);
    if (!record) {
      return;
    }

    await this.instanceController.kill(instanceId);
    await this.instanceController.spawn(instanceId, {
      command: record.config.command,
      args: record.config.args,
      preferredPort: record.config.preferredPort,
    });
  }

  private focusInstance(instanceId: InstanceId): void {
    this.instanceStore.setActive(instanceId);
    void vscode.commands.executeCommand("opencodeTui.focus");
  }

  private toDashboardInstance(record: InstanceRecord): DashboardInstanceDto {
    return {
      id: record.config.id,
      label: record.config.label ?? record.config.id,
      port: record.runtime.port,
      state: record.state,
      error: record.error,
      sessionTitle: record.health?.sessionTitle,
      model: record.health?.model,
      messageCount: record.health?.messageCount,
      version: record.health?.version,
      toolId: record.config.toolId,
    };
  }

  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return text;
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.view = undefined;
  }
}
