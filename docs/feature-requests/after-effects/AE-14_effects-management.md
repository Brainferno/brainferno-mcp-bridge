---
id: AE-14
app: after-effects
title: Effects management — list available, remove, reorder, enable, params with values
priority: P3
status: open
evidence: verified
depends_on: [AE-05]
---

# AE-14 — Effects management

## Problem
`ae_apply_effect` and `ae_set_effect_param` exist, but the rest of the lifecycle does not.
- **No list of available effects.** A client must know match names (`ADBE Gaussian Blur 2`, `ADBE Fill`, `ADBE Slider Control`). A wrong name fails with no suggestions.
- **No remove, reorder, or enable/disable** for an effect already on a layer.
- **`ae_get_layer` lists effects without parameters** (`after-effects.ts:168-169`: `{ index, name, matchName, enabled }`). Parameter names and match names are returned only once, by `ae_apply_effect`; a client that lost that response cannot recover them.

## Add
- **`ae_list_available_effects`** — `query` (optional substring), `category` (optional), `limit` (default 50). Returns `[{ displayName, matchName, category }]`. `readOnlyHint: true`.
- **`ae_get_effect_params`** — layer args, `effect` (name, match name, or index). Returns every parameter `{ index, name, matchName, valueType, value, hasExpression, numKeys }`.
- **`ae_remove_effect`** — layer args, `effect`. `destructiveHint: true`.
- **`ae_set_effect_enabled`** — layer args, `effect`, `enabled`.
- **`ae_move_effect`** — layer args, `effect`, `toIndex`.
- `ae_apply_effect`: on an unknown `matchName`, throw with up to 5 close matches (`did you mean`; see `AE-16`).

## API hints (ES3)
- `app.effects` — array of `{ displayName, matchName, category, version }` for every installed effect.
- `layer.property("ADBE Effect Parade")`: `numProperties`, `property(i)`, `.name`, `.matchName`, `.enabled`, `.remove()`, `.moveTo(index)`.
- Parameters: iterate `effect.numProperties`; skip `ADBE Effect Built In Params` or label it.
- Renaming an effect (`effect.name = ...`) is how the existing tool lets sliders be addressed by name.

## Acceptance tests
1. `ae_list_available_effects({ query: "blur" })` returns match names including `ADBE Gaussian Blur 2`.
2. Apply two effects; `ae_move_effect` swaps their order; `ae_get_layer` reflects it.
3. `ae_get_effect_params` on a Fill effect returns the Color parameter with `matchName: "ADBE Fill-0002"`.
4. `ae_remove_effect` removes it; one Ctrl-Z restores it.
5. `ae_apply_effect({ matchName: "ADBE Gausian Blur 2" })` returns a "did you mean" error.
6. ES3 check; `__undo(` check on every mutating tool.

## Definition of done
See `00_PREAMBLE.md`.
