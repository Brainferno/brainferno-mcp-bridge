---
id: PS-02
app: photoshop
title: Adjustment layers, fill layers, shape layers, gradient fill
priority: P2
status: open
evidence: unverified
depends_on: []
---

# PS-02 — Adjustment layers, fill layers, and vector shape layers

> **UNVERIFIED — verify against current behavior before building.** Derived from the tool inventory in `packages/server/src/tools/photoshop.ts` and `docs/BUILD_PLAN.md:119` ("Remaining … adjustment layers"). Confirm on a real Photoshop first.

## Problem
A client cannot do non-destructive tonal or color work, create solid/gradient fill layers, or draw vector shapes.
- No adjustment layers (levels, curves, hue/saturation, …).
- `ps_fill` fills pixels with a **solid color only** (`color`, optional bounds, optional `layerId`); no gradient or pattern.
- `ps_create_layer` makes `pixel` or `group` layers; there are no shape or fill layers.
- `ps_apply_filter` supports only `gaussianBlur`, `motionBlur`, and `unsharpMask`.
- Existing layer styles (`ps_set_layer_style`) cover drop shadow, glows, bevel, satin, color and gradient overlay, and stroke, so effects on shape layers can reuse them.

## Add
- **`ps_create_adjustment_layer`** — `type`: `brightnessContrast | levels | curves | hueSaturation | colorBalance | blackAndWhite | photoFilter | exposure | vibrance | gradientMap | invert | threshold | posterize`; per-type params as optional fields with defaults (for example `hueSaturation`: `hue`, `saturation`, `lightness`; `levels`: `inputBlack`, `inputWhite`, `gamma`, `outputBlack`, `outputWhite`); `clipToLayerId` (optional), `name`.
- **`ps_set_adjustment`** — `layerId` plus the same per-type fields, to edit an existing adjustment.
- **`ps_create_fill_layer`** — `type`: `solid | gradient | pattern`; `color`; gradient `{ type: linear|radial|angle, stops: [{ position, color }], angle }`; `name`.
- **`ps_create_shape_layer`** — `kind`: `rect | ellipse | polygon | line`; `x, y, width, height`, `cornerRadius`, `sides`; `fill`, `stroke`, `strokeWidth`; `name`.
- Add `gradient` and `pattern` options to `ps_fill`.
- Extend `ps_apply_filter` with a few common filters (`sharpen`, `noise`, `lensBlur`, `levels` is *not* a filter — keep it as an adjustment) only if the descriptors are stable.

## API hints (UXP)
- `core.executeAsModal` + `batchPlay`.
- Adjustment layer: `{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }], using: { _obj: "adjustmentLayer", type: { _obj: "hueSaturation", ... } } }` (type object differs per adjustment; capture descriptors from a recorded action with the Alchemist plugin or the UXP debugger).
- Fill layer: `make` with `contentLayer` and `type: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red, grain, blue } }`; gradient: `gradientLayer`.
- Shape: `make` with `contentLayer` and a `rectangle` / `ellipse` shape `using`.

## Acceptance tests
1. `ps_create_adjustment_layer({ type: "hueSaturation", saturation: -100 })` desaturates the layers below (compare `ps_get_preview` before and after).
2. `ps_set_adjustment` changes the saturation in place; no new layer.
3. `ps_create_fill_layer({ type: "gradient", ... })` shows the gradient.
4. A shape layer with `cornerRadius` and `stroke` previews correctly; `ps_set_layer_style` works on it.
5. Not-connected-path test and round-trip test per tool.

## Definition of done
See `00_PREAMBLE.md`.
