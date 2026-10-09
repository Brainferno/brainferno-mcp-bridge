---
id: AI-01
app: illustrator
title: Bezier and multi-point paths, pathfinder, outline text, offset path
priority: P1
status: open
evidence: unverified
depends_on: []
---

# AI-01 — Paths and path operations

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/illustrator.ts` (the typed `ai_*` tools use fixed templates over the os-script lane, `drivers/osscript.ts`) and `docs/BUILD_PLAN.md:66,121`. Confirm on a real Illustrator first.

## Problem
Illustrator tools can make only simple primitives.
- `ai_create_shape` supports `kind`: `rect | ellipse | line | polygon | star`; `line` is exactly two points (`illustrator.ts:126`). There is no bezier or multi-point path with handles.
- No boolean (pathfinder) operations, no outline text, no offset path.
- Adobe's delegated tools (`ai_beta_*`) need the beta key and Illustrator Beta, and "still cannot draw new shapes/paths/text or save a `.ai`" (`docs/BUILD_PLAN.md:66`), so they do not fill this gap.

## Add
- **`ai_create_path`** — `points`: `[{ x, y, inHandle?: [x,y], outHandle?: [x,y], smooth?: boolean }]` (artboard-relative, y-down, like the other tools), `closed` (default `false`), `fill`, `stroke`, `strokeWidth`, `name`. Returns the item id.
- **`ai_pathfinder`** — `itemIds` (2+), `operation`: `unite | minusFront | intersect | exclude | divide | trim | merge`, `expand` (default `true`). Returns the resulting item id(s).
- **`ai_outline_text`** — `itemId` (a text frame), returns the outlined group id. Mutates; the original text is replaced unless `keepOriginal`.
- **`ai_offset_path`** — `itemId`, `offset` (pt), `joins` (`miter|round|bevel`), `miterLimit`.
- All take `documentId` (optional; default active) once `AI-02` lands.

## API hints (ES3 over the os-script lane)
- Scripts are **one IIFE expression**; helper functions go inside it. Coordinates in the tool API are artboard-relative, y-down (see `CONTRIBUTING.md`); convert to Illustrator's document coordinates inside the script.
- Path: `doc.pathItems.add()`; `path.setEntirePath([[x,y],...])` for polylines; for handles use `path.pathPoints.add()` and set `anchor`, `leftDirection`, `rightDirection`, `pointType`; `path.closed = true`.
- Pathfinder: group the items, then `app.executeMenuCommand("Live Pathfinder Add")` (and `Subtract`, `Intersect`, `Exclude`), followed by `app.executeMenuCommand("expandStyle")`; verify the exact menu strings in the target version.
- Outline text: `textFrame.createOutline()` (returns a GroupItem).
- Offset path: verify whether a scripting call exists; otherwise drive the menu command and document the behavior.

## Acceptance tests
1. `ai_create_path` with 4 points and handles previews as a smooth closed shape (`ai_get_preview`).
2. Two overlapping rectangles → `ai_pathfinder({ operation: "unite" })` returns one path whose bounds equal the union.
3. `ai_outline_text` turns a text frame into paths (no text frame left).
4. `ai_offset_path({ offset: 5 })` grows the bounds by 5 pt on each side.
5. ES3 check (the Illustrator builders' `SAMPLES` in `illustrator-tools.test.ts` pass `es3Violations` from `packages/server/test/es3.ts`); not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`.
