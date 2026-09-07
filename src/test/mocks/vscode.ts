import { vi, type Mock } from "vitest";

export class Disposable {
  public constructor(private readonly callback: () => void = () => undefined) {}

  public dispose(): void {
    this.callback();
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  public readonly event = (listener: (event: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };

  public fire(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  public constructor(public readonly fsPath: string) {}

  public static file(path: string): Uri {
    return new Uri(path);
  }

  public static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri([base.fsPath, ...segments].join("/"));
  }

  public toString(): string {
    return `file://${this.fsPath}`;
  }
}

const configuration = new Map<string, unknown>();
const configurationEmitter = new EventEmitter<{
  affectsConfiguration(section: string): boolean;
}>();

export function setConfiguration(values: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(values)) {
    configuration.set(key, value);
  }
}

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export const workspace = {
  workspaceFolders: [{ uri: Uri.file(process.cwd()) }],
  getConfiguration: vi.fn((section: string) => ({
    get<T>(key: string, fallback?: T): T {
      return (configuration.get(`${section}.${key}`) as T | undefined) ?? (fallback as T);
    },
    update: vi.fn(async (key: string, value: unknown) => {
      configuration.set(`${section}.${key}`, value);
    }),
  })),
  onDidChangeConfiguration: configurationEmitter.event,
};

export function fireConfigurationChange(section: string): void {
  configurationEmitter.fire({
    affectsConfiguration: (candidate) =>
      section === candidate || section.startsWith(`${candidate}.`),
  });
}

export const env = {
  shell: "/bin/mock-shell",
  remoteName: undefined as string | undefined,
  clipboard: {
    writeText: vi.fn(async (_text: string) => undefined),
    readText: vi.fn(async () => ""),
  },
};

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
} as const;

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

export class TreeItem {
  public description: string | undefined;
  public command: { command: string; title: string; arguments?: unknown[] } | undefined;

  public constructor(
    public label: string,
    public collapsibleState: number = TreeItemCollapsibleState.None,
  ) {}
}

export const commands = {
  registerCommand: vi.fn((commandId: string, _handler: (...args: unknown[]) => unknown) => {
    void commandId;
    return new Disposable();
  }),
  executeCommand: vi.fn(async (_command: string, ..._args: unknown[]) => undefined),
};

export interface MockWebview {
  html: string;
  options: unknown;
  readonly cspSource: string;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly asWebviewUri: ReturnType<typeof vi.fn>;
  readonly onDidReceiveMessage: (listener: (message: unknown) => unknown) => Disposable;
  readonly send: (message: unknown) => void;
}

export interface MockWebviewPanel {
  webview: MockWebview;
  visible: boolean;
  active: boolean;
  readonly onDidDispose: (listener: () => unknown) => Disposable;
  readonly onDidChangeViewState: (
    listener: (event: { webviewPanel: MockWebviewPanel }) => unknown,
  ) => Disposable;
  readonly reveal: Mock<(...args: unknown[]) => unknown>;
  readonly dispose: Mock<() => void>;
  readonly fireViewState: (active: boolean) => void;
}

function createMockWebview(): MockWebview {
  const messageEmitter = new EventEmitter<unknown>();
  return {
    html: "",
    options: undefined,
    cspSource: "vscode-webview:",
    postMessage: vi.fn(async (_message: unknown) => true),
    asWebviewUri: vi.fn((uri: Uri) => uri),
    onDidReceiveMessage: messageEmitter.event,
    send: (message) => messageEmitter.fire(message),
  };
}

function createMockWebviewPanel(): MockWebviewPanel {
  const disposeEmitter = new EventEmitter<void>();
  const viewStateEmitter = new EventEmitter<{ webviewPanel: MockWebviewPanel }>();
  const panel: MockWebviewPanel = {
    webview: createMockWebview(),
    visible: true,
    active: true,
    onDidDispose: disposeEmitter.event,
    onDidChangeViewState: viewStateEmitter.event,
    reveal: vi.fn(),
    dispose: vi.fn(() => {
      disposeEmitter.fire();
    }),
    fireViewState: (active: boolean) => {
      panel.active = active;
      viewStateEmitter.fire({ webviewPanel: panel });
    },
  };
  return panel;
}

export const window = {
  showQuickPick: vi.fn(async (items: readonly unknown[], _options?: unknown) => {
    void items;
    return undefined as unknown;
  }),
  showWarningMessage: vi.fn(async (_message: string, ..._items: string[]) => undefined as string | undefined),
  showInformationMessage: vi.fn(async (_message: string, ..._items: string[]) => undefined as string | undefined),
  registerWebviewViewProvider: vi.fn(() => new Disposable()),
  registerTreeDataProvider: vi.fn(() => new Disposable()),
  createWebviewPanel: vi.fn(
    (
      _viewType: string,
      _title: string,
      _showOptions: unknown,
      _options?: unknown,
    ) => createMockWebviewPanel(),
  ),
  onDidChangeActiveTextEditor: vi.fn((listener: unknown) => {
    void listener;
    return new Disposable();
  }),
  activeTextEditor: undefined as
    | {
        readonly selection: { readonly isEmpty: boolean };
        readonly document: { getText(selection?: unknown): string };
      }
    | undefined,
};

export function resetMocks(): void {
  configuration.clear();
  commands.registerCommand.mockClear();
  commands.executeCommand.mockClear();
  window.showQuickPick.mockReset();
  window.showQuickPick.mockImplementation(async (items: readonly unknown[], _options?: unknown) => {
    void items;
    return undefined as unknown;
  });
  window.showWarningMessage.mockReset();
  window.showWarningMessage.mockResolvedValue(undefined);
  window.showInformationMessage.mockReset();
  window.showInformationMessage.mockResolvedValue(undefined);
  window.registerWebviewViewProvider.mockClear();
  window.registerTreeDataProvider.mockClear();
  window.createWebviewPanel.mockClear();
  window.createWebviewPanel.mockImplementation(
    (
      _viewType: string,
      _title: string,
      _showOptions: unknown,
      _options?: unknown,
    ) => createMockWebviewPanel(),
  );
  window.onDidChangeActiveTextEditor.mockClear();
  window.activeTextEditor = undefined;
  workspace.getConfiguration.mockClear();
  env.shell = "/bin/mock-shell";
  env.remoteName = undefined;
  env.clipboard.writeText.mockClear();
  env.clipboard.readText.mockClear();
}

export default {
  Disposable,
  EventEmitter,
  Uri,
  TreeItem,
  TreeItemCollapsibleState,
  ConfigurationTarget,
  workspace,
  env,
  window,
  ViewColumn,
  commands,
};
