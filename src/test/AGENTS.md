# TEST KNOWLEDGE BASE

## OVERVIEW

Vitest + manual mocks. `@vscode/test-electron` is not used — standalone runner.

## WHERE TO LOOK

| Task             | Location                     | Notes                                         |
| ---------------- | ---------------------------- | --------------------------------------------- |
| VS Code API mock | `src/test/mocks/vscode.ts`   | 363 lines, full API surface                   |
| node-pty mock    | `src/test/mocks/node-pty.ts` | `createMockPtyProcess()` + simulation helpers |
| Mock setup/reset | `src/test/mocks/index.ts`    | `setupMocks()`, `resetMocks()`                |
| Test setup       | `src/__tests__/setup.ts`     | Global vitest setup                           |
| Test colocated   | `src/**/*.test.ts`           | `Foo.test.ts` placed next to the service      |

## MOCK PATTERNS

```typescript
// vscode.ts — EventEmitter, workspace, window, commands, full API mock
// node-pty.ts — createMockPtyProcess() with _simulateData(), _simulateExit()

// Usage in tests:
import { vi } from "vitest";
vi.mock("vscode"); // vitest alias → src/test/mocks/vscode.ts
vi.mock("node-pty"); // vitest alias → src/test/mocks/node-pty.ts
```

## VITEST CONFIG

- `environment: "node"` — jsdom not used
- `vscode` aliased to `./src/test/mocks/vscode.ts`
- `mockReset: true` + `restoreMocks: true` — auto cleanup between tests
- Coverage: 80% lines/functions/statements, 70% branches
- **Webview excluded:** `src/webview/**` is excluded from coverage

## CONVENTIONS

- New service test → create `*.test.ts` next to the service
- Never bypass existing mock patterns — use `src/test/mocks/`
- Singleton tests → must call `resetInstance()` / `resetMocks()`

## ANTI-PATTERNS

- Never use `@vscode/test-electron` — replaced by manual mocks
- Never modify mock files directly — use `vi.mock()` + helper functions
- Never leave singleton state uncleared — reset in each test
