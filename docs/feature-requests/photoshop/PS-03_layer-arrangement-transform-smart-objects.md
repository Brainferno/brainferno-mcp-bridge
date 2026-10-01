---
id: PS-03
app: photoshop
title: Layer arrangement, transform, grouping, merge, and smart objects
priority: P2
status: open
evidence: unverified
depends_on: []
---

# PS-03 — Arrange, transform, group, merge, smart objects

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/photoshop.ts`, `packages/panel-uxp/commands.js:437`, and `docs/BUILD_PLAN.md:119` ("Remaining … reorder"). Confirm on a real Photoshop first.

## Problem
Layers can be created, duplicated, deleted, and nudged, but not arranged or transformed.
- `ps_move_layer` is **relative only** (`dx`, `dy`; `commands.js:437`). There is no way to put a layer at an absolute position.
- No scale, rotate, skew, flip, or free transform.
- No reorder (bring forward / send back / to index) and no reparenting into a group (`ps_create_layer` can make a group, but nothing moves layers into it).
- No merge down, merge visible, or flatten (`ps_resize_image` and `ps_crop` exist; flatten does not).
- `ps_place_image` places a **smart object**, but nothing can edit its contents, replace its contents, or convert an ordinary layer to a smart object or rasterize one.

## Add
- **Extend `ps_move_layer`** with `x`, `y` (absolute, document pixels) and `reference` (`"topLeft"` default | `"center"`), keeping `dx`/`dy`.
- **`ps_transform_layer`** — `layerId`, `scalePercent` or `scaleX`/`scaleY`, `rotateDegrees`, `skewX`/`skewY`, `flipHorizontal`, `flipVertical`, `anchor` (`"center"` default | `"topLeft"` …), `interpolation`.
- **`ps_reorder_layer`** — `layerId`, exactly one of `toTop`, `toBottom`, `toIndex`, `aboveLayerId`, `belowLayerId`.
- **`ps_group_layers`** — `layerIds`, `name`; **`ps_move_into_group`** — `layerId`, `groupId` (null = ungroup to root).
- **`ps_merge_layers`** — `mode`: `down | visible | selected`; **`ps_flatten_image`** (`destructiveHint: true`).
- **`ps_convert_to_smart_object`**, **`ps_rasterize_layer`**, **`ps_edit_smart_object_contents`** (opens the embedded document; returns its `documentId`), **`ps_replace_smart_object_contents`** (`layerId`, `path`).

## API hints (UXP)
- Move absolute: read layer bounds with `layer.bounds`, compute `dx/dy`, then `layer.translate(dx, dy)`; or `batchPlay` `move`/`transform`.
- Transform: `layer.scale(wPercent, hPercent, anchorPosition)`, `layer.rotate(angle, anchorPosition)`, `layer.skew(h, v)`, `layer.flip(direction)`.
- Reorder: `layer.move(relativeLayer, constants.ElementPlacement.PLACEBEFORE | PLACEAFTER | PLACEATBEGINNING | PLACEATEND)`.
- Group: `app.activeDocument.createLayerGroup({ name, fromLayers: [...] })`.
- Merge: `layer.merge()`; `doc.flatten()`.
- Smart objects: `layer.convertToSmartObject()`; `batchPlay` `placedLayerEditContents` and `placedLayerReplaceContents`.
- All mutations inside `executeAsModal`.

## Acceptance tests
1. `ps_move_layer({ x: 100, y: 50 })` puts the layer's top-left at (100, 50) regardless of its previous position.
2. `ps_transform_layer({ scalePercent: 50 })` halves the bounds around the center.
3. Reorder and group results match `ps_list_layers` order and nesting.
4. `ps_merge_layers({ mode: "down" })` reduces the layer count by one.
5. A placed image: `ps_replace_smart_object_contents` swaps the content, keeping position and size.
6. Not-connected-path test and round-trip test per tool.

## Definition of done
See `00_PREAMBLE.md`.
