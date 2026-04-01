import { vi } from "vitest";

export const window = {
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showTextDocument: vi.fn(),
  activeTextEditor: undefined as any,
  activeTerminal: undefined as any,
  terminals: [] as any[],
  tabGroups: { all: [] as any[] },
  visibleTextEditors: [] as any[],
  registerWebviewViewProvider: vi.fn(),
  registerTreeDataProvider: vi.fn(),
  showInputBox: vi.fn(),
  onDidChangeActiveTextEditor: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  onDidChangeTextEditorSelection: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  onDidOpenTerminal: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  onDidCloseTerminal: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  onDidChangeTerminalState: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  createWebviewPanel: vi.fn(() => ({
    webview: {
      html: "",
      onDidReceiveMessage: vi.fn(),
      postMessage: vi.fn(),
      asWebviewUri: vi.fn((uri: any) => uri),
      cspSource: "",
    },
    onDidDispose: vi.fn(),
    dispose: vi.fn(),
  })),
  createOutputChannel: vi.fn((name: string, options?: { log?: boolean }) => {
    void options;
    return {
      append: vi.fn(),
      appendLine: vi.fn(),
      replace: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      name,
    };
  }),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((key: string, defaultValue?: any) => {
      void key;
      return defaultValue;
    }),
    inspect: vi.fn(() => undefined),
    update: vi.fn(),
  })),
  openTextDocument: vi.fn(async (uri: any) => new TextDocument(uri, "")),
  workspaceFolders: undefined as any,
  asRelativePath: vi.fn((uri: any, includeWorkspaceFolder?: boolean) => {
    void includeWorkspaceFolder;
    if (typeof uri === "string") return uri;
    return uri.fsPath || uri.path || "";
  }),
  onDidChangeTextDocument: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  findFiles: vi.fn(),
};

export const languages = {
  onDidChangeDiagnostics: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  getDiagnostics: vi.fn((uri?: any) => (uri ? [] : [])),
  registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

export const commands = {
  registerCommand: vi.fn((id: string, callback: Function) => {
    void id;
    void callback;
    return { dispose: vi.fn() };
  }),
  executeCommand: vi.fn(),
};

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export const CodeActionKind = {
  QuickFix: "quickfix",
};

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export const env = {
  shell: "/bin/bash",
  openExternal: vi.fn(),
  clipboard: {
    readText: vi.fn(async () => ""),
    writeText: vi.fn(async (_text: string) => {}),
  },
};

export const Uri = {
  file: vi.fn((path: string) => ({ fsPath: path, path })),
  joinPath: vi.fn((base: any, ...paths: string[]) => ({
    fsPath: [base.fsPath || base.path, ...paths].join("/"),
    path: [base.path || base.fsPath, ...paths].join("/"),
  })),
  parse: vi.fn((uri: string) => {
    const match = uri.match(/^([a-z]+):\/\/(.+)$/);
    return {
      scheme: match ? match[1] : "file",
      fsPath: match ? match[2] : uri,
      path: match ? match[2] : uri,
    };
  }),
};

export const Range = vi.fn(
  (startLine: number, startChar: number, endLine: number, endChar: number) => ({
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  }),
);

export class EventEmitter<T = any> {
  private listeners: Array<(data: T) => void> = [];

  event = (listener: (data: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index > -1) this.listeners.splice(index, 1);
      },
    };
  };

  fire = (data: T) => {
    this.listeners.forEach((listener) => {
      listener(data);
    });
  };

  dispose = () => {
    this.listeners = [];
  };
}

export const CancellationTokenSource = vi.fn(() => ({
  token: { isCancellationRequested: false },
  cancel: vi.fn(),
  dispose: vi.fn(),
}));

export class Disposable {
  constructor(private callOnDispose: () => void) {}

  dispose() {
    this.callOnDispose();
  }
}

export class ExtensionContext {
  subscriptions: any[] = [];
  extensionPath = "/test/extension";
  extensionUri = { fsPath: "/test/extension", path: "/test/extension" };
  storageUri = undefined;
  globalStorageUri = { fsPath: "/test/global", path: "/test/global" };
  logUri = { fsPath: "/test/log", path: "/test/log" };
  extensionMode = 1;
  globalState = {
    get: vi.fn(),
    update: vi.fn(),
    setKeysForSync: vi.fn(),
  };
  workspaceState = {
    get: vi.fn(),
    update: vi.fn(),
  };
  secrets = {
    get: vi.fn(),
    store: vi.fn(),
    delete: vi.fn(),
  };
  extension = {
    id: "test.extension",
    extensionUri: { fsPath: "/test/extension", path: "/test/extension" },
    extensionPath: "/test/extension",
    isActive: true,
    packageJSON: {},
    exports: undefined,
    activate: vi.fn(),
  };
}

export const WebviewView = vi.fn(() => ({
  webview: {
    html: "",
    options: {},
    onDidReceiveMessage: vi.fn((listener: Function) => {
      void listener;
      return { dispose: vi.fn() };
    }),
    postMessage: vi.fn(),
    asWebviewUri: vi.fn((uri: any) => uri),
    cspSource: "default-src 'none'",
  },
  visible: true,
  onDidDispose: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  onDidChangeVisibility: vi.fn((listener: Function) => {
    void listener;
    return { dispose: vi.fn() };
  }),
  show: vi.fn(),
}));

export const WebviewViewResolveContext = vi.fn(() => ({
  state: undefined,
}));

export class Selection {
  anchor: { line: number; character: number };
  active: { line: number; character: number };
  start: { line: number; character: number };
  end: { line: number; character: number };
  isEmpty: boolean;

  constructor(
    anchorLine: number,
    anchorChar: number,
    activeLine: number,
    activeChar: number,
  ) {
    this.anchor = { line: anchorLine, character: anchorChar };
    this.active = { line: activeLine, character: activeChar };
    this.start = {
      line: Math.min(anchorLine, activeLine),
      character: Math.min(anchorChar, activeChar),
    };
    this.end = {
      line: Math.max(anchorLine, activeLine),
      character: Math.max(anchorChar, activeChar),
    };
    this.isEmpty = anchorLine === activeLine && anchorChar === activeChar;
  }
}

export class TextEditor {
  document: any;
  selection: any;
  selections: any[];
  visibleRanges: any[] = [];
  options: any = {};
  viewColumn = 1;
  edit = vi.fn();
  insertSnippet = vi.fn();
  setDecorations = vi.fn();
  revealRange = vi.fn();
  show = vi.fn();
  hide = vi.fn();

  constructor(document: any, selection: any) {
    this.document = document;
    this.selection = selection;
    this.selections = [selection];
  }
}

export class TextDocument {
  uri: any;
  fileName: string;
  isUntitled = false;
  languageId = "typescript";
  version = 1;
  isDirty = false;
  isClosed = false;
  content: string;
  getText = vi.fn(() => this.content);
  getWordRangeAtPosition = vi.fn();
  offsetAt = vi.fn();
  positionAt = vi.fn();
  validateRange = vi.fn();
  validatePosition = vi.fn();
  save = vi.fn();

  constructor(uri: any, content: string = "") {
    this.uri = uri;
    this.fileName = uri.fsPath || uri.path;
    this.content = content;
  }

  get lineCount() {
    return this.content.split("\n").length;
  }

  lineAt = vi.fn((line: number) => ({
    text: this.content.split("\n")[line] || "",
    lineNumber: line,
    range: new Range(
      line,
      0,
      line,
      this.content.split("\n")[line]?.length || 0,
    ),
    firstNonWhitespaceCharacterIndex: 0,
    isEmptyOrWhitespace:
      (this.content.split("\n")[line] || "").trim().length === 0,
  }));
}

export default {
  window,
  workspace,
  languages,
  commands,
  ConfigurationTarget,
  DiagnosticSeverity,
  CodeActionKind,
  ThemeColor,
  env,
  Uri,
  Range,
  EventEmitter,
  CancellationTokenSource,
  ExtensionContext,
  WebviewView,
  WebviewViewResolveContext,
  Selection,
  TextEditor,
  TextDocument,
  Disposable,
};
