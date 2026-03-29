# OpenCode Sidebar TUI

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/islee23520.opencode-sidebar-tui?logo=visual-studio-code&label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=islee23520.opencode-sidebar-tui)
[![Open VSX](https://img.shields.io/open-vsx/v/islee23520/opencode-sidebar-tui?logo=open-vsx&label=Open%20VSX)](https://open-vsx.org/extension/islee23520/opencode-sidebar-tui)

Automatically render OpenCode TUI in VS Code sidebar with full terminal support.

## Features

- **Auto-launch OpenCode**: Opens OpenCode automatically when the sidebar is activated
- **Full TUI Support**: Complete terminal emulation with xterm.js and WebGL rendering
- **Terminal Managers**: Dedicated sidebar view for tmux session management with inline pane controls (split, switch, resize, swap, kill panes)
- **Tmux Integration**: Automatic tmux session discovery, workspace-scoped session filtering, and tmux status bar hidden in sidebar
- **Return to Workspace Banner**: Quick navigation back to the active workspace from the Terminal Managers view
- **HTTP API Integration**: Bidirectional communication with OpenCode CLI via HTTP API
- **Auto-Context Sharing**: Automatically shares editor context when terminal opens
- **File References with Line Numbers**: Send file references with `@filename#L10-L20` syntax
- **Keyboard Shortcuts**: Quick access with `Cmd+Alt+L` and `Cmd+Alt+A`
- **Drag & Drop Support**: Hold Shift and drag files/folders to send as references
- **Context Menu Integration**: Right-click files in Explorer or text in Editor to send to OpenCode
- **Configurable**: Customize command, font, terminal settings, and HTTP API behavior

## Architecture

This extension provides a **sidebar-only** terminal experience. OpenCode runs embedded in the VS Code sidebar Activity Bar, not in the native VS Code terminal panel.

The extension consists of two primary sidebar views:

1. **OpenCode Terminal**: The main interactive TUI session.
2. **Terminal Managers**: A dedicated dashboard for managing tmux sessions and panes.

### Communication Architecture

The extension uses a hybrid communication approach:

1. **HTTP API**: Primary communication channel with OpenCode CLI
   - Port range: 16384-65535 (ephemeral ports)
   - Endpoints: `/health`, `/tui/append-prompt`
   - Auto-discovery of OpenCode CLI HTTP server

2. **WebView Messaging**: Terminal I/O between extension host and sidebar WebView
   - xterm.js for terminal rendering
   - Bidirectional message passing for input/output

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search for "OpenCode Sidebar TUI"
4. Click **Install**

### From OpenVSX Registry

For VSCodium, Gitpod, Eclipse Theia, and other VS Code-compatible IDEs:

1. Open your IDE's extension view
2. Search for "OpenCode Sidebar TUI"
3. Click **Install**

Or visit the [OpenVSX page](https://open-vsx.org/extension/islee23520/opencode-sidebar-tui).

### From Source

1. Clone the repository:

```bash
git clone https://github.com/islee23520/opencode-sidebar-tui.git
cd opencode-sidebar-tui
```

2. Install dependencies:

```bash
npm install
```

3. Build the extension:

```bash
npm run compile
```

4. Package the extension:

```bash
npx @vscode/vsce package
```

5. Install in VS Code:

- Open VS Code
- Go to Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`)
- Click "..." menu → "Install from VSIX"
- Select the generated `.vsix` file

## Usage

1. Click the OpenCode icon in the Activity Bar (sidebar)
2. OpenCode TUI automatically starts
3. Interact with OpenCode directly in the sidebar

## Commands

### Basic Commands

- **OpenCode TUI: Start OpenCode** - Manually start OpenCode
- **OpenCode TUI: Restart OpenCode** - Restart the OpenCode process
- **OpenCode TUI: Clear Terminal** - Clear the terminal display
- **OpenCode TUI: Paste** - Paste text into the terminal

### File Reference Commands

- **Send File Reference** (`Cmd+Alt+L` / `Ctrl+Alt+L`) - Send current file with line numbers
  - No selection: `@filename`
  - Single line: `@filename#L10`
  - Multiple lines: `@filename#L10-L20`
- **Send All Open Files** (`Cmd+Alt+A` / `Ctrl+Alt+A`) - Send all open file references
- **Send to OpenCode** - Send selected text or file from context menu
- **Send to OpenCode Terminal** - Send selected text to the terminal
- **Send File Reference (@file)** - Send a reference to the current file

### Tmux Session Commands

- **Open Tmux Session in New Window** - Open the current tmux session in a new VS Code window
- **Spawn Tmux Session for Workspace** - Create a new tmux session scoped to the current workspace
- **Select OpenCode Tmux Session** - Choose from a list of available tmux sessions

### Tmux Pane Commands

- **Switch to Pane** - Switch focus to a specific tmux pane
- **Split Pane Horizontal** - Split the current pane horizontally
- **Split Pane Vertical** - Split the current pane vertically
- **Split Pane with Command** - Split the pane and run a specific command
- **Send Text to Pane** - Send text directly to a specific tmux pane
- **Resize Pane** - Adjust the size of the current tmux pane
- **Swap Panes** - Swap positions of two tmux panes
- **Kill Pane** - Close the current tmux pane

### Context Menu Options

- **Explorer**: Right-click any file or folder → "Send to OpenCode"
- **Editor**: Right-click selected text → "Send to OpenCode Terminal"
- **Editor**: Right-click anywhere → "Send File Reference (@file)"

### Drag & Drop

- Hold **Shift** and drag files/folders to the terminal to send as `@file` references

## Terminal Managers

The Terminal Managers view provides advanced tmux session and pane management directly within the VS Code sidebar:

- **Session Discovery**: Automatically detects existing tmux sessions on your system.
- **Workspace Filtering**: Filters sessions to show those relevant to your current workspace.
- **Pane Controls**: Inline buttons to split panes (horizontal/vertical), switch focus, resize, swap, and kill panes.
- **Return to Workspace**: A quick-access banner to navigate back to the active workspace session from the dashboard.
- **Clean UI**: The tmux status bar is automatically hidden within the sidebar terminal to maximize vertical space.

## HTTP API Integration

The extension communicates with OpenCode CLI via an HTTP API for reliable bidirectional communication:

### Features

- **Auto-Discovery**: Automatically discovers OpenCode CLI HTTP server port
- **Health Checks**: Validates OpenCode CLI availability before sending commands
- **Retry Logic**: Exponential backoff for reliable communication
- **Context Sharing**: Automatically shares editor context on terminal open

### How It Works

1. When OpenCode starts, it launches an HTTP server on an ephemeral port (16384-65535)
2. The extension discovers the port and establishes communication
3. File references and context are sent via HTTP POST to `/tui/append-prompt`
4. Health checks ensure OpenCode is ready before sending data

### Configuration

```json
{
  "opencodeTui.enableHttpApi": true,
  "opencodeTui.httpTimeout": 5000,
  "opencodeTui.autoShareContext": true
}
```

## Auto-Context Sharing

When enabled, the extension automatically shares editor context with OpenCode when the terminal opens:

- **Open Files**: Lists all currently open files
- **Active Selection**: Includes line numbers for selected text
- **Format**: `@path/to/file#L10-L20`

This feature eliminates the need to manually share context when starting a new OpenCode session.

## Configuration

Available settings in VS Code settings (`Cmd+,` / `Ctrl+,`):

| Setting                        | Type    | Default         | Description                                             |
| ------------------------------ | ------- | --------------- | ------------------------------------------------------- |
| `opencodeTui.autoStart`        | boolean | `true`          | Automatically start OpenCode when the view is activated |
| `opencodeTui.autoStartOnOpen`  | boolean | `true`          | Automatically start OpenCode when sidebar is opened     |
| `opencodeTui.command`          | string  | `"opencode -c"` | Command to launch OpenCode with arguments               |
| `opencodeTui.fontSize`         | number  | `14`            | Terminal font size in pixels (6-25)                     |
| `opencodeTui.fontFamily`       | string  | `"monospace"`   | Terminal font family                                    |
| `opencodeTui.cursorBlink`      | boolean | `true`          | Enable cursor blinking                                  |
| `opencodeTui.cursorStyle`      | string  | `"block"`       | Cursor style: `block`, `underline`, or `bar`            |
| `opencodeTui.scrollback`       | number  | `10000`         | Maximum lines in scrollback buffer (0-100000)           |
| `opencodeTui.autoFocusOnSend`  | boolean | `true`          | Auto-focus sidebar after sending file references        |
| `opencodeTui.shellPath`        | string  | `""`            | Custom shell path (empty = VS Code default)             |
| `opencodeTui.shellArgs`        | array   | `[]`            | Custom shell arguments                                  |
| `opencodeTui.enableHttpApi`    | boolean | `true`          | Enable HTTP API for OpenCode communication              |
| `opencodeTui.httpTimeout`      | number  | `5000`          | HTTP API request timeout in ms (1000-30000)             |
| `opencodeTui.autoShareContext` | boolean | `true`          | Auto-share editor context with OpenCode                 |

### Example Configuration

```json
{
  "opencodeTui.autoStart": true,
  "opencodeTui.command": "opencode -c",
  "opencodeTui.fontSize": 14,
  "opencodeTui.fontFamily": "monospace",
  "opencodeTui.cursorBlink": true,
  "opencodeTui.cursorStyle": "block",
  "opencodeTui.scrollback": 10000,
  "opencodeTui.enableHttpApi": true,
  "opencodeTui.httpTimeout": 5000,
  "opencodeTui.autoShareContext": true
}
```

## Requirements

- VS Code 1.106.0 or higher
- Node.js 20.0.0 or higher
- OpenCode installed and accessible via `opencode` command

## Development

### Build

```bash
npm run compile    # Development build
npm run watch      # Watch mode
npm run package    # Production build
npm run test       # Run tests
npm run test:coverage  # Run tests with coverage
```

### Project Structure

```
src/
├── extension.ts                         # VS Code entry (activate/deactivate)
├── types.ts                             # Shared host↔webview message contracts
├── core/
│   ├── ExtensionLifecycle.ts            # Service wiring + activation/deactivation
│   └── commands/                        # Command registration (extracted from lifecycle)
│       ├── index.ts                     # registerCommands() orchestrator
│       ├── terminalCommands.ts          # start, restart, paste, file references
│       ├── tmuxSessionCommands.ts       # session switch, create, spawn
│       └── tmuxPaneCommands.ts          # 8 pane commands + QuickPick helpers
├── providers/
│   ├── OpenCodeTuiProvider.ts           # Re-export from opencode/
│   ├── opencode/                        # Main sidebar terminal (split modules)
│   │   ├── OpenCodeTuiProvider.ts       # Webview lifecycle shell (283 lines)
│   │   ├── OpenCodeMessageRouter.ts     # Message dispatch + handlers
│   │   └── OpenCodeSessionRuntime.ts    # Start/restart/tmux/instance switching
│   ├── TmuxSessionsDashboardProvider.ts # Terminal Managers webview provider
│   └── CodeActionProvider.ts            # Explain-and-fix code action
├── terminals/
│   └── TerminalManager.ts              # node-pty process lifecycle
├── services/
│   ├── InstanceStore.ts                # In-memory instance state + EventEmitter
│   ├── InstanceController.ts           # Instance lifecycle orchestration
│   ├── InstanceDiscoveryService.ts     # Running instance discovery + auto-spawn
│   ├── InstanceRegistry.ts             # Instance persistence (globalState)
│   ├── ConnectionResolver.ts           # 4-tier port resolution + client pool
│   ├── OpenCodeApiClient.ts            # HTTP client (retry/backoff)
│   ├── PortManager.ts                  # Ephemeral port allocation
│   ├── TmuxSessionManager.ts           # tmux CLI wrapper (sessions, panes)
│   ├── ContextManager.ts               # Active editor/selection observer
│   ├── ContextSharingService.ts        # @file#L context formatter
│   ├── FileReferenceManager.ts         # File reference serialization
│   ├── InstanceQuickPick.ts            # Quick pick UI for instance selection
│   ├── OutputChannelService.ts         # Singleton logging service
│   └── OutputCaptureManager.ts         # Terminal output capture
├── webview/
│   ├── main.ts                         # Terminal webview (xterm.js + WebGL)
│   └── dashboard.ts                    # Instance dashboard (legacy, unused)
├── utils/
│   └── PromptFormatter.ts              # Prompt formatting utilities
├── test/
│   └── mocks/                          # Manual vscode + node-pty mocks
└── __tests__/
    └── setup.ts                        # Vitest global setup
```

**Webpack 2 bundles:** `extension.js` (node), `webview.js` (web)

## Implementation Details

Based on the excellent [vscode-sidebar-terminal](https://github.com/s-hiraoku/vscode-sidebar-terminal) extension, streamlined specifically for OpenCode TUI:

- **Terminal Backend**: node-pty for PTY support
- **Terminal Frontend**: xterm.js with WebGL rendering
- **Process Management**: Automatic OpenCode lifecycle
- **Communication**: HTTP API + WebView messaging
- **Port Management**: Ephemeral port allocation (16384-65535)

## License

MIT

## Acknowledgments

- Based on [vscode-sidebar-terminal](https://github.com/s-hiraoku/vscode-sidebar-terminal) by s-hiraoku
- Development assisted by [Sisyphus](https://github.com/code-yeongyu/oh-my-opencode) from oh-my-opencode
- Uses [xterm.js](https://github.com/xtermjs/xterm.js) for terminal emulation
- Uses [node-pty](https://github.com/microsoft/node-pty) for PTY support
