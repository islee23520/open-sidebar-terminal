import * as path from "node:path";
import * as vscode from "vscode";
import type { HerdrAgent, HerdrSpace } from "./types";

export interface HerdrExplorerSource {
  listWorkspaces(): Promise<readonly HerdrSpace[]>;
  listAgents(): Promise<readonly HerdrAgent[]>;
}

export interface HerdrSpaceNode {
  readonly kind: "space";
  readonly space: HerdrSpace;
}

export interface HerdrAgentNode {
  readonly kind: "agent";
  readonly agent: HerdrAgent;
}

export class HerdrSnapshotStore {
  private cachedSpaces: readonly HerdrSpace[] = [];
  private cachedAgents: readonly HerdrAgent[] = [];
  private loaded = false;
  private inflight: Promise<void> | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor(private readonly source: HerdrExplorerSource) {}

  public spaces(): readonly HerdrSpace[] {
    return this.cachedSpaces;
  }

  public agents(): readonly HerdrAgent[] {
    return this.cachedAgents;
  }

  public async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.refresh().finally(() => {
      this.inflight = undefined;
    });
    await this.inflight;
  }

  public async refresh(): Promise<void> {
    const [spaces, agents] = await Promise.all([
      this.source.listWorkspaces(),
      this.source.listAgents(),
    ]);
    this.cachedSpaces = spaces;
    this.cachedAgents = agents;
    this.loaded = true;
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

export class HerdrSpacesTreeProvider
  implements vscode.TreeDataProvider<HerdrSpaceNode>
{
  public readonly onDidChangeTreeData = this.store.onDidChangeTreeData;

  public constructor(private readonly store: HerdrSnapshotStore) {}

  public getTreeItem(element: HerdrSpaceNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.space.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = element.space.status;
    item.command = {
      command: "ulw.herdr.openSpace",
      title: "Open Space",
      arguments: [element],
    };
    return item;
  }

  public async getChildren(): Promise<HerdrSpaceNode[]> {
    await this.store.ensureLoaded();
    return this.store.spaces().map((space) => ({ kind: "space", space }));
  }
}

export class HerdrAgentsTreeProvider
  implements vscode.TreeDataProvider<HerdrAgentNode>
{
  public readonly onDidChangeTreeData = this.store.onDidChangeTreeData;

  public constructor(private readonly store: HerdrSnapshotStore) {}

  public getTreeItem(element: HerdrAgentNode): vscode.TreeItem {
    const title = element.agent.title.trim();
    const item = new vscode.TreeItem(
      title || `${element.agent.agent} \u00b7 ${element.agent.paneId}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${element.agent.status} \u00b7 ${element.agent.workspaceId}`;
    item.command = {
      command: "ulw.herdr.openAgent",
      title: "Attach Agent",
      arguments: [element],
    };
    return item;
  }

  public async getChildren(): Promise<HerdrAgentNode[]> {
    await this.store.ensureLoaded();
    return this.store.agents().map((agent) => ({ kind: "agent", agent }));
  }
}

export function agentAttachLabel(agent: HerdrAgent): string {
  const title = agent.title.trim();
  return title || `${agent.agent} \u00b7 ${agent.paneId}`;
}

export function normalizeRoot(value: string): string {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const withoutTrailingSeparator =
    resolved.length > parsed.root.length
      ? resolved.replace(/[\\/]+$/, "")
      : resolved;
  return process.platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

export function inferSpaceRoot(
  workspaceId: string,
  agents: readonly HerdrAgent[],
): string | undefined {
  const cwd = agents.find(
    (agent) => agent.workspaceId === workspaceId && agent.cwd.length > 0,
  )?.cwd;
  return cwd ? path.resolve(cwd) : undefined;
}

export function isCurrentWindowRoot(
  root: string,
  folders: readonly { readonly uri: { readonly fsPath: string } }[] | undefined,
): boolean {
  const normalized = normalizeRoot(root);
  return (folders ?? []).some(
    (folder) => normalizeRoot(folder.uri.fsPath) === normalized,
  );
}
