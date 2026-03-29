# TEST KNOWLEDGE BASE

## OVERVIEW

Vitest + manual mocks. `@vscode/test-electron` 미사용 — standalone runner.

## WHERE TO LOOK

| Task             | Location                     | Notes                                         |
| ---------------- | ---------------------------- | --------------------------------------------- |
| VS Code API mock | `src/test/mocks/vscode.ts`   | 363 lines, full API surface                   |
| node-pty mock    | `src/test/mocks/node-pty.ts` | `createMockPtyProcess()` + simulation helpers |
| Mock setup/reset | `src/test/mocks/index.ts`    | `setupMocks()`, `resetMocks()`                |
| Test setup       | `src/__tests__/setup.ts`     | Global vitest setup                           |
| Test colocated   | `src/**/*.test.ts`           | Service 옆에 `Foo.test.ts` 형태               |

## MOCK PATTERNS

```typescript
// vscode.ts — EventEmitter, workspace, window, commands 등 전체 API mock
// node-pty.ts — createMockPtyProcess() with _simulateData(), _simulateExit()

// Usage in tests:
import { vi } from "vitest";
vi.mock("vscode"); // vitest alias → src/test/mocks/vscode.ts
vi.mock("node-pty"); // vitest alias → src/test/mocks/node-pty.ts
```

## VITEST CONFIG

- `environment: "node"` — jsdom 미사용
- `vscode` aliased to `./src/test/mocks/vscode.ts`
- `mockReset: true` + `restoreMocks: true` — auto cleanup between tests
- Coverage: 80% lines/functions/statements, 70% branches
- **Webview 제외:** `src/webview/**`는 coverage에서 제외

## CONVENTIONS

- New service test → 해당 service 옆에 `*.test.ts` 생성
- 기존 mock pattern 우회 금지 → `src/test/mocks/` 사용
- Singleton test → `resetInstance()` / `resetMocks()` 호출 필수

## ANTI-PATTERNS

- `@vscode/test-electron` 사용 금지 — manual mock으로 대체됨
- Mock file 직접 수정 금지 → `vi.mock()` + helper functions 사용
- Singleton state 누락 금지 — 각 test에서 reset 필수
