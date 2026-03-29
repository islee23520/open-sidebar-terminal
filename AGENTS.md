# PROJECT KNOWLEDGE BASE

**Updated:** 2026-03-29 Asia/Seoul
**Commit:** 355d827 | **Branch:** feat/tmux

## OVERVIEW

VS Code extension — OpenCode TUI를 sidebar에 embed. PTY + HTTP 통신 + tmux session management.

## STRUCTURE

```
./
├── src/                     # extension host + webview source
│   ├── extension.ts         # VS Code entry (activate/deactivate)
│   ├── types.ts             # shared host↔webview message contracts
│   ├── core/                # lifecycle orchestration + command registration
│   ├── providers/           # VS Code webview providers (extension host side)
│   ├── services/            # stateful backend: instances, tmux, HTTP, context
│   ├── terminals/           # node-pty process management
│   ├── webview/             # browser-only code (xterm.js bundles)
│   ├── test/mocks/          # manual vscode + node-pty mocks
│   ├── utils/               # shared utilities
│   └── __tests__/           # vitest setup
├── dist/                    # webpack output (extension.js, webview.js, dashboard.js)
├── resources/               # activity bar icon
├── docs/, memories/         # ULW notes
└── package.json             # contribution points, scripts, config keys
```

## ARCHITECTURE

```
extension.ts → ExtensionLifecycle.activate()
  ├── 13 services created (manual DI, no container)
  ├── 2 providers registered (OpenCodeTuiProvider, TmuxSessionsDashboardProvider)
  ├── CodeActionProvider registered
  └── 21 commands registered via core/commands/
```

**Webpack 2 bundles:** extension.js (node), webview.js (web)

**Host↔Webview messages:** discriminated unions in `src/types.ts`

- `WebviewMessage` — webview→host (input, resize, file refs, tmux actions)
- `HostMessage` — host→webview (output, clipboard, visibility, platform)
- `TmuxDashboardActionMessage` — tmux dashboard actions (15 action types)

## WHERE TO LOOK

| Task                  | Location                                         | Notes                                                     |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Activation / wiring   | `src/core/ExtensionLifecycle.ts`                 | 394 lines — service creation + provider registration      |
| Command registration  | `src/core/commands/`                             | 4 files: terminal, tmuxSession, tmuxPane, index           |
| Main sidebar terminal | `src/providers/opencode/OpenCodeTuiProvider.ts`  | 283 lines shell + MessageRouter + SessionRuntime          |
| Tmux dashboard        | `src/providers/TmuxSessionsDashboardProvider.ts` | 755 lines, inline HTML                                    |
| Instance state        | `src/services/InstanceStore.ts`                  | EventEmitter hub, all services depend here                |
| Tmux CLI wrapper      | `src/services/TmuxSessionManager.ts`             | Standalone, used by both providers                        |
| HTTP API              | `src/services/OpenCodeApiClient.ts`              | Retry/backoff, prompt append                              |
| Browser terminal UI   | `src/webview/main.ts`                            | 698 lines, xterm.js + drag/drop + links                   |
| Shared contracts      | `src/types.ts`                                   | Message types, DTOs, ExtensionConfig                      |
| Test mocks            | `src/test/mocks/`                                | Manual vscode.ts + node-pty.ts (no @vscode/test-electron) |

## CODE MAP

| Symbol                 | Type     | Location                               | Role                                   |
| ---------------------- | -------- | -------------------------------------- | -------------------------------------- |
| `activate`             | function | `src/extension.ts`                     | VS Code extension entry                |
| `ExtensionLifecycle`   | class    | `src/core/ExtensionLifecycle.ts`       | Service creation, command registration |
| `OpenCodeTuiProvider`  | class    | `src/providers/OpenCodeTuiProvider.ts` | Main sidebar webview provider          |
| `TmuxSessionManager`   | class    | `src/services/TmuxSessionManager.ts`   | tmux CLI: sessions, panes, attach      |
| `InstanceStore`        | class    | `src/services/InstanceStore.ts`        | In-memory instance state + events      |
| `TerminalManager`      | class    | `src/terminals/TerminalManager.ts`     | node-pty process lifecycle             |
| `OutputChannelService` | class    | `src/services/OutputChannelService.ts` | Singleton logger (`getInstance()`)     |

## SINGLETONS

- `OutputChannelService` — `getInstance()` static method + `resetInstance()` for tests
- `portManager` — module-level export in `PortManager.ts`

## EVENT PATTERNS

- `InstanceStore` — Node `EventEmitter`: `change`, `setActive`, `add`, `remove`
- `TerminalManager` — VS Code `EventEmitter`: `onData`, `onExit`
- `FileReferenceManager` — VS Code `EventEmitter`: `onDidAddReference`, `onDidRemoveReference`

## CONVENTIONS

- TypeScript `strict: true`; diagnostics must stay clean on changed files
- PascalCase classes; lowercase entrypoints (`extension.ts`, `main.ts`)
- Tests colocated as `*.test.ts`; manual mocks in `src/test/mocks/`
- Webview code = browser-only; extension host code = `providers/`, `services/`, `core/`
- `dist/` is the build output; never `out/`

## ANTI-PATTERNS (THIS PROJECT)

- `src/webview`에서 Node API 사용 금지 (`fs`, `path`, `os` 불가)
- `InstanceStore` 외부에 instance state 중복 금지
- Provider에 tmux 로직 넣지 말 것 → `TmuxSessionManager`로
- 새 message shape 추가 시 반드시 `src/types.ts` 업데이트
- `OutputChannelService` 직접 `new` 금지 → `getInstance()` 사용
- Mock 우회 금지 → `src/test/mocks/` 기존 패턴 따를 것

## KNOWN DEBT

- `TmuxSessionsDashboardProvider.ts` (755 lines) — inline HTML, split 필요
- `PortManager` — provider와 lifecycle에서 각각 생성 (singleton 통합 필요)
- `webview/dashboard.ts` — legacy orphan, 삭제 검토 필요

## BUILD & TEST

```bash
npm run compile          # dev build (webpack)
npm run watch            # watch mode
npm run package          # production build (--mode production)
npm run test             # vitest
npm run test:coverage    # vitest + coverage (80/80/70/80 thresholds)
npm run build-and-install # package → install to VS Code
```

**Coverage:** lines 80%, functions 80%, branches 70%, statements 80%
**Webview 제외:** `src/webview/**`는 coverage 대상 아님

## NOTES

- `vitest.config.ts`에서 `vscode`를 `./src/test/mocks/vscode.ts`로 alias
- `.vscodeignore`가 agent artifacts 전부 제외 (`.sisyphus/`, `.claude/`, `.opencode/` 등)
- Publish flow: tag-triggered (`v*`) → VS Code Marketplace + Open VSX dual publish
