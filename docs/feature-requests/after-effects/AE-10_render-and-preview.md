---
id: AE-10
app: after-effects
title: Render and preview — transparent background, alpha check, full-res file, batch frames, output modules
priority: P2
status: open
evidence: verified
depends_on: []
---

# AE-10 — Render and preview

## Problem
`ae_render_frame` takes only `compId`, `time` (default 0), and `maxDimension` (64-2048, default 1024) (`after-effects.ts:1526`). It builds a temporary downscaled comp, saves a PNG, and returns it as base64 plus a path.
- **No background control.** `renderFrameScript` (`:834-850`) never sets a background color. A comp with transparent areas appears on **white** in the returned image, so a client cannot tell "transparent" from "white" and cannot verify an alpha deliverable.
- The tool discards the rendered width/height (`:1534`).
- It is not wrapped in `__undo`, and it is limited to one frame per call: checking six moments of an animation takes six calls and six images.
- `saveFrameToPng` returns before the file exists, so the server polls (`waitForFile`, up to 20 s; see `docs/spikes/06-…`).
- `ae_render_comp` (aerender) accepts `renderSettings` and `outputModule` names but there is no way to list the available templates, so a client must guess names such as `H.264 - Match Render Settings`.

## Add
- **`ae_render_frame`** — add `background` (`"white"` default, `"black"`, `"checkerboard"`, `"transparent"`, or a hex color). For `"transparent"` return a PNG that keeps alpha. Return `width` and `height`. Add `alphaStats` (boolean, default `false`): compute server-side from the PNG `{ hasAlpha, minAlpha, maxAlpha, opaquePercent, bbox: [l,t,r,b] }`. (Pick a small, permissively licensed PNG decoder; check `THIRD_PARTY_NOTICES.md`.)
- **`ae_render_frames`** — `compId`, `times` (array, max 12), `maxDimension`, `layout` (`"separate"` default | `"contactSheet"`), `columns`. In contact-sheet mode stitch labeled frames into one image. Respect `BRAINFERNO_MCP_PREVIEW`.
- **`ae_render_frame_to_file`** — `compId`, `time`, `path` (must pass the existing path allow rules; `PATH_DENIED` otherwise), `width`/`height` (default comp size), `format` (`png`). Full resolution, alpha preserved.
- **`ae_list_render_templates`** — returns render-settings templates and output-module templates (name, format hint) so `ae_render_comp` can be called with valid names. `readOnlyHint: true`.
- Wrap the temp-comp work in `__undo` and delete the temp comp in a `finally`-style path even when saving fails.

## API hints (ES3)
- `comp.saveFrameToPng(time, fileObj)` — wait for the file; Photoshop-style alpha is kept in the PNG when the comp has no solid background layer.
- Background: set `tempComp.bgColor`; for a visible checkerboard, add two solids or a checkerboard effect layer under the comp.
- Templates: `app.project.renderQueue.items.add(comp)`; `item.outputModule(1).templates`; `item.templates` (render settings); remove the temp item afterwards.
- Frame time → file name must be unique per call to avoid collisions with parallel requests.

## Acceptance tests
1. A comp with a 200×100 opaque box on an otherwise empty (transparent) comp: `background: "transparent", alphaStats: true` → `opaquePercent` ≈ box area, `minAlpha: 0`, bbox matches the box.
2. Same comp with `background: "white"` returns an opaque image (today's behavior).
3. `ae_render_frames` with 4 times and `contactSheet` returns one image.
4. `ae_render_frame_to_file` writes a PNG of the full comp size.
5. `ae_list_render_templates` includes `Best Settings` and at least one output module; passing a returned name to `ae_render_comp` works.
6. Rendering a comp with a missing font does not hang (see `AE-01` on dialog suppression).
7. ES3 check; the temp comp is gone after each call.

## Definition of done
See `00_PREAMBLE.md`.
