---
id: PS-04
app: photoshop
title: Edit existing text, paragraph text, font list, document switching, export options
priority: P2
status: open
evidence: unverified
depends_on: []
---

# PS-04 — Text editing, font list, documents, and export options

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/photoshop.ts` and its panel commands. Confirm each gap on a real Photoshop first.

## Problem
- **Text.** `ps_create_text_layer` makes **point text only** (`text`, `x`, `y`, `fontSize`, `font`, `color`, `name`). No tool edits the text, font, size, color, tracking, leading, or alignment of an **existing** text layer, and there is no paragraph (box) text. No tool lists installed fonts, so the `font` value must be guessed.
- **Documents.** `ps_list_layers` accepts a `documentId`, but no other tool does, and nothing activates or closes a document. A client working with two open documents cannot target the second one.
- **Export.** `ps_export` writes `png` or `jpg` only; `ps_save_document` saves `.psd` only. No other formats, no per-layer or per-artboard export, no save-as-copy options.

## Add
- **`ps_set_text_layer`** — `layerId`, then any of `text`, `font`, `fontSize`, `color`, `tracking`, `leading`, `justification`, `fauxBold`, `fauxItalic`, `allCaps`, `boxSize` (`[w,h]` to switch to paragraph text), `warp` (optional).
- **Extend `ps_create_text_layer`** with `boxSize` (paragraph text) and `justification`.
- **`ps_list_fonts`** — `query` (optional), `limit` (default 50). Returns `[{ postScriptName, family, style }]`. `readOnlyHint: true`.
- **`ps_activate_document`** — `documentId`; **`ps_close_document`** — `documentId`, `save` (`"yes"|"no"`, required; `destructiveHint: true`).
- Add an optional `documentId` to **every** document-scoped tool (default: active document), so a client can target any open document.
- **`ps_export`** — add `format` values `psd | tiff | gif | webp | svg` where Photoshop supports them, plus `scalePercent` and `transparency`. **`ps_export_layers`** — export each layer (or each artboard) to files with a name template. **`ps_save_as`** — `psb | tiff | png | jpg` as a copy.

## API hints (UXP)
- Text: `layer.textItem.contents`, `.characterStyle.font`, `.size`, `.color`, `.tracking`, `.leading`, `.paragraphStyle.justification`; paragraph text via `textItem.textClickPoint`/box via `batchPlay` `make`/`set` with `boxBounds`.
- Fonts: `require("photoshop").app.fonts` (check availability in your UXP/Photoshop version).
- Documents: `app.documents`, `doc.activate()` equivalent via `app.activeDocument = doc` (or `batchPlay` `select`), `doc.close(SaveOptions.DONOTSAVECHANGES)`.
- Export: `doc.saveAs.png(file, options)`, `.jpg`, `.tiff`, `.psb` via `saveAs`; per-layer export through `layer.duplicate()` into a new document, or `batchPlay` `exportSelectionAsFileTypePressed`.
- All mutations inside `executeAsModal`.

## Acceptance tests
1. Create a text layer, then `ps_set_text_layer` changes the text and size without changing its `layerId`.
2. `ps_list_fonts({ query: "mono" })` returns names accepted by `ps_create_text_layer`.
3. With two documents open, `ps_activate_document` then `ps_list_layers` returns the second document's layers; `documentId` on `ps_fill` targets it.
4. `ps_export({ format: "tiff" })` writes a TIFF; `ps_export_layers` writes one file per layer.
5. `ps_close_document` refuses without an explicit `save`.
6. Not-connected-path test and round-trip test per tool.

## Definition of done
See `00_PREAMBLE.md`.
