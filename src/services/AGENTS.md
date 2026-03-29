# SERVICES KNOWLEDGE BASE

## OVERVIEW

Extension의 stateful backend. Instance lifecycle, discovery, HTTP, context, tmux, logging.

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
- Port allocation → `PortManager` 경유 (ad hoc 할당 금지)
- Tests → service 옆에 `*.test.ts` colocated

## ANTI-PATTERNS

- `InstanceStore` 외부에 instance state 중복 금지
- Port ad hoc 할당 금지 → `PortManager` 사용
- Provider에 tmux 로직 넣지 말 것 → `TmuxSessionManager`로
- `OutputChannelService` 직접 `new` 금지 → `getInstance()` 사용
- Mock 우회 금지 → `src/test/mocks/` 기존 패턴 따를 것

## KNOWN DEBT

- `PortManager` — provider/lifecycle에서 각각 생성 → singleton 통합 필요
