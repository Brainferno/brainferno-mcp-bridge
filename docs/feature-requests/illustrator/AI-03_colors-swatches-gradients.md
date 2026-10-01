---
id: AI-03
app: illustrator
title: Swatches, CMYK and spot colors, gradients
priority: P2
status: open
evidence: unverified
depends_on: [AI-02]
---

# AI-03 — Colors, swatches, and gradients

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/illustrator.ts:40` (only `RGBColor` from hex is used). Confirm on a real Illustrator first.

## Problem
Every color the typed tools accept is a hex RGB value.
- No **CMYK**, **spot**, or **global** colors, so print work cannot be specified correctly.
- No **swatches**: a client cannot list, create, or apply the document's swatches.
- No **gradients**: fills and strokes are solid only.
- `ai_create_document` can set `colorMode` (`rgb | cmyk`), but a CMYK document still receives RGB hex fills.

## Add
- A shared color input accepted by `fill` / `stroke` on `ai_create_shape`, `ai_create_text`, and `ai_set_item_props` (see `AI-02`): either a hex string, or `{ space: "rgb"|"cmyk"|"gray"|"spot"|"swatch"|"gradient", ... }` — `cmyk`: `c,m,y,k` (0-100); `spot`: `name`, `tint`; `swatch`: `name`; `gradient`: `{ type: "linear"|"radial", stops: [{ position, color, midpoint? }], angle?, origin?, length? }`.
- **`ai_list_swatches`** — `kind?` (`color|gradient|pattern|spot`). `readOnlyHint: true`.
- **`ai_create_swatch`** — `name`, color spec, `global` (default `false`), `spot` (default `false`).
- **`ai_delete_swatch`** (`destructiveHint: true`).
- **`ai_apply_color`** — `itemIds`, `target` (`fill|stroke|both`), color spec.
- **`ai_set_document_color_mode`** — `rgb|cmyk` (`destructiveHint: true`; converts).

## API hints (ES3)
- `RGBColor`, `CMYKColor`, `GrayColor`, `SpotColor` (with `Spot` and `tint`), `GradientColor` (with `Gradient`, `GradientStop`, `gradient.type`), `NoColor`.
- `doc.swatches.add()`, `swatch.color`, `swatch.name`; `doc.spots.add()`; `doc.gradients.add()` then `gradient.gradientStops.add()` and set `rampPoint`, `midPoint`, `color`.
- `pageItem.fillColor = color`; gradient angle and origin via `GradientColor.angle`, `origin`, `length`.
- Document color space: `app.executeMenuCommand("doc-color-cmyk")` / `"doc-color-rgb"` — verify against the target version.

## Acceptance tests
1. Create a shape with `fill: { space: "cmyk", c: 100, m: 0, y: 0, k: 0 }` in a CMYK document; read the color back.
2. `ai_create_swatch` then `ai_list_swatches` returns it; `ai_apply_color({ swatch })` uses it.
3. A linear gradient with three stops previews as a gradient.
4. A spot color keeps its name and tint.
5. ES3 check; not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`.
