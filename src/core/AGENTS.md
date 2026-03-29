# CORE KNOWLEDGE BASE

## OVERVIEW

Extension activation/deactivation seam. Service wiring + command registration.

## STRUCTURE

```
core/
├── ExtensionLifecycle.ts        # Service creation, provider registration, activation
├── ExtensionLifecycle.test.ts   # Tests
├── commands/                    # Command registration (extracted from lifecycle)
│   ├── index.ts                 # registerCommands() + deps interface
│   ├── terminalCommands.ts      # start, restart, paste, file references (7 commands)
│   ├── tmuxSessionCommands.ts   # session switch/create/spawn/select (6 commands)
│   └── tmuxPaneCommands.ts      # 8 pane commands + QuickPick helpers
└── AGENTS.md
```

## WHERE TO LOOK

| Task                  | Location                             | Notes                                                 |
| --------------------- | ------------------------------------ | ----------------------------------------------------- |
| Activation flow       | `ExtensionLifecycle.ts`              | `activate()` creates 13 services, registers providers |
| Command registration  | `commands/index.ts`                  | `registerCommands(context, deps)` orchestrator        |
| Terminal commands     | `commands/terminalCommands.ts`       | start, restart, paste, sendToTerminal, sendAtMention  |
| Tmux session commands | `commands/tmuxSessionCommands.ts`    | switchTmuxSession, create, spawn, selectInstance      |
| Tmux pane commands    | `commands/tmuxPaneCommands.ts`       | 8 pane commands + `pickPaneFromActiveSession` helper  |
| Prompt routing        | `ExtensionLifecycle.ts`              | `sendPromptToOpenCode`, discovered-instance fallback  |
| Deactivation          | `ExtensionLifecycle.ts:deactivate()` | Disposes all services + providers                     |

## CONVENTIONS

- Commands는 `commands/`에 domain별로 분리 — lifecycle에는 직접 등록 금지
- `getCommandDependencies()`가 deps를 getter로 노출 → stale reference 방지
- TmuxSessionManager 생성은 tmux availability 조건부

## ANTI-PATTERNS

- Provider에서 직접 command register 금지 → 반드시 `commands/` 통과
- tmux pane 로직을 lifecycle에 넣지 말 것 → `TmuxSessionManager`로 이동 예정

## KNOWN DEBT

- `tmuxPaneCommands.ts` (412 lines) — pane QuickPick helper DRY화 완료, but lifecycle에 pane logic 잔존 가능
