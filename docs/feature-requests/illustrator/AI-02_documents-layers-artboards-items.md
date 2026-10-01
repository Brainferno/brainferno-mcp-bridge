---
id: AI-02
app: illustrator
title: Open / close documents, layers, artboards, and editing existing items
priority: P1
status: open
evidence: unverified
depends_on: []
---

# AI-02 — Documents, layers, artboards, and existing items

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/illustrator.ts` and `docs/BUILD_PLAN.md:121` ("Remaining … artboards, edit/style existing items, group/transform, `ai_launch_app`"). Confirm on a real Illustrator first.

## Problem
The typed tools can create things but cannot work with what already exists.
- Documents: `ai_list_documents`, `ai_create_document`, `ai_save_document` (`.ai` only), `ai_export_artboard` exist. There is **no open, close, or activate**, so a client cannot work on an existing file or switch between two open files.
- **Layers**: no create, list, rename, show/hide, lock, or reorder.
- **Artboards**: no create, list, resize, or select; export is limited to the active artboard.
- **Existing items**: nothing lists items or returns ids for items it did not create, and nothing moves, scales, rotates, restyles, groups, arranges, or deletes them. Items can be addressed only if they were just created by the same call.
- Adobe's `ai_beta_*` tools cover some of this but need the beta key and Illustrator Beta (`docs/illustrator-beta.md:3,55`).

## Add
- **`ai_open_document`** (`path`), **`ai_close_document`** (`save`: `yes|no`, required; `destructiveHint: true`), **`ai_activate_document`** (`documentId`).
- **`ai_list_layers`**, **`ai_create_layer`** (`name`, `parentLayerId?`), **`ai_set_layer_props`** (`layerId`, `name`, `visible`, `locked`, `printable`, `opacity`, `color`), **`ai_reorder_layer`**, **`ai_delete_layer`** (`destructiveHint: true`).
- **`ai_list_artboards`**, **`ai_create_artboard`** (`x, y, width, height, name`), **`ai_set_artboard`** (`artboardId`, `name`, bounds), **`ai_delete_artboard`**.
- **`ai_list_items`** — `layerId?`, `type?` (`path|text|group|placed|compound`), `nameContains?`, `selectedOnly?`, `limit`. Returns `[{ id, name, type, bounds, layerId }]` with stable ids.
- **`ai_set_item_props`** — `itemId`, any of `x`, `y`, `width`, `height`, `rotate`, `scalePercent`, `fill`, `stroke`, `strokeWidth`, `opacity`, `name`, `locked`, `hidden`.
- **`ai_group_items`**, **`ai_ungroup`**, **`ai_arrange_item`** (`front|forward|backward|back`), **`ai_delete_items`** (`destructiveHint: true`).
- Add an optional `documentId` to every document-scoped tool (default: active document).

## API hints (ES3 over the os-script lane)
- `app.open(File(path))`, `app.documents`, `doc.close(SaveOptions.DONOTSAVECHANGES | SAVECHANGES)`, `app.activeDocument = doc`.
- `doc.layers.add()`, `layer.name`, `.visible`, `.locked`, `.printable`, `.opacity`, `.color`, `layer.zOrder(ZOrderMethod.*)`.
- `doc.artboards.add([left, top, right, bottom])`, `artboard.artboardRect`, `artboard.name`; Illustrator's native coordinates are y-up — convert from the tool API's artboard-relative y-down inside the script (note: the origin differs between documents, `docs/spikes/12-illustrator-beta-sweep.md:54`).
- Items: iterate `doc.pageItems` / `layer.pageItems`; ids are not native — keep a stable id by writing it into `item.note` or using `item.uuid` if available, and document the choice.
- `item.translate`, `.resize(scaleX, scaleY)`, `.rotate(angle)`, `doc.groupItems.add()` + `item.move(group, ElementPlacement.PLACEATEND)`, `item.zOrder(...)`, `item.remove()`.

## Acceptance tests
1. `ai_open_document` of a saved `.ai` appears in `ai_list_documents`; `ai_activate_document` switches; `ai_close_document` without `save` is refused.
2. Create two layers; `ai_set_layer_props({ visible: false })` hides one (preview).
3. `ai_create_artboard` adds an artboard; `ai_list_artboards` returns both.
4. `ai_list_items` returns ids for items in an existing file; `ai_set_item_props` moves one; ids remain stable across calls.
5. `ai_group_items` then `ai_ungroup` restores the original structure.
6. ES3 check; not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`.
