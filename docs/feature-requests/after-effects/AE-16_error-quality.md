---
id: AE-16
app: after-effects
title: Error quality — corrected line numbers, tool name and path context, "did you mean"
priority: P2
status: in-review
evidence: verified
depends_on: []
---

# AE-16 — Error quality

## Problem
Script failures are hard to act on.
- **Line numbers do not map to the tool body.** Every After Effects tool script is wrapped by `wrap()` (`after-effects.ts`) with the `HELPERS` prelude. The prelude's size is derived, never typed: `AE_PRELUDE_LINES` (which since AE-16 includes a 100-line host-line guard, `HOST_LINE_GUARD`). Nothing corrected for this offset. Of the observed errors `Script failed in after_effects (line 20)`, `(line 40)`, `(line 90)`: `20` was `__prop`'s throw inside HELPERS, `40` was host.jsx's own serializer (`__acmJson`, host.jsx:40, a host object in the result), and `90` was a body line. (`guard()` formats the message in `tools/result.ts`; the raw `e.line` travels `host.jsx:55` → `main.js:90` → `socket.ts` `settle()` → `ScriptError`.) After Effects reports lines relative to the innermost eval'd source, including for multi-line scripts and SyntaxErrors (verified live on 26.5 during X-01 — see `docs/spikes/06-aftereffects-tools-live.md`), so subtracting the `wrap()` prelude gives the body line.
- **No tool name or arguments** appear in the message, so a client running several calls at once cannot tell which one failed.
- **Property-path errors give no context.** `Property path not found at ADBE Text Properties` does not say which layer was addressed, what kind of layer it was (the real cause was a layer index that now pointed at a shape layer), or what children exist at that point.
- **Bad names fail without suggestions**: effect match names, property match names. (Fonts do not fail — they fall back silently; font suggestions are AE-04's and reuse `tools/suggest.ts`.)
- The panel's wire `code` is dropped by `socket.ts` `settle()`, so a panel older than the server (`UNKNOWN_COMMAND`) reads as "Script failed".

## Add
1. **Correct the line number.** The enrichment runs in `evaluateAe()` (`after-effects.ts`), where the generated script and the call context are both in reach — not in `EvalOptions` or `guard()`. Report `bodyLine` with the first body statement = body line 1; keep the raw line as `scriptLine`. A line inside a shared helper names the helper (`in helper __prop`) and has no body line. A line in the host-line guard, on line 1 or past the body (host.jsx's serializer) reads as "outside this tool's own code". Include a 3-line excerpt of the body around the failure with a `>>>` marker.
2. **Add context to every `ScriptError`**: tool name, and the **validated** arguments echoed (the SDK strips unknown keys before the callback; a raw echo would need a CallTool handler override). Long strings truncated at 80 chars; never echo anything that looks like a token or key.
3. **Property-path failures** (`__prop` in `HELPERS`): say `layer "<name>" (kind text) → ["ADBE Text Properties", ...]: segment "X" not found; children here: [...]`. Return the resolved prefix, the failing segment, and up to 10 child match names. (As built: up to 20 children at the top of a layer and 10 below, named in the vocabulary of the segment the caller passed — match names for an `ADBE …` segment, display names otherwise — and always by name for shape groups, masks, effects and text animators, whose match names repeat. A group that exists only on another kind of layer says so instead of listing children; an empty Effect or Mask Parade names the tool that fills it.)
4. **Lookup failures** (`__comp`, `__layer`): list valid indexes or names (cap at 20) and the layer kind you did find. (As built: each layer as `3 "Logo" (shape)`; an empty project or comp says how to make one.)
   Every candidate list is cut by length as well as by count (`__list`, `__BUDGET`), so the "what to do next" clause after the dash always survives.
5. **"Did you mean"**: a small Levenshtein helper (server side, `tools/suggest.ts`): effect names through the per-session `app.effects` catalog (refreshed when the panel reconnects); property, effect and parameter names from the list the host message carries. Return the 3 closest, case-folded, within a threshold of max(2, 30 % of the name without its vendor prefix (`ADBE `, `CC `…)).
6. Keep the plain-message contract (no `SCRIPT_ERROR` prefix — `CONTRIBUTING.md` Errors). Carry the wire code on `ScriptError.details.code`; `UNKNOWN_COMMAND` reads as "the panel is older than this server — update or reload it".
7. Keep messages one paragraph; keep "what happened — what to do next".

## API hints
- Server side only except for step 3/4 (small additions to `HELPERS`, ES3).
- `ScriptError` takes an optional 4th argument `details` (`code`, `where`, `bodyLine`, `helper`, `excerpt`, `tool`, `args`, `suggestions`, `note`, `next`); `message` never changes.
- A test script can throw at a known body line and assert the corrected number.

## Acceptance tests
1. A tool whose body throws at its 3rd statement reports `bodyLine` equal to that statement's line **in the body**, not offset by the prelude (`AE_PRELUDE_LINES`).
2. A wrong property path on a text layer names the layer, the failing segment, and lists children.
3. An out-of-range `layerIndex` lists the valid range and the layer names.
4. `ae_apply_effect({ matchName: "ADBE Gausian Blur 2" })` suggests `ADBE Gaussian Blur 2`.
5. Existing tests for the old message format are updated, not deleted.
6. Round-trip test in `server.test.ts` with the fake panel returning `{ type: "result", id, ok: false, error: { code: "HOST_ERROR", message, line } }` (a frame without `code` is dropped by the protocol parser and the call times out).

## Definition of done
See `00_PREAMBLE.md`. Shared core (`tools/result.ts`, `bridge/`, `server.ts`; also `src/jobs.ts`) is touched, so call it out in the PR for the architect, including the three texts that change for every app, not only After Effects: a panel's `UNKNOWN_COMMAND`, and a panel that dropped mid-call (`AppDisconnectedError`) both in `guard()` and in a failed job step (`jobErrorMessage`). Live verification on After Effects 26.5 is still pending (`docs/spikes/06-aftereffects-tools-live.md` lists what it must settle).
