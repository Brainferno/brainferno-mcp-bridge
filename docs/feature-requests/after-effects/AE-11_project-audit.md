---
id: AE-11
app: after-effects
title: Project audit — project tree, unused and missing items, project settings, new / close project
priority: P2
status: open
evidence: verified
depends_on: [AE-02, AE-04]
---

# AE-11 — Project audit

## Problem
- `ae_list_compositions` lists comps only, `ae_list_footage` lists footage only, and `ae_project_info` returns the path, item count, bit depth, and dirty flag (`after-effects.ts`). Nothing shows **folders**, which items are **used** by which comps, or which items are **unused**.
- No tool reports **missing** footage, fonts, or effects. Missing fonts surfaced only as a dialog the operator saw when reopening a project (see `AE-04`).
- No tool reads or sets project settings (color depth, linear blending, expression engine, time display).
- No tool creates or closes a project; `ae_open_project` replaces the current one.

## Add
- **`ae_get_project_tree`** — `depth` (default unlimited), `includeUnused` (default `true`). Returns a tree of `{ id, name, kind: "folder"|"comp"|"footage", parentFolderId, usedInCount, ... }`, with comp fields `{ width, height, duration, frameRate, numLayers }` and footage fields `{ path, missing, hasVideo, hasAudio }`. `readOnlyHint: true`.
- **`ae_list_unused_items`** — items with `usedIn.length === 0` (excluding the root folder and comps that are the top-level deliverables only if the caller passes `keepComps: [...]`).
- **`ae_list_missing`** — `kinds` (default `["footage","fonts","effects"]`). Footage: `footageMissing`; fonts: see `AE-04`; effects: layers whose effect match name is not installed.
- **`ae_get_project_settings` / `ae_set_project_settings`** — `bitsPerChannel`, `linearBlending`, `expressionEngine` (`"javascript"|"extendscript"`), `timeDisplayType`, `displayStartFrame`, read-only `gpuAccelType`.
- **`ae_new_project`** and **`ae_close_project`** (`saveChanges`: `"yes"|"no"|"prompt"`, default `"prompt"`; both `destructiveHint: true`). Refuse to close with unsaved changes unless `saveChanges` is explicit.

## API hints (ES3)
- Iterate `app.project.items` (1-based); `instanceof CompItem`, `FootageItem`, `FolderItem` (note: `instanceof TextLayer` is false in AE 26.3; for items `instanceof` is fine, but prefer `item.typeName` if it misbehaves).
- `item.usedIn` (array of `CompItem`); `item.parentFolder`; `footage.footageMissing`, `footage.missingFootagePath` (via `mainSource`).
- `app.project.bitsPerChannel`, `app.project.linearBlending`, `app.project.expressionEngine`, `app.project.timeDisplayType`, `app.project.gpuAccelType`.
- `app.newProject()`; `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES | SAVE_CHANGES | PROMPT_TO_SAVE_CHANGES)`.

## Acceptance tests
1. A project with a folder, two comps (one nested in the other) and one unused comp: `ae_get_project_tree` shows folder membership; the unused comp has `usedInCount: 0`; `ae_list_unused_items` returns it.
2. A footage item whose file was moved appears in `ae_list_missing`.
3. `ae_set_project_settings({ bitsPerChannel: 16 })` reads back.
4. `ae_close_project` with unsaved changes and default `saveChanges` does not silently discard.
5. ES3 check; `__undo(` check where applicable (project-level changes are not undoable; document that).

## Definition of done
See `00_PREAMBLE.md`.
