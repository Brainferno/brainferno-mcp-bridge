---
id: AE-16
app: after-effects
title: Error quality — corrected line numbers, tool name and path context, "did you mean"
priority: P2
status: open
evidence: verified
depends_on: []
---

# AE-16 — Error quality

## Problem
Script failures are hard to act on.
- **Line numbers do not map to the tool body.** Every After Effects tool script is wrapped by `wrap()` (`after-effects.ts` ~line 122) with a 79-line `HELPERS` prelude (lines ~41-119). In the generated script, line 1 is `(function () {`, lines 2-80 are helpers, and the tool body starts at about line 82. Nothing corrects for this offset. Observed errors read `Script failed in after_effects (line 20)`, `(line 40)`, `(line 90)` for failures that happened in the tool body. (`guard()` formats the message at `tools/result.ts:56-58`; the raw `e.line` travels `host.jsx:55` → `main.js:90` → `socket.ts:400` → `ScriptError`.) Whether After Effects reports eval-relative lines for multi-line scripts is not verified — test it.
- **No tool name or arguments** appear in the message, so a client running several calls at once cannot tell which one failed.
- **Property-path errors give no context.** `Property path not found at ADBE Text Properties` does not say which layer was addressed, what kind of layer it was (the real cause was a layer index that now pointed at a shape layer), or what children exist at that point.
- **Bad names fail without suggestions**: effect match names, property match names, font PostScript names (see `AE-04`).
- `CONTRIBUTING.md` plans error-code prefixes (`APP_NOT_CONNECTED`, `SCRIPT_ERROR`, `TIMEOUT`, `JOB_FAILED`, `PATH_DENIED`); they are not applied to script failures.

## Add
1. **Correct the line number.** Record the prelude length when `wrap()` builds the script (pass it through `EvalOptions`), and in `guard()` report `bodyLine = line - preludeLines`. Keep the raw line as `scriptLine`. Include a 3-line excerpt of the body around the failure with a `>>>` marker.
2. **Add context to every `ScriptError`**: tool name, and the arguments echoed (long strings truncated at 80 chars; never echo anything that looks like a token or key).
3. **Property-path failures** (`__prop` in `HELPERS`): say `layer "<name>" (kind text) → ["ADBE Text Properties", ...]: segment "X" not found; children here: [...]`. Return the resolved prefix, the failing segment, and up to 10 child match names.
4. **Lookup failures** (`__comp`, `__layer`): list valid indexes or names (cap at 20) and the layer kind you did find.
5. **"Did you mean"**: a small Levenshtein helper (server side) used for effect names, property match names, and font names; return the 3 closest.
6. **Error-code prefixes** per `CONTRIBUTING.md`: `SCRIPT_ERROR` for host script failures, applied consistently, with the human message after it.
7. Keep messages one paragraph; keep "what happened — what to do next".

## API hints
- Server side only except for step 3/4 (small additions to `HELPERS`, ES3).
- `ScriptError` carries `appId`, `message`, `scriptLine`; extend it with `bodyLine`, `tool`, `args`.
- A test script can throw at a known body line and assert the corrected number.

## Acceptance tests
1. A tool whose body throws at its 3rd statement reports `bodyLine` equal to that statement's line **in the body**, not +80.
2. A wrong property path on a text layer names the layer, the failing segment, and lists children.
3. An out-of-range `layerIndex` lists the valid range and the layer names.
4. `ae_apply_effect({ matchName: "ADBE Gausian Blur 2" })` suggests `ADBE Gaussian Blur 2`.
5. Existing tests for the old message format are updated, not deleted.
6. Round-trip test in `server.test.ts` with the fake panel returning `{ ok:false, error:{ message, line } }`.

## Definition of done
See `00_PREAMBLE.md`. Shared core (`tools/result.ts`, `bridge/`) is touched, so call it out in the PR for the architect.
