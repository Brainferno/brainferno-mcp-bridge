---
id: AI-04
app: illustrator
title: Text formatting, place and link images, PDF / EPS and multi-artboard export
priority: P2
status: open
evidence: unverified
depends_on: [AI-02]
---

# AI-04 — Text style, placed images, and export options

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/illustrator.ts` (`ai_create_text`, `ai_export_artboard`, `ai_save_document`). Confirm on a real Illustrator first.

## Problem
- **Text.** `ai_create_text` takes `text, x, y, fontSize, font, fill, width, height, name` only. No tracking, leading, alignment, paragraph spacing, or editing of an **existing** text frame, and no way to list installed fonts.
- **Images.** No way to place or link a raster or vector image into the document.
- **Export.** `ai_export_artboard` writes `png | jpg | svg` of the **active artboard** only (`format`, `path`, `scalePercent`). No PDF or EPS, no "all artboards", no export options (resolution, transparency, text-as-outlines). `ai_save_document` saves `.ai` only.

## Add
- **`ai_set_text_style`** — `itemId` (text frame or a character range via `start`/`end`), any of `text`, `font`, `fontSize`, `tracking`, `leading`, `alignment` (`left|center|right|justify`), `spaceBefore`, `spaceAfter`, `fill`, `allCaps`, `underline`. Extend `ai_create_text` with `tracking`, `leading`, `alignment`, and area text (`width`/`height` as a box).
- **`ai_list_fonts`** — `query?`, `limit` (default 50); returns `[{ name, family, style }]`. `readOnlyHint: true`.
- **`ai_place_image`** — `path`, `x`, `y`, `width?`, `height?`, `link` (default `true`; `false` embeds), `name`.
- **`ai_export`** — `format`: `png | jpg | svg | pdf | eps`, `path`, `artboards`: `active` (default) | `all` | `range` (`"1-3"`), `scalePercent`, `transparency`, `resolution`, `textAsOutlines`, `embedFonts`. Multiple artboards write numbered files. Keep `ai_export_artboard` as an alias.
- **`ai_save_as`** — `format`: `ai | pdf | eps | svg`, `path`, `saveMultipleArtboards`, `artboardRange`, `compatibility`.

## API hints (ES3)
- Text: `textFrame.textRange.characterAttributes` (`size`, `textFont`, `tracking`, `leading`, `fillColor`, `capitalization`, `underline`); `textFrame.textRange.paragraphAttributes` (`justification`, `spaceBefore`, `spaceAfter`); area text via `doc.textFrames.areaText(path)`; fonts from `app.textFonts` (`name`, `family`, `style`).
- Place: `var p = doc.placedItems.add(); p.file = File(path); p.embed()` (to embed); set `position` and size.
- Export: `doc.exportFile(File(path), ExportType.PNG24 | JPEG | SVG, options)`; PDF and EPS through `doc.saveAs(File(path), new PDFSaveOptions())` / `new EPSSaveOptions()`; multi-artboard via `options.saveMultipleArtboards` and `options.artboardRange`.
- Preview each export with `ai_get_preview` where possible.

## Acceptance tests
1. `ai_create_text` with `tracking: 100` and `alignment: "center"` previews with wider spacing and centered.
2. `ai_set_text_style` changes the font size of one word in a frame without touching the rest.
3. `ai_list_fonts` returns names accepted by `ai_create_text`.
4. `ai_place_image` of a PNG places it; `link: false` embeds it (file size grows).
5. `ai_export({ format: "pdf", artboards: "all" })` produces a multi-page PDF; `png` + `all` produces numbered files.
6. ES3 check; not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`.
