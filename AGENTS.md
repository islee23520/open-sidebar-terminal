# PROJECT KNOWLEDGE BASE

## OVERVIEW

VS Code extension that runs one native shell terminal in the secondary sidebar or an editor-group tab. With Herdr off, the host owns one persistent `node-pty` shell PTY on one active xterm surface. With Herdr on, the sidebar terminal is hidden and each attached agent gets its own editor-group webview plus one control-bridge child.

## SOURCE TOPOLOGY

```text
src/
├── extension.ts                    # activate/deactivate entry
├── types.ts                        # host/webview contract
├── core/ExtensionLifecycle.ts      # creates and registers the terminal provider
├── providers/TerminalProvider.ts   # sidebar webview and PTY message bridge
├── terminals/
│   ├── TerminalManager.ts          # one native shell PTY lifecycle
│   ├── TerminalTransport.ts        # transport seam for shell and Herdr bridge
│   └── LocalShellTransport.ts      # local shell transport adapter
├── herdr/
│   ├── HerdrCliClient.ts           # CLI discovery, agent listing, workspace listing
│   ├── HerdrInvocationResolver.ts  # shared Herdr command/env resolver
│   ├── HerdrControlTransport.ts    # official Herdr control bridge child
│   ├── HerdrAttachController.ts    # attach/detach lifecycle state machine
│   ├── HerdrExplorer.ts            # Activity Bar Spaces/Agents trees
│   ├── types.ts                    # Herdr data types
│   └── errors.ts                   # Herdr typed errors
├── webview/
│   ├── main.ts                     # one xterm bootstrap
│   ├── terminal/index.ts           # xterm input/output/resize/config bridge
│   ├── terminal/html.ts            # CSP-protected webview HTML
│   ├── terminal.css                # full-size terminal layout
│   └── shared/vscode-api.ts        # cached VS Code webview API
└── test/                           # unit mocks and one VS Code E2E smoke
```

## RUNTIME FLOW

```text
Herdr off:
  sidebar: contributed view `ulw` (when `ulw.sidebar.enabled`) -> resolveWebviewView()
  editor:  ulw.defaultLocation=editor (default) | ulw.toggleEditorLocation -> one shared webview panel
    -> TerminalManager creates or resizes `sidebar-shell`
Herdr on:
  sidebar terminal hidden (`when: config.ulw.sidebar.enabled && !config.ulw.herdr.enabled`)
  Activity Bar Spaces/Agents -> agent click in this window opens/reveals an editor-group tab per agent
    -> one control-bridge child per attached agent -> first-full-frame atomic cutover
    -> detach/external closure closes that session without restoring a local shell
```

## CONTRACT

- Webview to host: `ready`, `input`, `resize`, `copy`, `imagePasted`.
- Host to webview: `output`, `exit`, `config`, `focus`, `clipboardImage`, `reset`, `sourceState`.
- Herdr off: one persistent shell PTY; one active surface (sidebar or one editor panel).
- Herdr on: no sidebar terminal; one editor-group tab and one Herdr bridge child per attached agent.
- Input and resize target the currently ACTIVE surface only.
- `ulw.toggleEditorLocation` moves the shared shell between surfaces only while Herdr is off.

## CONVENTIONS

- Activate for the sidebar view, contributed commands, and startup (so `ulw.defaultLocation=editor` can open an editor tab).
- Keep contributed commands limited to location toggle, send-to-terminal helpers, Herdr attach/detach, and the read-only Spaces/Agents explorer; no keybindings.
- Keep `node-pty` as the only runtime dependency. xterm and the fit addon are build-time dependencies bundled into `webview.js`.
- Herdr attach is allowed only through official CLI bridge children using builtin `child_process`; no raw socket client, no agent start/rename, no auto-start/reconnect/reattach. Herdr commands and the Activity Bar Spaces/Agents tree stay hidden until `ulw.herdr.enabled` is true. Then the tree lists live workspaces, opens each clicked agent in this window as its own editor-group tab, and opens another Space's folder in a new VS Code window.
- With Herdr off: one editor panel max for the shared shell; never spawn a second PTY for editor mode.
- With Herdr on: hide the ULW sidebar terminal; open each agent in its own editor-group tab; do not restore a local shell on detach.
- Honor `ulw.defaultLocation` (`editor` default | `sidebar`); toggle always overrides the current surface.
- Use project scripts for verification.

## COMMANDS

```bash
npm run test
npx tsc -p tsconfig.json --noEmit
npm run compile:e2e
npm run lint
npm run package
npm run test:e2e
```
