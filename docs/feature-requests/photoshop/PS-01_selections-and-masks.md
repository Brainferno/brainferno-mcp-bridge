---
id: PS-01
app: photoshop
title: Selections and layer / clipping masks
priority: P1
status: open
evidence: unverified
depends_on: []
---

# PS-01 — Selections and layer / clipping masks

> **UNVERIFIED — verify against current behavior before building.** This prompt comes from the tool inventory in `packages/server/src/tools/photoshop.ts`, `packages/panel-uxp/commands.js`, and `docs/BUILD_PLAN.md:119` ("Remaining … select/mask tools"), not from live use. Confirm the gap and the descriptors on a real Photoshop first.

## Problem
Photoshop has no selection or mask tools. The only selection use is internal to `ps_fill` (`commands.js:532`). Without selections and masks a client cannot cut out, isolate, or composite parts of an image; the only route is the gated `ps_batch_play`.
- Existing tools (21): documents (`ps_list_documents`, `ps_create_document`, `ps_open_document`, `ps_save_document`, `ps_export`), layers (`ps_list_layers`, `ps_create_layer`, `ps_create_text_layer`, `ps_set_layer_props`, `ps_move_layer`, `ps_duplicate_layer`, `ps_delete_layer`), styles (`ps_get_layer_styles`, `ps_set_layer_style`, `ps_remove_layer_style`), pixels (`ps_place_image`, `ps_fill`, `ps_apply_filter`, `ps_resize_image`, `ps_crop`), `ps_get_preview`.

## Add
- **`ps_select`** — `kind`: `all | none | inverse | rect | ellipse | colorRange | subject | layerTransparency | fromLayerMask`; `bounds` (`left, top, right, bottom` for rect/ellipse); `color` and `fuzziness` (colorRange); `feather` (px), `mode` (`new | add | subtract | intersect`), `layerId` (for layerTransparency). `timeoutClass: "slow"` for `subject`.
- **`ps_get_selection`** — returns `{ hasSelection, bounds }`. `readOnlyHint: true`.
- **`ps_add_layer_mask`** — `layerId`, `from`: `revealAll | hideAll | selection`.
- **`ps_set_layer_mask`** — `layerId`, `enabled`, `linked`, `invert`; **`ps_apply_layer_mask`** (applies and removes) and **`ps_delete_layer_mask`** (`destructiveHint: true`).
- **`ps_set_clipping_mask`** — `layerId`, `enabled` (clip to the layer below).
- Let `ps_fill` keep using the active selection (document it).

## API hints (UXP, modern JS)
- Run inside `core.executeAsModal(async () => { ... }, { commandName })`; use `require("photoshop").action.batchPlay`.
- Select all: `{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "allEnum" } }`; none: `_value: "none"`; rectangle: `to: { _obj: "rectangle", top: { _unit: "pixelsUnit", _value: ... }, ... }`; inverse: `{ _obj: "inverse" }`.
- Mask from selection: `{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }` (use `revealAll` / `hideAll` for the others).
- Clipping mask: `{ _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }`.
- Follow the named-command pattern: add `ps.select`, `ps.add_layer_mask`, … to `packages/panel-uxp/commands.js` (see `ps.fill` at ~532 and `ps.batch_play` at ~591), then register the tools in `photoshop.ts`.

## Acceptance tests
1. `ps_select({ kind: "rect", bounds })` → `ps_get_selection` returns those bounds; `ps_fill` fills only inside.
2. `ps_add_layer_mask({ from: "selection" })` hides everything outside the selection (check with `ps_get_preview`).
3. `invert`, `enabled: false`, apply, and delete behave as in the UI.
4. `ps_select({ kind: "subject" })` on a photo selects the subject (visual check).
5. Not-connected-path test and a round trip with the fake panel for each new tool (follow the existing Photoshop tests in `packages/server/test/`).

## Definition of done
See `00_PREAMBLE.md`. Live-verify by reloading the UXP panel in the UXP Developer Tool.
