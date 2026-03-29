# Extension UI layout manifest

This review artifact captures the current UI direction for the extension as a coding-AI-first VS Code sidebar experience.

## Canonical layout source

- `resources/layout.pen` is the source-of-truth layout file for this UI map.
- When the extension UI changes, update `resources/layout.pen` first, then refresh the exported review artifacts in `docs/`.

## Exported artifacts

| File              | Surface                            | Notes                                                                                                                                     |
| ----------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/bi8Au.png`  | Whole extension UI map             | Shows Activity Bar entry, terminal-only main view, sibling launch/runtime view, and secondary surfaces.                                   |
| `docs/1lUlp.png`  | Terminal view detail               | Shows the main sidebar view with no tmux tabs or controls. The terminal stays the dominant coding AI surface.                             |
| `docs/6yJsR.png`  | Sibling launch/runtime view detail | Shows the separate control surface with registered coding tools, launch actions, multiple native/tmux instances, tabs, and runtime state. |
| `docs/export.pdf` | Combined review pack               | Multi-page export of the three frames for quick review.                                                                                   |

## Design decisions captured

- The main terminal view is reserved for OpenCode terminal rendering and AI coding output.
- Before any new terminal starts, the sibling control view shows registered coding tools and lets the user pick one.
- Instance tabs, launch actions, and runtime controls live only in the sibling launch/runtime view.
- The sibling view can create multiple terminal instances in either tmux or native mode.
- The terminal view does not reserve height for launch/runtime controls and does not overlay them above the xterm surface.
- Secondary contribution points such as commands, keybindings, context menus, settings, and message contracts are documented as annotations rather than competing primary screens.

## Source grounding

- `docs/tmux-sessions-panel-actions.md`
- `src/providers/OpenCodeTuiProvider.ts`
- `src/providers/TmuxSessionsDashboardProvider.ts`
- `src/webview/sidebar/types.ts`
