# PROVIDERS KNOWLEDGE BASE

## OVERVIEW

Extension-host code. Bridges VS Code webview views/actions with backend services.

## STRUCTURE

```
providers/
├── OpenCodeTuiProvider.ts           # Re-export from opencode/ (backward compat)
├── opencode/
│   ├── OpenCodeTuiProvider.ts       # Webview lifecycle shell (283 lines)
│   ├── OpenCodeMessageRouter.ts     # Message dispatch + all handlers (580 lines)
│   └── OpenCodeSessionRuntime.ts    # Start/restart/tmux/instance (695 lines)
├── TmuxSessionsDashboardProvider.ts # tmux dashboard (755 lines, inline HTML)
├── CodeActionProvider.ts            # Code actions (156 lines)
└── AGENTS.md
```

## WHERE TO LOOK

| Task             | Location                             | Lines | Notes                                             |
| ---------------- | ------------------------------------ | ----- | ------------------------------------------------- |
| Webview shell    | `opencode/OpenCodeTuiProvider.ts`    | 283   | resolveWebviewView, getHtmlForWebview, dispose    |
| Message handling | `opencode/OpenCodeMessageRouter.ts`  | 580   | handleMessage dispatch + 20+ handlers             |
| Session runtime  | `opencode/OpenCodeSessionRuntime.ts` | 695   | start/restart, tmux attach/switch, HTTP readiness |
| Tmux dashboard   | `TmuxSessionsDashboardProvider.ts`   | 755   | Inline HTML/CSS/JS (~450 lines)                   |
| Code actions     | `CodeActionProvider.ts`              | 156   | Focused, no issues                                |

## PROVIDER SPLIT — RESPONSIBILITY MAP

| Module                   | Owns                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `OpenCodeTuiProvider`    | webview lifecycle, HTML generation, nonce, public API surface                      |
| `OpenCodeMessageRouter`  | terminal I/O, clipboard, image paste, file open/drop, VS Code terminal bridge      |
| `OpenCodeSessionRuntime` | process start/restart, tmux session management, instance switching, HTTP readiness |

## CONVENTIONS

- Providers = extension host process (not browser)
- Message contracts use `src/types.ts` — no arbitrary shapes
- Provider role: routing, orchestration, state bridging only

## ANTI-PATTERNS

- No browser-only logic (DOM, rendering) here — belongs in `src/webview`
- No arbitrary message shapes — must update `src/types.ts`
- Never bypass `ExtensionLifecycle` for provider registration or command wiring

## KNOWN DEBT

- `TmuxSessionsDashboardProvider.ts` — inline HTML template to be split out
- `webview/dashboard.ts` — legacy orphan, deletion under review
