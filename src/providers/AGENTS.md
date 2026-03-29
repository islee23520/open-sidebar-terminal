# PROVIDERS KNOWLEDGE BASE

## OVERVIEW

Extension-host code. VS Code webview views/actions를 backend services와 bridge.

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
- Message contracts는 `src/types.ts` 사용 — 임의 shape 금지
- Provider 역할: routing, orchestration, state bridging only

## ANTI-PATTERNS

- Browser-only logic (DOM, rendering) 여기에 넣지 말 것 → `src/webview`
- 새 message shape 임의 생성 금지 → `src/types.ts` 업데이트 필수
- `ExtensionLifecycle` bypass하여 provider registration/command wiring 금지

## KNOWN DEBT

- `TmuxSessionsDashboardProvider.ts` — inline HTML template 분리 예정
- `webview/dashboard.ts` — legacy orphan, 삭제 검토 필요
