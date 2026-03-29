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

- Commands are split by domain in `commands/` — never register directly in lifecycle
- `getCommandDependencies()` exposes deps via getter to prevent stale references
- `TmuxSessionManager` creation is conditional on tmux availability

## ANTI-PATTERNS

- Never register commands directly in providers — must go through `commands/`
- Never put tmux pane logic in lifecycle — delegate to `TmuxSessionManager`

## KNOWN DEBT

- `tmuxPaneCommands.ts` (412 lines) — pane QuickPick helper DRY refactor done, but some pane logic may still remain in lifecycle
