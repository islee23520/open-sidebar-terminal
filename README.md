# ULW Sidebar Terminal

ULW is a small VS Code extension that runs one native shell terminal in the secondary sidebar.

It intentionally has no terminal multiplexer UI of its own — it can attach to an external one (Herdr) — and no session manager, AI integration, HTTP service, dashboard, or multi-pane layout. Opening ULW creates one `node-pty` process and connects it to one xterm.js terminal in either the secondary sidebar or an editor-group tab.

## Use

1. Install the extension.
2. Reload VS Code. ULW opens in an editor-group tab by default; set `ulw.defaultLocation` to `sidebar` to use the secondary sidebar instead.
3. Type directly in the terminal.

The shell starts in the first workspace folder. When no workspace is open, it starts in the user's home directory.

Run **ULW: Toggle Terminal Location** (`ulw.toggleEditorLocation`) to move the same shell between the secondary sidebar and an editor-group tab. Toggle again, or close the editor tab, to return to the sidebar. Switching surfaces reuses the same shell and replays recent scrollback into the newly focused xterm.

## Attach to a running Herdr agent

Use **ULW: Attach Herdr Session** (`ulw.attachHerdrSession`) to open a QuickPick of live Herdr agents, then choose the session to take over. The Activity Bar **Herdr** view lists the same live **Spaces** (`ulw.herdr.spaces`) and **Agents** (`ulw.herdr.agents`); clicking an agent runs `ulw.herdr.openAgent` and attaches the existing terminal without a QuickPick. Clicking a space (`ulw.herdr.openSpace`) only identifies that workspace — it does not switch VS Code windows or start an agent. Refresh with `ulw.herdr.refreshExplorer`.

- The picker and trees are populated from the Herdr CLI `agent list` / `workspace list` output, and ULW warns when takeover will replace other direct Herdr clients.
- Taking control is not auto-restored to those other clients; ULW owns the session only while attached.
- Any attach failure or external closure restores the local shell automatically.

Use **ULW: Detach Herdr Session** (`ulw.detachHerdrSession`) to release ULW's controller and restore the local shell. A previously displaced direct Herdr client is not automatically restored.

The terminal automatically inherits the active VS Code terminal palette, including ANSI colors, cursor colors, selections, and live theme changes. Drag-selecting terminal text copies the finished selection to the system clipboard.

## Commands

| Command | Purpose |
| --- | --- |
| `ulw.toggleEditorLocation` | Toggle the terminal between secondary sidebar and editor group |
| `ulw.sendSelectionToTerminal` | Send the active editor selection to the terminal |
| `ulw.sendFileToTerminal` | Send an explorer file path to the terminal |
| `ulw.attachHerdrSession` | Attach to a running Herdr agent |
| `ulw.detachHerdrSession` | Detach from a running Herdr agent |
| `ulw.herdr.openAgent` | Attach the selected Activity Bar agent |
| `ulw.herdr.openSpace` | Reveal a Space in the tree (no window switch) |
| `ulw.herdr.refreshExplorer` | Refresh Spaces and Agents lists |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ulw.defaultLocation` | `editor` | Open in an editor-group tab or the secondary sidebar |
| `ulw.fontSize` | `14` | Terminal font size |
| `ulw.fontFamily` | Nerd Font and monospace fallbacks | Terminal font family |
| `ulw.cursorBlink` | `true` | Blink the cursor |
| `ulw.cursorStyle` | `block` | `block`, `underline`, or `bar` |
| `ulw.scrollback` | `10000` | Scrollback line count |
| `ulw.shellPath` | empty | Shell executable; empty uses the VS Code or system default |
| `ulw.shellArgs` | `[]` | Arguments passed to the shell |
| `ulw.herdr.executablePath` | `herdr` | Herdr executable path; GUI-launched VS Code may need an explicit absolute path if PATH does not include herdr |
| `ulw.herdr.socketPath` | empty | Optional Herdr socket path; ignored when a named session is configured |
| `ulw.herdr.session` | empty | Optional named Herdr session; takes precedence over the socket path |

## Development

```bash
npm ci
npm run test
npm run lint
npm run package
npm run test:e2e
```

Production output is limited to `dist/extension.js` and `dist/webview.js`. The E2E test opens the actual sidebar view, waits for the PTY start event, sends a shell command, and verifies its output without fixed sleeps.

## Requirements

- VS Code 1.106 or newer
- Node.js 20 or newer

## License

MIT

## Acknowledgment

Based on [vscode-sidebar-terminal](https://github.com/s-hiraoku/vscode-sidebar-terminal) by s-hiraoku.
