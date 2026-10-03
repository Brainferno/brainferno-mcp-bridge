---
id: PS-20
app: photoshop
title: Deep dive and future-tools brainstorm
priority: P3
status: open
evidence: unverified
depends_on: [PS-01, PS-02, PS-03, PS-04]
---

# PS-20 — Photoshop deep dive and future-tools brainstorm

> **UNVERIFIED — a planning prompt, not a build prompt.** This runs **after** the base
> Photoshop features (PS-01…PS-04) ship. It does two jobs: (1) a systematic deep dive into
> Photoshop's scripting surface to find what is still missing, and (2) a brainstormed catalog
> of candidate tools for better production, art, and image editing. Nothing here is a final
> spec — each accepted idea becomes its own numbered prompt file (`PS-21`, `PS-22`, …) with
> real API hints and acceptance tests, verified live first.

## Why a deep dive
Photoshop reaches almost everything through `batchPlay` action descriptors, so the scriptable
surface is far larger than the typed tools expose. After PS-01…PS-04, map the whole surface
once, then decide what is worth a typed tool versus leaving to the gated `ps_batch_play`.

## Deep-dive method
1. **Record the surface.** With the ScriptListener plugin (or `ps_batch_play` + the Actions
   panel), record each candidate operation in the UI and capture the exact descriptor. Save the
   descriptors into `docs/api-dumps/photoshop-<version>.md` (descriptors only, never Adobe docs).
2. **Build a gap matrix.** List every UI capability area (below) against the current 21 tools.
   Mark each: *covered*, *gap — typed tool worth it*, or *leave to `ps_batch_play`*.
3. **Spike the risky ones.** Cloud features (Generative Fill/Expand, Neural Filters) and modal
   tools (Liquify, Vanishing Point) may not run headless — prove each in a spike before planning
   a tool; note the result in `docs/spikes/05-photoshop-tools-live.md`.
4. **Prioritize** P1/P2/P3 by production value, then **write one prompt file per accepted tool.**

## Brainstorm — candidate tools (grouped by goal)

### Art and image effects
- **`ps_adjustment_layer`** — add editable adjustment layers: levels, curves, brightness/contrast,
  hue/saturation, color balance, vibrance, photo filter, black & white, gradient map, exposure.
  (Extends PS-02; here as non-destructive, re-editable layers with a `ps_set_adjustment` setter.)
- **`ps_camera_raw_filter`** — apply Camera Raw as a smart filter: exposure, contrast, clarity,
  dehaze, texture, color grading, split toning. The single biggest "look" lever Photoshop has.
- **`ps_smart_filter`** — convert a layer to a smart object and apply a filter non-destructively,
  then toggle, re-order, or re-edit it (`ps_apply_filter` is destructive today).
- **`ps_blend_options`** — advanced blending: blend-if sliders, knockout, fill vs layer opacity.
- **`ps_content_aware_fill`** — fill the active selection content-aware (remove objects).
- **`ps_generative_fill` / `ps_generative_expand`** — Firefly fill/outpaint. **Spike first** —
  cloud, async, may need a round-trip that does not script cleanly.
- **`ps_liquify` / `ps_puppet_warp`** — mesh warps. Likely modal; spike.

### Compositing and transform
- **`ps_transform`** — scale / rotate / skew / distort / perspective / free-transform a layer or
  selection by numbers (today only `ps_move_layer` translates).
- **`ps_auto_align` / `ps_auto_blend`** — align and blend stacked layers (panorama, focus stack).
- **`ps_apply_image` / `ps_calculations`** — channel math for masks and composites.
- **`ps_rasterize` / `ps_merge` / `ps_flatten`** — housekeeping (merge-down, stamp-visible, flatten).

### Color and inspection
- **`ps_sample_color`** — read the pixel color at x/y (readOnly); **`ps_get_histogram`** — per-channel
  histogram stats for exposure/clipping checks (readOnly).
- **`ps_convert_mode` / `ps_assign_profile`** — color mode (RGB/CMYK/Gray) and ICC profile, for print.

### Production and batch
- **`ps_export_layers`** — export each layer / group / artboard to its own file (the "Export As"
  and generator web-assets workflow) — huge for handing art to other apps.
- **`ps_image_processor`** — batch-process a folder to PNG/JPG/PSD with resize and a quality preset,
  as a job (`runOrQueue`).
- **`ps_data_driven_graphics`** — bind variables + datasets to a template and stamp out variations
  (localized banners, name badges).
- **`ps_create_artboard` / `ps_arrange_artboards`** — artboard authoring for multi-size exports.

### Video / motion (Photoshop's own timeline)
- **`ps_frame_animation`** — build a frame animation from layers and **export an animated GIF or
  MP4** (`ps_export_animation`). This is the one place Photoshop produces video directly.

## Overlap to resolve during the deep dive
- `ps_adjustment_layer` overlaps **PS-02** (adjustment/fill/shape layers) — fold in, don't duplicate.
- Anything cloud or modal routes through a spike decision, not a tool, until proven headless.
- Where a capability is one descriptor and rarely used, leave it to the gated `ps_batch_play` and
  say so, rather than adding a thin tool.

## Output of this prompt
A short gap matrix committed to `docs/api-dumps/`, plus new numbered prompt files (`PS-21`+) for
the accepted tools, each following `00_PREAMBLE.md`. No production code lands under this id itself.
