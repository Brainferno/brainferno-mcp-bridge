---
id: AE-07
app: after-effects
title: Expression diagnostics — runtime errors, ae_eval_expression, ae_find_expression_errors
priority: P1
status: open
evidence: verified
depends_on: [AE-05]
---

# AE-07 — Expression diagnostics

## Problem
`ae_set_expression` checks `prop.expressionError` once, immediately after assignment (`after-effects.ts:561`). If it is set, the tool restores the previous expression and throws `Expression error: …` (`:562-564`). That catches compile errors only.
- **Runtime errors are never reported.** An expression that references a layer, effect, or comp that does not exist yet (or is renamed later) is accepted; the tool returns `enabled: true` (`:566`). The error appears only when the property is evaluated, often at render time.
- `expressionError` is not refreshed until the property is evaluated, so the single early read can be stale.
- `ae_get_layer` (`:166`) and `ae_get_keyframes` (`:534`) return the expression text, or `null` when disabled, and never the error.
- A client building expression-driven layouts had no way to ask "which expressions in this project are broken?" and learned about failures only from a rendered preview.

## Add
- **Force an evaluation before reading the error** in `ae_set_expression`: call `prop.valueAtTime(comp.time, false)` (and optionally at the middle and end of the comp), then read `expressionError`. Return `{ property, expression, enabled, error: string|null, evaluatedValue }`. Add `failOnRuntimeError` (default `false`; when `true`, restore the old expression and throw).
- **`ae_find_expression_errors`** — `compId|compName` (optional; default all comps), `includeDisabled` (default `true`). Walks every layer and property; returns `[{ comp, layer, propertyPath, expression, error, enabled }]` for properties with `expressionError !== ""` or `expressionEnabled === false` with a non-empty expression. `readOnlyHint: true`. `timeoutClass: "slow"`.
- **`ae_eval_expression`** — layer args, `expression`, `time` (default 0). Evaluates an expression in the context of a layer **without leaving residue**: add a temporary Slider Control effect to the layer, assign the expression, read `valueAtTime(time,false)` and `expressionError`, then remove the effect, all inside one undo group that is cleaned up. Returns `{ value, error }`.
- Surface `expressionError` in `ae_get_layer` (`transform.*`) and `ae_get_keyframes` output.

## API hints (ES3)
- `prop.expression`, `prop.expressionEnabled`, `prop.expressionError`, `prop.canSetExpression`, `prop.valueAtTime(t, preExpression)`.
- Temporary effect: `layer.property("ADBE Effect Parade").addProperty("ADBE Slider Control")`; remove with `effect.remove()`.
- Expressions that reference other comps read the **current time** of the referencing layer; evaluate at a time where the referenced property has settled.

## Acceptance tests
1. Set an expression referencing `thisComp.layer("Missing")`: the response has `error` set (not just `enabled: true`).
2. `ae_find_expression_errors` returns that property with its path and message; after fixing it, the list is empty.
3. `ae_eval_expression({ expression: "time*2", time: 3 })` returns `6`, and leaves no extra effect on the layer.
4. `failOnRuntimeError: true` restores the previous expression.
5. ES3 check; `__undo(` check.

## Definition of done
See `00_PREAMBLE.md`.
