# Changelog

All notable changes to the "ULW" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.13.0] - 2026-09-09

### Added

- Show the existing parent-associated Herdr DAG in the secondary sidebar while keeping attached agents in separate editor tabs.
- Add a Herdr status-bar menu for switching agents, managing attachments, refreshing discovery, and opening the DAG even when the sidebar is disabled.

### Fixed

- Validate DAG metadata and live pane identity, select the newest connected session, and wait for a full terminal frame before activating DAG control.
- Release stale control on endpoint, mode, tab, and sidebar visibility changes; preserve pending resize dimensions and avoid reattaching an externally closed DAG.
- Keep shell location controls hidden in Herdr mode and preserve the ordinary local shell when Herdr is disabled.

## [1.12.16] - 2026-09-07

### Added

- Herdr over SSH: the new `ulw.herdr.remoteTarget` setting reaches the Herdr server behind an SSH target while VS Code is connected to a remote window. ULW forwards the remote Herdr API and client sockets over SSH and routes Spaces/Agents listing and attach through them. Blank targets and local windows keep the previous invocation, Herdr setting changes apply to new invocations without reloading the window, and a configured `ulw.herdr.session` is ignored while forwarding.

### Fixed

- Switching between Herdr agent editor tabs now moves global input, resize, and detach to the focused agent's tab, and closing the focused tab falls back to the most recently focused remaining agent.

## [1.12.15] - 2026-08-24

### Fixed

- Herdr attach scroll: wheel/PageUp/PageDown now send Herdr `terminal.scroll` (host history) instead of CSI arrows as `terminal.input`. Arrows were reaching the agent prompt/input widget and scrolling that field, not the transcript. Follow each scroll with same-size `terminal.resize` so Herdr emits a scrolled `full:true` checkpoint frame.

## [1.12.14] - 2026-08-24

### Fixed

- Herdr attach scroll: capture wheel on `window` and post repeated CSI arrows as `terminal.input`. xterm was eating wheel as local scroll (viewport checkpoint has no history) or dropping it when render dimensions were missing (`consumeWheelEvent` returned 0). Also block xterm's local wheel handler via `customWheelEventHandler` while attached.

## [1.12.13] - 2026-08-24

### Fixed

- Stop capturing wheel/click in the webview. xterm already converts wheel to CSI arrows when scrollback is 0; intercepting the event blocked that path. Hide the xterm viewport overflow so an empty local buffer cannot swallow the gesture.

## [1.12.12] - 2026-08-24

### Fixed

- Wheel an attached agent TUI with CSI arrows when the app has no mouse tracking (typical pi/omo frames omit DECSET 1000/1006). Send SGR mouse only when xterm reports a mouse protocol, so clicks still work in mouse-aware apps.

## [1.12.11] - 2026-08-24

### Fixed

- Send Herdr-attached wheel and clicks as SGR mouse (`ESC[<64;col;rowM`, `ESC[<0;col;rowM/m`) instead of CSI arrows, so the agent TUI gets mouse input rather than keyboard scroll.

## [1.12.10] - 2026-08-24

### Fixed

- Mouse-wheel a Herdr-attached agent TUI by sending CSI arrows as PTY input. Host `terminal.scroll` only moves Herdr history and does not paint alt-screen apps; a follow-up same-size resize snapped the live viewport back.
- Capture wheel on the webview `window` and disable xterm scrollback while attached so the local empty buffer cannot swallow the gesture.

## [1.12.9] - 2026-08-24

### Fixed

- Scroll a Herdr-attached terminal by intercepting wheel/Page keys and forcing a checkpoint after `terminal.scroll`, which otherwise moves host history without painting a new frame.
- Keep the Spaces and Agents trees current by polling Herdr lists while Herdr mode is enabled.

## [1.12.8] - 2026-08-06

### Fixed

- Fix CJK IME input in the terminal webview: keep composition stable by skipping fit/repaint while composing, focus the xterm textarea on mousedown, raise the IME helper/composition UI above the renderer, and ensure the PTY environment has UTF-8 locale settings.
- Improve CJK glyph rendering with broader default font fallbacks (Hangul/Kanji/Hanzi-capable system fonts).

### Added

- Add title-bar toggle buttons for `ulw.toggleEditorLocation` on the sidebar view and the editor-group webview panel so the terminal can move between surfaces without the command palette.
- Keep running session output visible across surfaces by broadcasting live PTY output to both renderers and replaying scrollback when a fresh surface becomes ready.

## [1.12.7] - 2026-08-06

### Fixed

- Fix rendering artifacts (traces of previous frames) reported on some GPUs after 1.12.6, by restoring the terminal repaint safeguards that were dropped in the 1.12.4 rewrite: the terminal now fully repaints after a resize and again whenever its surface becomes visible.

### Added

- `ulw.renderer` (`webgl` default | `dom`): opt out of the WebGL renderer and use the DOM renderer. This is the recommended workaround when a GPU/driver produces WebGL ghosting. Reopen the terminal view (or reload the window) to apply.

## [1.12.6] - 2026-07-28

### Added

- Restore WebGL renderer for faster terminal rendering and smoother Korean/English IME input.
- Restore image paste support with clipboard data URL handling and temp file saving.
- Add sidebar ↔ editor group toggle command with a real editor webview surface that reuses the same shell.
- Add `ulw.defaultLocation` (`editor` default | `sidebar`) so ULW opens in an editor-group tab by default, or the secondary sidebar when configured.
- Replay recent scrollback when switching surfaces so the editor tab is not blank.
- Add editor/explorer context menu commands to send selection or file to terminal.

## [1.12.5] - 2026-07-28

### Fixed

- Copy mouse-dragged terminal selection to the system clipboard when the drag finishes.

## [1.12.4] - 2026-07-28

### Changed

- Reduce the extension to one native shell terminal in the VS Code secondary sidebar.
- Activate lazily when the contributed ULW view opens.
- Use a seven-message host/webview contract for ready, input, resize, output, exit, configuration, and focus.
- Read terminal foreground, background, cursor, selection, and ANSI colors from the active VS Code theme.
- Reapply xterm colors immediately when the VS Code theme changes.

### Removed

- Terminal multiplexer and alternate backend support.
- Session, instance, pane, window, dashboard, and editor-panel management.
- AI, HTTP, context-sharing, file-reference, clipboard-image, drag-and-drop, and code-action integrations.
- All contributed commands, menus, keybindings, and non-terminal settings.

### Verification

- Add focused PTY, provider, xterm, manifest, lifecycle, and real VS Code E2E coverage for the single-terminal flow.
- Add theme variable, fallback, and live mutation coverage for dark, light, and same-kind theme changes.

## [1.12.0] - 2026-06-10

### Changed

- Start the sidebar from `ulw.terminalBackend` only (`native`, `tmux`, or `zellij`) with a plain shell or multiplexer attach—no default AI tool or startup tool picker.
- Remove dashboard AI launch actions and host/webview `launchAiTool` / `launchDefaultAiTool` flows.

### Removed

- VS Code settings `ulw.aiTools` and `ulw.defaultAiTool`.
- AI tool selector e2e suite and related manifest/docs references.

### Fixed

- Align unit, coverage, and e2e tests with backend-first startup and removed launch APIs.

## [1.11.0] - 2026-06-03

### Added

- Add independent editor-terminal pane identities so each editor tab gets its own `ulw-editor-N` surface.

### Fixed

- Preserve the existing `islee23520.opencode-sidebar-tui` extension ID so current Marketplace/Open VSX users receive the ULW update in place.
- Fix tmux-backed editor terminal tabs reusing the sidebar/default pane session.
- Fix editor terminal input and resize messages so they target the correct editor pane.
- Correct the triage plan GitHub checks command to use the `islee23520/ulwcode` repository.

## [1.8.0] - 2026-05-18

### Added

- Add multi-backend terminal support with `native`, `tmux`, and `zellij` backend selection.
- Add native terminal backend support with ask-first AI tool selection.
- Add `ulw.terminalBackend` setting for choosing the terminal backend.
- Add `ulw.sendKeybindingsToShell` so terminal-focused Ctrl/Cmd shortcuts can be passed through to the TUI.

### Changed

- Change `ulw.autoStartOnOpen` default to `false` so users can choose which AI tool to launch when opening the sidebar.
- Rename dashboard command labels to `Open ULW Terminal Manager` for clearer VS Code command palette and menu wording.
- Improve Windows compatibility and terminal UX around shell handling, paths, clipboard behavior, and terminal focus.
- Expand automated test coverage across core commands, providers, services, terminals, webview keyboard handling, and VS Code mocks.

### Fixed

- Fix Shift+Enter newline handling in the sidebar terminal.
- Fix editor title actions so `Open Terminal in Editor` and `Open ULW Terminal Manager` only appear after the extension is fully active.
- Fix package repository URL metadata by removing the leading whitespace.

### Security

- Update dependency lockfile entries for `postcss`, `fast-uri`, `brace-expansion`, `ajv`, and `serialize-javascript`.
- Add a `serialize-javascript` override to force `^7.0.5`.

## [1.4.1] - 2026-03-03

### Fixed

- Fix all "Send to OpenCode" commands broken after 1.4.0 multi-instance patch
  - Root cause: `OpenCodeTuiProvider.startOpenCode()` did not write `terminalKey` into the InstanceStore, causing `getActiveTerminalId()` to resolve to a non-existent terminal ID
  - On fresh installs (empty store), `getActive()` threw → fallback to `"opencode-main"`, while the actual terminal was created with ID `"default"` → silent mismatch
  - Fixed by ensuring the instance store record is created/updated with the correct `terminalKey` after terminal creation
- Fix `sendFileToTerminal` (Send File Reference) not working from editor and explorer context menus
- Fix `sendAtMention` (Send @file) not working
- Fix `sendAllOpenFiles` (Send All Open Files) not working
- Fix `sendToTerminal` (Send Selected Text) not working

### Improved

- Support multi-file selection in Explorer context menu — selecting multiple files and using "Send to OpenCode" now sends all selected files as `@file1 @file2 @file3`
- Replace notification popups (`showInformationMessage`) with transient status bar messages (`setStatusBarMessage`) when sending files — less intrusive UX

## [1.3.2] - 2026-02-20

### Fixed

- Support multi-file selection in Explorer context menu - multiple files are now sent together as `@file1 @file2 @file3`
- Improve drag-and-drop handling for VS Code editor tabs - files dragged from editor tabs are now properly captured
- Remove duplicate "Send to OpenCode Terminal" from editor context menu - only "Send File Reference (@file)" remains
- Fix multi-file drag-and-drop from Explorer - all selected files are now processed instead of just the first one

## [1.1.0] - 2025-02-06

### Added

- **HTTP API Integration**: Bidirectional communication with OpenCode CLI via HTTP API
  - Auto-discovery of OpenCode CLI HTTP server on ephemeral ports (16384-65535)
  - Health check endpoint (`/health`) for availability validation
  - Prompt append endpoint (`/tui/append-prompt`) for sending commands
  - Exponential backoff retry logic for reliable communication
  - Configurable timeout (default: 5000ms)

- **Auto-Context Sharing**: Automatically shares editor context when terminal opens
  - Shares all open files on terminal startup
  - Includes line numbers for active selections
  - Format: `@path/to/file#L10-L20`
  - Configurable via `ulw.autoShareContext` setting

- **Port Management Service**: Ephemeral port allocation for HTTP communication
  - Port range: 16384-65535 (standard ephemeral range)
  - Collision detection and prevention
  - Per-terminal port tracking
  - Automatic cleanup on terminal closure

- **Context Sharing Service**: Editor context detection and formatting
  - Detects current file and selection
  - Formats file references with line numbers
  - Supports `@file`, `@file#L10`, `@file#L10-L20` formats

- **New Configuration Options**:
  - `ulw.enableHttpApi`: Enable/disable HTTP API (default: `true`)
  - `ulw.httpTimeout`: HTTP request timeout in milliseconds (default: `5000`, range: 1000-30000)
  - `ulw.autoShareContext`: Auto-share editor context on terminal open (default: `true`)

### Changed

- **Architecture Documentation**: Clarified sidebar-only architecture
  - Added explicit note that this is a sidebar-only extension (not native VS Code: terminal)
  - Documented HTTP API vs WebView messaging architecture
  - Updated feature list to highlight HTTP API capabilities

- **Communication Method**: Migrated from terminal I/O to HTTP API for reliable bidirectional communication
  - More reliable than terminal stdin/stdout parsing
  - Better error handling and retry capabilities
  - Cleaner separation of concerns

### Technical

- Added `OpenCodeApiClient` for HTTP communication with retry logic
- Added `PortManager` for ephemeral port allocation
- Added `ContextSharingService` for editor context detection
- Added `TerminalDiscoveryService` for terminal integration
- Added `OutputCaptureManager` for output handling
- Comprehensive test coverage for all new services

## [1.0.4] - 2025-01-XX

### Added

- Initial release with core functionality
- Auto-launch OpenCode when sidebar is activated
- Full TUI support with xterm.js and WebGL rendering
- File references with line numbers (`@filename#L10-L20`)
- Keyboard shortcuts (`Cmd+Alt+L`, `Cmd+Alt+A`)
- Drag & drop support for files
- Context menu integration
- Configurable terminal settings

### Features

- **Terminal Management**: node-pty backend with xterm.js frontend
- **File References**: Send current file or selection to OpenCode
- **Keyboard Shortcuts**: Quick access commands
- **Context Menus**: Right-click integration in Explorer and Editor
- **Drag & Drop**: Shift-drag files to send as references
- **Configuration**: Customizable command, font, and terminal settings

[1.3.2]: https://github.com/islee23520/ulwcode/compare/v1.1.0...v1.3.2
[1.1.0]: https://github.com/islee23520/ulwcode/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/islee23520/ulwcode/releases/tag/v1.0.4
