---
id: AE-05
app: after-effects
title: Property tree, property value at a time, generic property setter; fix Source Text read error
priority: P1
status: open
evidence: verified
depends_on: []
---

# AE-05 — Property introspection and a generic setter

## Problem
1. **Property paths must be guessed.** The generic tools take a `propertyPath` of match names (for example `["ADBE Root Vectors Group","ADBE Vector Group","ADBE Vectors Group","ADBE Vector Shape - Rect","ADBE Vector Rect Size"]`, `["ADBE Effect Parade","Fill","ADBE Fill-0002"]`, `["ADBE Mask Parade","Mask 1","ADBE Mask Shape"]`). Nothing lists a layer's property tree. `ae_apply_effect` returns an effect's parameter match names once, but `ae_get_layer` lists effects **without parameters** (`after-effects.ts:168-169`).
2. **`ae_get_layer` is transform-only** (`after-effects.ts:162-167`): no masks, no shape contents, no layer styles, no blend mode, no 3D flag. For text it returns only the string (`:170`).
3. **No evaluated value at a time.** `ae_get_keyframes` returns `prop.value` (`:534`), not the value after expressions at a chosen time. A client that needed a measured width worked around it with an expression-linked slider and read its current value.
4. **No generic setter.** `ae_set_effect_param` handles effect parameters only. Colors on shape fills/strokes, mask mode/feather, booleans, and dropdown indexes need expressions or are unreachable.
5. **Bug — reading Source Text fails.** `ae_get_keyframes({ propertyPath: ["ADBE Text Properties","ADBE Text Document"] })` returns `After Effects error: Text document not of Box document type.` Likely cause (inference, not tested in the repo): `__acmJson` in `packages/panel-cep/host.jsx` (lines ~39-40) enumerates **every** field of the returned `TextDocument`, including `boxTextSize` and `boxTextPos`, which throw on point text. The throw happens during serialization and is caught at `host.jsx:54-55`, so the reported line is a `host.jsx` line, not the tool body.

## Add
- **`ae_get_property_tree`** — `compId|compName`, `layerIndex|layerName`, `path` (optional match-name path to start from; default layer root), `depth` (default 3), `includeValues` (default `false`). Returns nodes `{ name, matchName, propertyType, valueType, canSetExpression, hasExpression, expression, expressionError, numKeys, value? }`. `readOnlyHint: true`.
- **`ae_get_property_value`** — same layer args, `propertyPath`, `time` (default 0), `preExpression` (default `false`). Returns `{ value, hasExpression, expressionError }`. Serialize `TextDocument` (explicit fields, see `AE-04`), `Shape` (`vertices`, `inTangents`, `outTangents`, `closed`), `MarkerValue`, and colors.
- **`ae_set_property_value`** — layer args, `propertyPath`, `value`, `time` (optional: sets a keyframe when given). Value types: number, array, boolean, string, color `[r,g,b,a]` (0-1), `{ vertices, inTangents?, outTangents?, closed? }` for a `Shape`.
- **Fix the serializer.** In `__acmJson`, wrap each property read in `try/catch` and skip throwing getters, so one bad field never fails the whole call. In the tools, convert `TextDocument` to a plain object before returning.
- Extend `ae_get_layer` with `masks`, `blendMode`, `threeD`, and `effects[].params` (name, matchName, value) behind an `include` array (default keeps today's output).

## API hints (ES3)
- Walk a `PropertyGroup`: `numProperties`, `property(i)`, `.matchName`, `.name`, `.propertyType` (`PropertyType.PROPERTY | INDEXED_GROUP | NAMED_GROUP`), `.propertyValueType`, `.canSetExpression`, `.expression`, `.expressionError`, `.numKeys`.
- `prop.valueAtTime(t, preExpression)`.
- `Shape`: `vertices`, `inTangents`, `outTangents`, `closed`. Color properties are 4-element arrays.
- Effect parameter match names: `ADBE Slider Control-0001`, `ADBE Fill-0002` (Color), and so on; the tree tool removes the need to guess.

## Acceptance tests
1. `ae_get_property_tree` on a shape layer with a rectangle returns the match-name path to `ADBE Vector Rect Size`.
2. `ae_get_property_value` on an expression-driven slider at `time: 3` returns the evaluated number.
3. `ae_set_property_value` sets a fill color, a mask mode, and a checkbox.
4. **Regression:** `ae_get_keyframes` on `["ADBE Text Properties","ADBE Text Document"]` returns the text document fields instead of the error, for point text and for box text.
5. A deliberately throwing getter does not fail the whole result.
6. ES3 check; `__undo(` check on the setter.

## Definition of done
See `00_PREAMBLE.md`.
