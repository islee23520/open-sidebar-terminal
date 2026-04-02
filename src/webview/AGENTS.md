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

**Planned extraction:** link parser, drag-drop, and clipboard into separate modules

## CONVENTIONS

- Browser APIs only — no `fs`, `path`, `os`
- Host communication → discriminated message payloads (`WebviewMessage`, `HostMessage`)
- Keep renderer stateless/light — data shaping belongs in providers/services
- xterm sizing/refresh → timing-sensitive; preserve `fit()` → `refresh()` order

## ANTI-PATTERNS

- No extension-host logic here
- No hardcoding shared message contracts outside of `src/types.ts`
- No ad hoc DOM updates that bypass existing render flow

## BUILD

Webpack produces 2 webview bundles:

- `dist/webview.js` — `src/webview/main.ts` entry (xterm terminal)
- `dist/dashboard.js` — `src/webview/dashboard-manager.ts` entry (Terminal Manager dashboard)
