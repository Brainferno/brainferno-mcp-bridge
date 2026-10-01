---
id: AE-01
app: after-effects
title: Raw script access that clients can discover, plus ae_run_script
priority: P1
status: open
evidence: verified
depends_on: [X-01]
---

# AE-01 — Raw script access that clients can discover, plus `ae_run_script`

## Problem
An MCP client building many layers, masks, and expressions had no way to run a multi-step ExtendScript in one call, so it needed hundreds of tool calls. A raw-script tool exists (`cc_eval_script`), but the client never saw it:
- It is registered only when `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1` is set (`packages/server/src/config.ts:267`, `tools/diagnostics.ts:60-63`). When off, the tool is **absent from the tool list**, and the only hint is an info line on stderr (`diagnostics.ts:61`).
- That contradicts `CONTRIBUTING.md` ("Tools are registered unconditionally — a closed app returns the actionable error, it does not vanish from the tool list").
- `cc_eval_script` takes an `appId`; there is no After Effects–specific tool, and its description cannot explain AE conventions (undo group, project open, dialogs).
- The client also tried to launch a script from the command line (`AfterFX.exe -r <file.jsx>`); it exited with code 0 and ran nothing. The MCP route was the only option, and it was invisible.

## Add
1. **Register `cc_eval_script` (and every gated raw-script tool) unconditionally.** When the gate is off, a call returns: `Raw scripts are disabled. Set BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1 in the MCP server env and restart.` Coordinate with `X-01` (shared contract and gate state).
2. **`ae_run_script`** — After Effects raw script with AE-aware behavior.
   - Inputs: `script` (string, ES3, one IIFE or a statement list — state which in `.describe()`), `args` (object, optional, exposed to the script as `__args`), `undoGroupName` (default `"Brainferno script"`), `suppressDialogs` (boolean, default `true`), `timeoutMs` (optional; default from config).
   - Returns: `{ value, logs: string[], durationMs }`. `logs` collects calls to a provided `__log(msg)` helper.
   - Errors: `{ message, line, bodyLine }` where `bodyLine` is corrected for the helper prelude (see `AE-16`).
   - Annotations: `destructiveHint: true`; `timeoutClass: "slow"`. Same gate as `cc_eval_script`.
   - Log an audit line with a script hash, like `diagnostics.ts:92`.

## API hints (ES3)
- `app.beginUndoGroup(name)` / `app.endUndoGroup()` — one script = one Ctrl-Z.
- `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)` stops a missing-font or missing-footage dialog from hanging scripting. The existing MOGRT export already does this (see the repo's AE mogrt-export note).
- The panel entry is `__acmEval` in `packages/panel-cep/host.jsx`; it serializes with `__acmJson`. See `AE-05` for a serializer bug on `TextDocument`.
- Keep the script in one IIFE: `(function () { ... return value; })()`.

## Acceptance tests
1. Gate off: `ae_run_script` and `cc_eval_script` appear in the tool list; calling either returns the message above.
2. Gate on: `ae_run_script({ script: "(function(){ return app.version; })()" })` returns a string.
3. A script that creates two layers is undone by **one** Ctrl-Z.
4. A script that throws returns `{ message, line, bodyLine }` with `bodyLine` pointing into the user's script.
5. With a project open and a missing font, `suppressDialogs: true` returns instead of hanging.
6. ES3 check: the builder passes `es3Violations`; the user's script is not scanned.
Follow the test pattern in `00_PREAMBLE.md`.

## Definition of done
See `00_PREAMBLE.md`.
