---
id: AE-08
app: after-effects
title: Shapes and masks — custom paths, groups, operators, gradients, edit after creation
priority: P2
status: open
evidence: verified
depends_on: [AE-05]
---

# AE-08 — Shape and mask authoring

## Problem
- `ae_add_shape` creates **one parametric shape per layer**: `kind` is `rectangle | ellipse | star | polygon` (`after-effects.ts:1160-1174`). No custom path, no second shape in the same layer, no gradients, trim paths, repeater, rounded-corner operator, or stroke options beyond width.
- `ae_add_mask` supports only `rectangle | ellipse`; the vertices are hard-coded (`:417-422`). It cannot make a polygon or bezier mask, and it cannot edit a mask afterwards.
- Shapes cannot be edited after creation. Changing a rectangle's size, roundness, or stroke needed a raw match-name path: `["ADBE Root Vectors Group","ADBE Vector Group","ADBE Vectors Group","ADBE Vector Shape - Rect","ADBE Vector Rect Size"]`.
- Observed workaround: a custom arrow was drawn by adding a solid, adding a rectangle mask, and replacing its Mask Path with an expression `createPath([...],[],[],true)`.

## Add
- **`ae_add_path`** — layer args (or `new: true` to create a shape layer), `target` (`"shape" | "mask"`), `vertices` (`[[x,y],…]`), `inTangents`, `outTangents` (optional, relative to vertices), `closed` (default `true`), plus fill/stroke options for `target: "shape"`, and `mode`, `feather`, `opacity`, `expansion`, `name` for `target: "mask"`.
- **`ae_set_shape_props`** — layer args, `group` (name or index, default first), then any of: `size`, `position`, `roundness`, `fill` (hex or null), `fillOpacity`, `stroke` (hex or null), `strokeWidth`, `strokeOpacity`, `lineCap`, `lineJoin`, `miterLimit`, `dashes` (array), `dashOffset`.
- **Shape operators**: `ae_add_shape_operator` — `group`, `operator` (`trim | repeater | roundCorners | offsetPaths | mergePaths | zigzag`), and per-operator params (for example trim `start`, `end`, `offset`; repeater `copies`, `offset`, position/rotation/scale of the transform).
- **Gradients**: `fill` / `stroke` accept `{ type: "linear"|"radial", colors: [{ offset, color }], angle?, start?, end? }` (map to `ADBE Vector Graphic - G-Fill` / `G-Stroke`).
- **Masks**: `ae_set_mask` (layer args, `mask` name or index, `mode`, `inverted`, `feather`, `opacity`, `expansion`, `vertices`…), `ae_list_masks`, `ae_remove_mask`. Allow keyframes on the mask path through `ae_set_keyframes` with `Shape` values (see `AE-05`).
- **`ae_create_shapes_from_text`** (optional): `layer.createShapesFromText`-style via the menu command, returning the new layer.

## API hints (ES3)
- `Shape` object: `vertices`, `inTangents`, `outTangents`, `closed`; set with `prop.setValue(shape)`. Tangents are relative to their vertex.
- Shape layer tree: `ADBE Root Vectors Group` → `ADBE Vector Group` → `ADBE Vectors Group` → items. Item match names: `ADBE Vector Shape - Rect`, `- Ellipse`, `- Star`, `- Group` (a free path), `ADBE Vector Graphic - Fill`, `- Stroke`, `- G-Fill`, `- G-Stroke`, `ADBE Vector Filter - Trim`, `- Repeater`, `- RC`, `- Offset`, `- Merge`, `- Zigzag`; dashes live under `ADBE Vector Stroke Dashes`.
- **Order matters**: a Fill or Stroke applies only to paths **above** it in the group, and a Stroke should sit above the Fill so the stroke's inner half is not covered. `propertyGroup.moveTo(index)` reorders; always re-fetch handles by match name after moving.
- Masks: `layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom")`; path `ADBE Mask Shape`; mode `maskMode`; `inverted`; `maskFeather`; `maskOpacity`; `maskExpansion`.

## Acceptance tests
1. `ae_add_path` with 7 vertices makes a closed arrow shape layer; render a frame and check ink bounds.
2. `ae_set_shape_props({ group: "Rect", size: [300,100], roundness: 8, stroke: "#cc7828", strokeWidth: 3 })` changes the existing shape; no new layer.
3. `ae_add_shape_operator` trim on a stroked path animates via `ae_set_keyframes`.
4. A gradient fill reads back with the same stops.
5. `ae_set_mask({ mode: "subtract", inverted: true })` round-trips through `ae_list_masks`.
6. ES3 check; `__undo(` check.

## Definition of done
See `00_PREAMBLE.md`. The repo's existing AE shapes and masks note should move into `docs/spikes/` (see `00_GLOBAL_PLAN.md`, G4).
