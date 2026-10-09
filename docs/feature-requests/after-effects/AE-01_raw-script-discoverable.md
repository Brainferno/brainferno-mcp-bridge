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
An MCP client building many layers, masks, and expressions had no way to run a multi-step ExtendScript in one call, so it needed hundreds of tool calls. A raw-script tool existed (`cc_eval_script`), but the client never saw it. X-01 fixed the discovery half:
- Since X-01, `cc_eval_script` is always registered and refuses while its gate is closed; `cc_get_capabilities` shows the gate per app. (Before X-01 it was absent from the tool list unless `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1`, the only hint an info line on stderr.)
- Since X-01, the raw-script contract lives once in `packages/server/src/tools/raw-script.ts`: the envelope, the ES3 wrapper (`__log`, the plain-data check, `bodyLine`), the gate (`rawGateState`), the refusal texts and the audit line (`auditRawCall`). `ae_run_script` reuses all of it — it re-implements none of it (`CONTRIBUTING.md`, "Raw-script tools — one contract").
- Still open: `cc_eval_script` takes an `appId`; there is no After Effects–specific tool, and its description cannot explain AE conventions (undo group, project open, dialogs).
- Still open: a raw script is not yet one After Effects undo step — the X-01 wrapper opens no undo group, so a script that makes ten changes takes ten Ctrl-Zs. `ae_run_script` adds the undo group.
- The client also tried to launch a script from the command line (`AfterFX.exe -r <file.jsx>`); it exited with code 0 and ran nothing. The MCP route was the only option, and it was invisible.

## Add
1. **Gate and refusal: reuse X-01.** `ae_run_script` is registered unconditionally, checks `rawGateState("after_effects", …)` before touching the bridge, and refuses with the shared text (`RAW_SCRIPTS_DISABLED_MESSAGE`, which `rawScriptsDisabledMessage` extends with the target app and the enabled list). Never write a second refusal string.
2. **`ae_run_script`** — After Effects raw script with AE-aware behavior.
   - Inputs: `script` (string, ES3, one IIFE or a statement list — state which in `.describe()`), `args` (object, optional, exposed to the script as `__args`), `undoGroupName` (default `"Brainferno script"`), `suppressDialogs` (boolean, default `true`), `timeoutMs` (optional; default from config).
   - Runs the caller's script through `rawScriptWrapper` inside `app.beginUndoGroup(undoGroupName)` / `app.endUndoGroup()` (end it in a `finally`), so one call is one Ctrl-Z — the part X-01 does not do.
   - Returns: the X-01 envelope `{ ok, error?, durationMs, value, logs, logsDropped? }` (`toEnvelope` / `envelopeResult`); `logs` collects `__log(msg)` calls.
   - Errors: `{ message, line, bodyLine }` as the wrapper computes it; if `ae_run_script` adds code around the caller's text, make sure `bodyLine` still points into the caller's script (see `AE-16`). Dispatched failures go through `dispatchedFailure` (JSON envelope); not-dispatched ones stay plain text.
   - Annotations: `destructiveHint: true`; `timeoutClass: "slow"`. Same gate as `cc_eval_script`.
   - Audit every call, run or refused, with `auditRawCall`.

## API hints (ES3)
- `app.beginUndoGroup(name)` / `app.endUndoGroup()` — one script = one Ctrl-Z.
- `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)` stops a missing-font or missing-footage dialog from hanging scripting. The existing MOGRT export already does this (see the repo's AE mogrt-export note).
- The panel entry is `__acmEval` in `packages/panel-cep/host.jsx`; it serializes with `__acmJson`. See `AE-05` for a serializer bug on `TextDocument`.
- Keep the script in one IIFE: `(function () { ... return value; })()`.

## Acceptance tests
1. Gate off: `ae_run_script` and `cc_eval_script` appear in the tool list; calling either returns an `isError` text that `toContain(RAW_SCRIPTS_DISABLED_MESSAGE)`, and a connected fake After Effects panel receives no command.
2. Gate on: `ae_run_script({ script: "(function(){ return app.version; })()" })` returns a string.
3. A script that creates two layers is undone by **one** Ctrl-Z.
4. A script that throws returns `{ message, line, bodyLine }` with `bodyLine` pointing into the user's script.
5. With a project open and a missing font, `suppressDialogs: true` returns instead of hanging.
6. ES3 check: the builder passes `es3Violations`; the user's script is not scanned.
Follow the test pattern in `00_PREAMBLE.md`.

## Definition of done
See `00_PREAMBLE.md`.
