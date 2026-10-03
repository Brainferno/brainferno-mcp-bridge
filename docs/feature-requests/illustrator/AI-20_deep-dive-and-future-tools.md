---
id: AI-20
app: illustrator
title: Deep dive and future-tools brainstorm
priority: P3
status: open
evidence: unverified
depends_on: [AI-01, AI-02, AI-03, AI-04]
---

# AI-20 — Illustrator deep dive and future-tools brainstorm

> **UNVERIFIED — a planning prompt, not a build prompt.** This runs **after** the base
> Illustrator features (AI-01…AI-04) ship. It (1) maps the Illustrator ExtendScript object model
> and the Adobe Illustrator (Beta) MCP delegate to find what vector art and production work is
> still missing, and (2) brainstorms candidate tools. Each accepted idea becomes its own numbered
> prompt (`AI-21`, `AI-22`, …), verified live first.

## Why a deep dive
Illustrator is driven two ways here: our ES3 ExtendScript over the os-script lane (COM /
AppleScript) and the **delegate** `ai_beta_*` tools that proxy Adobe's own Illustrator (Beta) MCP
server. The delegate already arranges, restyles, analyzes, and exports; our tools create, draw,
and save. Before planning anything, map which side already covers a capability so we don't build a
duplicate of a delegate tool.

## Deep-dive method
1. **Dump both surfaces.** Our side: the Illustrator ExtendScript DOM for the installed version
   into `docs/api-dumps/illustrator-<version>.md`. Delegate side: run `ai_beta_list_tools` and save
   the list. (ES3 only on our side — `var`, no arrow/`JSON.`; os-script param marshaling.)
2. **Gap matrix** against the current 7 `ai_*` tools **and** the delegate list: *covered by ours*,
   *covered by delegate*, *gap — worth a typed tool*.
3. **Spike the risky ones** (Image Trace options, Recolor Artwork, mesh/3D) and note results in
   `docs/spikes/02-illustrator-osscript.md` or `12-illustrator-beta-sweep.md`.
4. **Prioritize** and **write one prompt file per accepted tool.**

## Brainstorm — candidate tools (grouped by goal)

### Vector art and construction (beyond AI-01 paths/pathfinder/outline)
- **`ai_image_trace`** — raster → vector with presets (sketch, logo, line art), then expand.
- **`ai_offset_path` / `ai_outline_stroke`** — grow/shrink a shape; turn a stroke into a fillable path.
- **`ai_blend`** — stepped/smooth blends between two objects (gradients of shape).
- **`ai_transform_each`** — per-object move/scale/rotate (scatter, grids).
- **`ai_align_distribute`** — align and distribute selected objects to artboard or selection.
- **`ai_envelope_distort` / `ai_warp`** — warp text/art to an arc, flag, or custom mesh.

### Color and appearance
- **`ai_recolor_artwork`** — recolor a whole illustration to a palette or brand colors in one call
  (may be delegate-covered — check first). High value for variations.
- **`ai_mesh_gradient`** — gradient mesh fills for soft shading.
- **`ai_graphic_style` / `ai_appearance`** — apply a named graphic style; add multiple fills/strokes/
  effects to one object. (Coordinate with **AI-03** swatches/gradients.)
- **`ai_apply_brush`** — art/pattern/bristle brushes along a path.

### Type (beyond AI-04)
- **`ai_type_on_path`** — set text along a path; **`ai_area_type`** — flow text into a shape.
- **`ai_create_paragraph_style` / `ai_create_character_style`** — reusable type styles.

### Production and export
- **`ai_export_for_screens`** — export every artboard at @1x/@2x/@3x to PNG/SVG/PDF in one call —
  the core asset-handoff workflow.
- **`ai_data_merge`** — bind variables + a dataset to a template and stamp out variations
  (localized labels, numbered tickets, name tags).
- **`ai_export_pdf_preset`** — press-ready PDF with marks, bleed, and a profile.
- **`ai_package`** — collect links and fonts for handoff.

## Overlap and constraints to resolve during the deep dive
- **Check the delegate first** for recolor / arrange / analyze / export — if `ai_beta_*` already
  does it well, document that instead of adding a thin ES3 duplicate.
- ES3 on our lane: no `const`/`let`/arrow/`JSON.`; one IIFE; os-script marshals params via files.
  Keep scripts small; heavy enumeration can be slow over COM.
- Coordinate with **AI-03** (color) and **AI-04** (type, place, export) so the deep-dive tools extend
  them rather than overlap.

## Output of this prompt
A gap matrix (ours vs delegate) in `docs/api-dumps/`, plus new numbered prompt files (`AI-21`+) for
accepted tools, each following `00_PREAMBLE.md`. No production code lands under this id itself.
