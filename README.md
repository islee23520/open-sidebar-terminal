# ULW Sidebar Terminal

ULW is a small VS Code extension that runs one native shell terminal in the secondary sidebar or an editor-group tab.

With Herdr integration off, opening ULW creates one `node-pty` process connected to one xterm.js surface. With `ulw.herdr.enabled`, the secondary sidebar shows the selected agent's existing OMO DAG pane; Spaces/Agents live in the Activity Bar, and each agent opens in its own editor-group tab.

## Use

1. Install the extension.
2. Reload VS Code. ULW opens in an editor-group tab by default; set `ulw.defaultLocation` to `sidebar` to use the secondary sidebar instead.
3. Type directly in the terminal.

The shell starts in the first workspace folder. When no workspace is open, it starts in the user's home directory.

Run **ULW: Toggle Terminal Location** (`ulw.toggleEditorLocation`) to move the same shell between the secondary sidebar and an editor-group tab. Toggle again, or close the editor tab, to return to the sidebar. Switching surfaces reuses the same shell and replays recent scrollback into the newly focused xterm.

## Attach to a running Herdr agent

Herdr integration is off until you set `ulw.herdr.enabled` (Settings: **ULW › Herdr: Enabled**). After that, use **ULW: Attach Herdr Session** (`ulw.attachHerdrSession`) to open a QuickPick of live Herdr agents, then choose the session to take over. The Activity Bar **Herdr** view lists the same live **Spaces** (`ulw.herdr.spaces`) and **Agents** (`ulw.herdr.agents`). Clicking an agent (`ulw.herdr.openAgent`) attaches the existing terminal when that agent's folder is this VS Code window, otherwise it opens the folder in a new window. Clicking a space (`ulw.herdr.openSpace`) uses the same folder check and never starts an agent. Refresh with `ulw.herdr.refreshExplorer`.

- The picker and trees are populated from the Herdr CLI `agent list` / `workspace list` output, and ULW warns when takeover will replace other direct Herdr clients.
- Taking control is not auto-restored to those other clients; ULW owns the session only while attached.
- Attach failure, detach, or external closure closes that agent's attached editor session without starting a local shell while Herdr is enabled.

Use **ULW: Detach Herdr Session** (`ulw.detachHerdrSession`) to release the active agent's control bridge. The remote agent keeps running. A previously displaced direct Herdr client is not automatically restored.

The DAG sidebar uses the existing OMO plugin pane associated with the active agent, or the sole agent in the current folder. Open that pane from OMO with `/dag-pane` first. ULW does not create a DAG pane or render a second graph. Discovery verifies the server, parent session and live pane identity; missing or closed panes show an unavailable message. Refresh explicitly to retry closed control. Same-host discovery honors `OMO_HERDR_DAG_STATE_DIR`; SSH-forwarded hosts cannot use local plugin metadata.

Click **Herdr** in the status bar to switch agents or choose **Attach Agent...**, **Detach Active Agent**, **Refresh**, or **Open DAG** in a native QuickPick. Selecting an agent opens or reveals its own editor tab in this window. **Open DAG** enables the ULW sidebar when disabled and reveals the existing DAG view; it does not create a plugin pane. The status entry and management commands are hidden while Herdr integration is off. Management never creates, renames, or terminates remote agents.

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
| `ulw.herdr.openSpace` | Open that Space's folder in this window or a new window |
| `ulw.herdr.refreshExplorer` | Refresh Spaces and Agents lists |
| `ulw.herdr.showMenu` | Switch agents or manage attachments from a native QuickPick |
| `ulw.herdr.openDag` | Enable and reveal the existing DAG sidebar |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ulw.defaultLocation` | `editor` | Open in an editor-group tab or the secondary sidebar |
| `ulw.sidebar.enabled` | `true` | Show the ULW label in the secondary sidebar. Off hides ULW from the sidebar completely |
| `ulw.fontSize` | `14` | Terminal font size |
| `ulw.fontFamily` | Nerd Font and monospace fallbacks | Terminal font family |
| `ulw.cursorBlink` | `true` | Blink the cursor |
| `ulw.cursorStyle` | `block` | `block`, `underline`, or `bar` |
| `ulw.scrollback` | `10000` | Scrollback line count |
| `ulw.shellPath` | empty | Shell executable; empty uses the VS Code or system default |
| `ulw.shellArgs` | `[]` | Arguments passed to the shell |
| `ulw.herdr.enabled` | `false` | Turn on Herdr Spaces/Agents and attach. Off until you enable it |
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
