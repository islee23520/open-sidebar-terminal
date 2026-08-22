# Herdr 0.8.2 control-bridge protocol

This document pins the live behavior of `/Users/ilseoblee/.local/bin/herdr` version `0.8.2` on macOS. It is generated from an isolated workspace created with:

```text
herdr workspace create --cwd <mktemp-dir> --label ulw-probe --no-focus
```

No pre-existing pane was controlled. The reproducible probe is:

```text
node script/qa/probe-herdr-control.mjs --herdr /Users/ilseoblee/.local/bin/herdr --evidence .omo/evidence/task-1-herdr-agent-attach
```

Every child process has a 12,000 ms hard kill timeout; expected records have a 5,000 ms timeout. Evidence paths are `.omo/evidence/task-1-herdr-agent-attach/{raw.ndjson,probe.log,summary.json,cleanup.json,protocol.md}`. `raw.ndjson` is the authoritative raw transcript; line numbers below refer to that file. The captured scratch identifiers are disposable evidence values, not API constants.

## 1-12 answers

| # | Question | Locked 0.8.2 answer | Exact invocation/command | Evidence |
|---:|---|---|---|---|
| 1 | First controller record | Yes: the first record is a complete checkpoint, `type:"terminal.frame"`, `full:true`, `seq:1`, `width:52`, `height:12`, `encoding:"ansi"`. Exact JSON is RAW line 1. | `herdr terminal session control <scratch-terminal-id> --takeover --cols 52 --rows 12` | `raw.ndjson:1` |
| 2 | Every frame field and bytes encoding | Exactly seven fields were observed and asserted: `type`, `bytes`, `encoding`, `full`, `width`, `height`, `seq`. `bytes` is standard base64; decoding yields ANSI/VT terminal bytes. `encoding` is the literal string `ansi`. `full:true` replaces the terminal checkpoint; `full:false` is a following delta. Sequence numbers are per bridge connection and start at 1. | Decode with `Buffer.from(record.bytes, "base64")`; reject missing/extra fields. | `raw.ndjson:1-6`; `summary.json.probes.frame_fields` |
| 3 | UTF-8 split across records | The CJK command was sent through the base64 input form. The captured output placed `가나다` in one delta record; no frame boundary split an individual UTF-8 code point in this run. Consumers must still stream-decode decoded frame bytes because base64 frame boundaries are not a UTF-8 framing guarantee. | `{"type":"terminal.input","bytes":"cHJpbnRmICfqsIDrgpjri6RcbicK"}` | `probe.log` input entry; `raw.ndjson:3`; `summary.json.probes.utf8_split` |
| 4 | Stdin input and marker round-trip | Text form is `{"type":"terminal.input","text":"printf 'ULW_PROBE_OK\\n'\n"}`. Base64 byte form also works: `{"type":"terminal.input","bytes":"<base64>"}`. Sending both `text` and `bytes` is rejected by the bridge with `terminal.input accepts text or bytes, not both`. Sending neither field is silently ignored: no error and no frame. ULW's transport **MUST validate exactly one field client-side before writing**. The marker round-tripped in a delta frame. | Write one NDJSON object plus `\n` to control stdin; negative forms are sent before CJK output. | `probe.log` entries `primary stdin` for valid/both/neither forms; output `raw.ndjson:2-3`; `summary.json.probes.input.negative_validation` |
| 5 | Changed and unchanged resize | Shape: `{"type":"terminal.resize","cols":61,"rows":14}`. Changed size emitted a `full:true` 61x14 checkpoint. Repeating the same size also emitted a second `full:true` 61x14 checkpoint. Therefore every accepted resize should be treated as capable of forcing replacement, even when dimensions are unchanged. | Send the exact resize object twice. | `raw.ndjson:4-5`; `summary.json.probes.resize` |
| 6 | Wheel and PageUp/PageDown scroll | Shape has `type`, `direction`, `lines`, `source`, `column`, `row`, plus numeric bitmask `modifiers`. Wheel: `{"type":"terminal.scroll","direction":"up","lines":3,"source":"wheel","column":4,"row":4,"modifiers":0}`. PageUp/PageDown use `source:"page_key"`, directions `up`/`down`, and page-sized `lines` (14 here). **Informational-only limitation:** 0.8.2 provides no explicit scroll ACK. Wheel happened to be followed by frames, while PageUp/PageDown emitted no command-correlated record; all three produced no rejection stderr and the bridge remained writable. The probe therefore validates accepted command shape, not semantic scrolling for the page-key cases. | Send each object separately, observe one quiet window, then prove continued writability with `ULW_SCROLL_OK`. | `probe.log` entries `primary stdin` for each scroll; wheel-following frames `raw.ndjson:6-8`; marker `raw.ndjson:9`; `summary.json.probes.scroll.observations` |
| 7 | Release closure and ownership | `{"type":"terminal.release"}` produces `{"reason":"detached","type":"terminal.closed"}` and the bridge exits 0. `herdr pane read` still exits 0 afterward, and a successor controller can attach. | Send release, await closure, then run `herdr pane read <scratch-pane> --lines 20 --format text`. | `raw.ndjson:10`; `summary.json.probes.release` |
| 8 | EOF, SIGTERM, SIGKILL | stdin EOF emits `terminal.closed` reason `detached` and exits 0 (`raw:12`). SIGTERM and SIGKILL terminate locally without any closure record. Immediate successor takeover obtained a first full frame after both signals (`raw:16`, `raw:19`), proving server ownership was released on this host. Do not rely on a closure record after signals. | Close stdin; `kill(SIGTERM)`; `kill(SIGKILL)`; after each, spawn a successor controller. | `raw.ndjson:11-21`; `summary.json.probes.{eof,sigterm,sigkill}` |
| 9 | Displaced controller | A second `control --takeover` closes the first with exact record `{"reason":"terminal attach taken over","type":"terminal.closed"}`. The probe asserts exact string equality. The displaced process exits 0 and the second receives a full frame. | Spawn two control bridges against only the scratch terminal. | closure `raw.ndjson:22`; successor `raw.ndjson:23`; `summary.json.probes.displacement` |
| 10 | Visible grid while observe reads | `terminal session observe --cols 30 --rows 8` receives a 30x8 full checkpoint. A controller resize to 47x11 emits a `full:true` controller frame at exactly 47x11. Every observer frame captured afterward remained exactly 30x8; the probe asserts both dimension pairs and requires at least one post-resize observer frame. Thus each client renders at its requested grid. | Controller 52x12, observer 30x8, then controller `terminal.resize` to 47x11. | observer `raw.ndjson:25,27`; controller resize `raw.ndjson:26`; `summary.json.probes.observe_grid` |
| 11 | Named session and unsupported errors | Global placement is `/path/herdr --session <name> terminal session control ...`; `--session` must precede the subcommands. `--session ulw-probe-nonexistent --version` still prints `herdr 0.8.2`. Control against that absent named session exits 1 with `failed to connect to server`, advice to start `herdr server`, and the resolved `.../sessions/<name>/herdr-client.sock`. A bogus target on the live session exits 0 with `{"reason":"terminal session control failed: terminal target ulw-probe-bogus not found","type":"terminal.closed"}`. ULW's minimum remains 0.8.0; the probe hard-pins installed 0.8.2. | See `summary.json.probes.named_session.control_argv`. | named-version, absent-session stderr, and bogus-target JSON in `probe.log` entries `named-session version invocation`, `named-session missing-server invocation`, and `live-session bogus-target invocation`; `summary.json.probes.named_session` |
| 12 | Long-run retention | After emitting 240 numbered lines plus `ULW_RET_DONE`, `pane read --lines 300` contained all 240 numbered output lines, including `ULW_RET_001` and `ULW_RET_240`, plus command/done matches. These facts are asserted. A fresh 47x11 observer received only the visible tail as its initial full frame, not line 1. Replay therefore needs latest-full-plus-following-deltas. The independent 8 MiB checkpoint overflow was **not exercised**; the bound remains a product-side requirement. | Emit 240 lines, assert pane-read count/first/last/done, then start a fresh observer. | emission `raw.ndjson:30`; fresh full `raw.ndjson:32`; `summary.json.probes.retention` |

## Exact record and command schemas

Controller stdout is NDJSON:

```json
{"bytes":"<standard-base64 ANSI bytes>","encoding":"ansi","full":true,"height":12,"seq":1,"type":"terminal.frame","width":52}
{"reason":"detached","type":"terminal.closed"}
```

Controller stdin is NDJSON, one object per line:

```json
{"type":"terminal.input","text":"printf 'ULW_PROBE_OK\\n'\n"}
{"type":"terminal.input","bytes":"cHJpbnRmICfqsIDrgpjri6RcbicK"}
{"type":"terminal.input","text":"printf 'ULW_INVALID_BOTH_TEXT\\n'\n","bytes":"cHJpbnRmICdVTFdfSU5WQUxJRF9CT1RIX0JZVEVTXG4nCg=="}
{"type":"terminal.input"}
{"type":"terminal.resize","cols":61,"rows":14}
{"type":"terminal.scroll","direction":"up","lines":3,"source":"wheel","column":4,"row":4,"modifiers":0}
{"type":"terminal.scroll","direction":"up","lines":14,"source":"page_key","column":0,"row":0,"modifiers":0}
{"type":"terminal.scroll","direction":"down","lines":14,"source":"page_key","column":0,"row":0,"modifiers":0}
{"type":"terminal.release"}
```

For `terminal.input`, sending both `text` and `bytes` is rejected by the bridge with stderr `terminal.input accepts text or bytes, not both`. Sending neither field is silently ignored: no error and no frame. ULW's transport **MUST validate exactly one field client-side before writing**. The scroll command has no explicit protocol acknowledgment; accepted shape is inferred only from no rejection stderr and continued bridge writability, and semantic PageUp/PageDown behavior remains informational rather than locked by this probe. Production code must validate exact command shapes rather than trust process exit status.

## Replay and lifecycle rules for ULW

1. Do not cut over until the first valid `terminal.frame` with `full:true`.
2. Base64-decode `bytes`; feed decoded ANSI bytes through a streaming decoder/terminal parser.
3. Replace replay state on every `full:true`, including unchanged-dimension resize checkpoints.
4. Append `full:false` deltas after the latest full frame, capped at 8 MiB total.
5. Treat `terminal.closed` `detached` as release; map `terminal attach taken over` to takeover; preserve other reason strings as protocol diagnostics.
6. On EOF/SIGTERM/SIGKILL, process exit may be the only closure signal.
7. A fresh observer/controller full frame is viewport-sized, not complete scrollback. `pane read` is richer but is not part of the streaming bridge.

## Deviations from plan assumptions D2/D5/D6

- **D2 amended:** 0.8.2 emits typed `terminal.frame` and `terminal.closed`, not the 0.7.5-era bare `{"bytes":"..."}` shape. Writable input is supported directly through `terminal.input`; no `pane.send_text` fallback is required. Both `text` and base64 `bytes` forms exist. Sending both is rejected with `terminal.input accepts text or bytes, not both`; sending neither is silently ignored with no error and no frame. ULW must validate exactly one field client-side.
- **D5 confirmed/amended:** the first frame is `full:true`; live `terminal.resize` exists. Both changed-size and unchanged-size resize produced a new `full:true` checkpoint, so resize does not require bridge respawn.
- **D6 amended:** scrolling is typed `terminal.scroll`, with `source:"wheel"` or `source:"page_key"`, positive `lines`, direction, coordinates, and numeric modifier bitmask. Decoded frames contain terminal mode escapes (for example cursor and synchronized-update modes), so code must not assume an escape-free or mouse-sequence-free stream; selection behavior requires real-surface QA.

## Raw transcript and cleanup

The full unedited NDJSON transcript is committed as evidence at `.omo/evidence/task-1-herdr-agent-attach/raw.ndjson`. Cleanup closed the exact returned workspace ID, verified it absent from `herdr workspace list`, verified no `ulw-probe` label remained, removed the temporary directory, and left no tracked probe child alive. See `cleanup.json` for the receipt.

This shell probe does not establish GUI-launch PATH or socket inheritance; that belongs to the extension-host integration test.
