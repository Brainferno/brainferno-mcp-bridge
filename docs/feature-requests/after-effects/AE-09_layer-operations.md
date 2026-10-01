---
id: AE-09
app: after-effects
title: Layer operations — reorder, blend mode, track matte, flags, precompose, copy, replace source, comp settings
priority: P2
status: open
evidence: verified
depends_on: [AE-03]
---

# AE-09 — Layer operations and comp settings

## Problem
- `ae_set_layer_props` can set only `name`, `enabled`, `startTime`, `inPoint`, `outPoint`, `position`, `scale`, `rotation` (Z), `opacity`, `anchorPoint`, `parentIndex` (`after-effects.ts:442-454`, `1245-1259`). No blend mode, track matte, shy, solo, guide, 3D, motion blur, adjustment flag, or label.
- `ae_set_comp_props` can set only `name`, `duration`, `frameRate`, `width`, `height` (`:259-265`, `1115-1122`). `pixelAspect` is create-time only; no background color, work area, display start time, or motion-blur settings.
- New layers always go to the **top** (`ae_add_layer`); a layer cannot be moved afterwards. Z-order can only be controlled by adding layers in reverse.
- No `precompose`, copy layers between comps, or replace a layer's source (a search for `precompose`, `copyToComp`, and `moveTo*` in the AE tool file finds nothing).

## Add
- **`ae_move_layer`** — layer args, then exactly one of `toIndex`, `beforeLayer`, `afterLayer`, `toTop`, `toBottom`. Returns the final index list.
- **Extend `ae_set_layer_props`** with `blendMode` (enum of the `BlendingMode` names), `trackMatte` (`{ layer: name|index, type: "alpha"|"alphaInverted"|"luma"|"lumaInverted"|"none" }`), `shy`, `solo`, `guide`, `threeD`, `motionBlur`, `adjustment`, `label` (0-16), `collapseTransformation`, `timeRemapEnabled`, `stretch`.
- **Extend `ae_set_comp_props`** with `bgColor` (hex), `pixelAspect`, `workAreaStart`, `workAreaDuration`, `displayStartTime`, `motionBlur`, `shutterAngle`, `shutterPhase`.
- **`ae_precompose`** — `compId|compName`, `layers` (names/indexes), `name`, `moveAllAttributes` (default `true`), `leaveInPlace` ignored when only one layer. Returns the new comp id and layer index.
- **`ae_copy_layers`** — `fromComp`, `layers`, `toComp`. Returns new indexes.
- **`ae_replace_layer_source`** — layer args, `itemId`, `fixExpressions` (default `false`).
- **`ae_add_layer`** gains `insertAt`/`aboveLayer`/`belowLayer` so z-order can be set at creation.

## API hints (ES3)
- `layer.moveBefore(other)`, `layer.moveAfter(other)`, `layer.moveToBeginning()`, `layer.moveToEnd()`.
- `layer.blendingMode = BlendingMode.<NAME>`; `layer.setTrackMatte(matteLayer, TrackMatteType.ALPHA)` (AE 23+; one matte layer can serve several layers); `layer.shy`, `layer.solo`, `layer.guideLayer`, `layer.threeDLayer`, `layer.motionBlur`, `layer.adjustmentLayer`, `layer.label`, `layer.collapseTransformation`.
- `comp.layers.precompose(indexArray, name, moveAllAttributes)`; `layer.copyToComp(intoComp)` (AE 22+); `layer.replaceSource(newSource, fixExpressions)`.
- `comp.bgColor`, `comp.pixelAspect`, `comp.workAreaStart`, `comp.workAreaDuration`, `comp.displayStartTime`, `comp.motionBlur`, `comp.shutterAngle`, `comp.shutterPhase`.
- After a precompose, layer indexes change; return fresh indexes (see `AE-03`).

## Acceptance tests
1. Add A, B, C; `ae_move_layer({ layerName: "A", toTop: true })` gives order A, C, B (top to bottom).
2. `blendMode: "multiply"` and `shy: true` read back via `ae_get_layer` (extend it, see `AE-05`).
3. A track matte on two layers shares one matte layer.
4. `ae_precompose` of two layers yields a precomp layer; the new comp holds both with their animation.
5. `ae_copy_layers` keeps keyframes and expressions.
6. `ae_set_comp_props({ bgColor: "#101010", workAreaDuration: 4 })` reads back.
7. ES3 check; `__undo(` check.

## Definition of done
See `00_PREAMBLE.md`.
