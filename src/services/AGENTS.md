# SERVICES KNOWLEDGE BASE

## OVERVIEW

The extension's stateful backend. Instance lifecycle, discovery, HTTP, context, tmux, and logging.

## WHERE TO LOOK

| Task                    | Location                      | Lines | Notes                                          |
| ----------------------- | ----------------------------- | ----- | ---------------------------------------------- |
| Instance state hub      | `InstanceStore.ts`            | 242   | EventEmitter, active instance, change events   |
| Lifecycle orchestration | `InstanceController.ts`       | 357   | spawn/connect/disconnect/kill/resolve          |
| Process discovery       | `InstanceDiscoveryService.ts` | 562   | Process scan, auto-spawn, store sync           |
| Persistence             | `InstanceRegistry.ts`         | 322   | globalState/workspaceState, migration          |
| 4-tier resolution       | `ConnectionResolver.ts`       | 258   | stored → discovered → spawned + client pool    |
| HTTP client             | `OpenCodeApiClient.ts`        | 165   | Retry/backoff, `/health`, `/tui/append-prompt` |
| Port allocation         | `PortManager.ts`              | 271   | Singleton export, range 16384-65535            |
| Tmux CLI                | `TmuxSessionManager.ts`       | 462   | Standalone, no service deps                    |
| Context observation     | `ContextManager.ts`           | 142   | Active editor, selection, diagnostics          |
| Context formatting      | `ContextSharingService.ts`    | 141   | `@file#L` formatter                            |
| File references         | `FileReferenceManager.ts`     | 282   | Serialize, git diff, dir expansion             |
| Quick pick UI           | `InstanceQuickPick.ts`        | 272   | Store + discovery + controller wiring          |
| Logging                 | `OutputChannelService.ts`     | 124   | Singleton (`getInstance()`)                    |
| Output capture          | `OutputCaptureManager.ts`     | 119   | `script` command to temp file                  |

## INSTANCE LAYER — CORRECT SEPARATION

```
InstanceStore (in-memory state + events)
  ↑ hydrates/persists        ↑ writes (discovery)    ↑ writes (user actions)
InstanceRegistry ─────── InstanceDiscoveryService ─ InstanceController
                                   ↓ reads               ↓ reads
                              OpenCodeApiClient      PortManager, TerminalManager
                                   ↓
                            ConnectionResolver (chains discovery → spawn + client pool)
```

## SINGLETONS

- `OutputChannelService.getInstance()` — global logging
- `portManager` (module-level export) — port allocation

## CONVENTIONS

- Async flows → `try/catch` + actionable logs
- Port allocation → via `PortManager` (no ad hoc allocation)
- Tests → colocated as `*.test.ts` next to the service

## ANTI-PATTERNS

- No duplicating instance state outside `InstanceStore`
- No ad hoc port allocation — use `PortManager`
- No tmux logic in providers — use `TmuxSessionManager`
- Never `new OutputChannelService()` — use `getInstance()`
- Never bypass mocks — follow existing patterns in `src/test/mocks/`

## KNOWN DEBT

- `PortManager` — created separately in provider and lifecycle (needs singleton consolidation)
