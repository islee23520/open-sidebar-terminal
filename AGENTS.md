# PROJECT KNOWLEDGE BASE

## OVERVIEW

VS Code extension that runs one native shell terminal in the secondary sidebar or an editor-group tab. The extension host owns one persistent `node-pty` shell PTY rendered through one active xterm surface, plus at most one Herdr session-control bridge child while attached; input and resize route to the single active source at a time.

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
sidebar: contributed view `ulw` -> resolveWebviewView()
editor:  ulw.defaultLocation=editor (default) | ulw.toggleEditorLocation -> createWebviewPanel
  -> active surface posts `ready`
  -> TerminalManager creates or resizes `sidebar-shell`
  -> scrollback replay when switching to a fresh xterm
  -> attach flow: command palette QuickPick or Activity Bar agent click -> CLI discovery (agent list) -> control bridge spawn (--takeover) -> first-full-frame atomic cutover -> reset + badge
  -> detach/external closure -> shell restore
  -> node-pty data/exit events post to surfaces
  -> active surface input/resize events write/resize the active source only
```

## CONTRACT

- Webview to host: `ready`, `input`, `resize`, `copy`, `imagePasted`.
- Host to webview: `output`, `exit`, `config`, `focus`, `clipboardImage`, `reset`, `sourceState`.
- No pane or session identifiers: one persistent shell PTY exists, plus at most one Herdr bridge child while attached.
- One active surface at a time: secondary-sidebar webview or one editor-group webview panel.
- Input and resize always target the currently ACTIVE source only.
- `ulw.toggleEditorLocation` moves that single shell between surfaces.

## CONVENTIONS

- Activate for the sidebar view, contributed commands, and startup (so `ulw.defaultLocation=editor` can open an editor tab).
- Keep contributed commands limited to location toggle, send-to-terminal helpers, Herdr attach/detach, and the read-only Spaces/Agents explorer; no keybindings.
- Keep `node-pty` as the only runtime dependency. xterm and the fit addon are build-time dependencies bundled into `webview.js`.
- Herdr attach is allowed only through one official CLI bridge child using builtin `child_process`; no raw socket client, no agent start/rename, no auto-start/reconnect/reattach. Herdr commands and the Activity Bar Spaces/Agents tree stay hidden until `ulw.herdr.enabled` is true. Then the tree lists live workspaces, attaches the existing single PTY to a clicked agent in this window, and opens another Space's folder in a new VS Code window.
- One editor panel max for the shared shell; never spawn a second PTY for editor mode.
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
