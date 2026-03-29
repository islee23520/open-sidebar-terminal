# WEBVIEW KNOWLEDGE BASE

## OVERVIEW

Browser-sandbox code. xterm.js rendering, DOM events, host messaging via `acquireVsCodeApi()`.

## WHERE TO LOOK

| Task                  | Location       | Lines | Notes                                     |
| --------------------- | -------------- | ----- | ----------------------------------------- |
| Terminal UI bootstrap | `main.ts`      | 698   | xterm.js + WebGL + fit/resize             |
| Instance dashboard    | `dashboard.ts` | 142   | **Orphan** — not used by active providers |

## MAIN.TS — RESPONSIBILITY GROUPS

| Group                                    | Approx Lines | Notes                                                  |
| ---------------------------------------- | ------------ | ------------------------------------------------------ |
| Terminal init (xterm, addons, observers) | ~250         | FitAddon, WebglAddon, WebLinksAddon                    |
| File link parsing (regex, URL formats)   | ~110         | `@file#L`, `file://`, `/abs`, `./rel`, `path:line:col` |
| Drag-and-drop handling                   | ~220         | Path canonicalization, JSON/text parsing               |
| Message handlers                         | ~100         | 7 host message types                                   |
| Clipboard + image paste                  | ~80          | readText, writeText, image validation                  |

**Extract 예정:** link parser, drag-drop, clipboard를 각각 별도 모듈로

## CONVENTIONS

- Browser APIs only — `fs`, `path`, `os` 사용 금지
- Host communication → discriminated message payloads (`WebviewMessage`, `HostMessage`)
- Renderer stateless/light 유지 — data shaping은 providers/services에서
- xterm sizing/refresh → timing-sensitive; `fit()` → `refresh()` 순서 보존

## ANTI-PATTERNS

- Extension-host logic 여기에 넣지 말 것
- Shared message contracts 외부에 hardcode 금지
- Ad hoc DOM update로 existing render flow 우회 금지

## BUILD

Webpack이 2개 webview bundle 생성:

- `dist/webview.js` — `src/webview/main.ts` entry (xterm terminal)
- `dist/dashboard.js` — `src/webview/dashboard.ts` entry (instance dashboard — orphan)

**Note:** `dashboard.js` bundle은 현재 아무 provider에서도 참조하지 않음
