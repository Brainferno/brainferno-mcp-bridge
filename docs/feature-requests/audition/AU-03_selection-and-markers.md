---
id: AU-03
app: audition
title: Selection ranges, clip selection, and marker list / edit / remove
priority: P2
status: open
evidence: unverified
depends_on: []
---

# AU-03 — Selection and markers

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/audition.ts` and `docs/spikes/08-audition-tools-live.md:42` (cue-marker duration reads back `null`). Probe with `au_api_dump` first.

## Problem
- **Selection.** Most Audition edits act on the current selection, but no tool reads or sets a time range, selects a clip, or sets the channel selection. Effects and cuts therefore apply to "whatever is selected", and a client cannot control that.
- **Markers.** `au_add_marker` (`seconds`, `durationSeconds`, `name`, `type`, `description`) is **add-only**. No list, edit, or remove. A client cannot correct a marker or clear its own markers; duplicates accumulate.
- A cue marker's duration reads back as `null` (`docs/spikes/08-…:42`), so round-tripping a range marker loses information.

## Add
- **`au_get_selection`** — returns `{ startSeconds, endSeconds, channels, selectedClipIds }`. `readOnlyHint: true`.
- **`au_set_selection`** — `startSeconds`, `endSeconds`, `channels` (optional: `left|right|both`), `clipIds` (optional).
- **`au_list_markers`** — returns `[{ id, name, startSeconds, durationSeconds|null, type, description }]`. `readOnlyHint: true`.
- **`au_update_marker`** — `markerId`, any of `name`, `startSeconds`, `durationSeconds`, `type`, `description`.
- **`au_remove_marker`** — `markerId`, or `all: true` (default `false`). `destructiveHint: true`.
- Fix or document the `null` marker duration; return an explicit `durationSeconds: null` plus `durationReliable: false` if it cannot be read.

## API hints (ES3 through the CEP `evalScript`)
- Look in `au_api_dump` for the document's selection range and marker collection (`markers`, `add`, `remove`). Marker identity may need a time/name key if no id exists — document the choice.
- Reuse the existing `au_add_marker` script for the marker field mapping.

## Acceptance tests
1. `au_set_selection({ startSeconds: 2, endSeconds: 5 })` reads back through `au_get_selection`.
2. Add three markers; `au_list_markers` returns them in order; `au_update_marker` changes one.
3. `au_remove_marker({ all: true })` clears them.
4. A range marker keeps its duration through add, list, and update (or reports `durationReliable: false`).
5. ES3 check; not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`.
