---
id: PP-04
app: premiere
title: Marker edit and delete; clip markers
priority: P3
status: open
evidence: unverified
depends_on: []
---

# PP-04 — Edit and delete markers

> **UNVERIFIED — verify against current behavior before building.** Derived from `pp_add_marker` and `pp_list_markers` in `packages/server/src/tools/premiere.ts`. Check the `premierepro` UXP marker API first.

## Problem
`pp_add_marker` (`name`, `seconds`, `durationSeconds`, `comments`, `type`: `comment | chapter | weblink | cue`) and `pp_list_markers` exist. Nothing edits or removes a marker.
- A client that adds markers to label a cut cannot fix a wrong time or comment, and cannot clear its own markers before re-adding, so duplicates accumulate.
- Markers on **clips** (as opposed to the sequence) are not addressable.

## Add
- **`pp_update_marker`** — `markerId` (or `index`), then any of `name`, `seconds`, `durationSeconds`, `comments`, `type`, `color`.
- **`pp_delete_marker`** — `markerId` (or `index`), or `all: true` (default `false`); `destructiveHint: true`.
- Add an optional `clipRef` to `pp_add_marker`, `pp_list_markers`, `pp_update_marker`, and `pp_delete_marker` for clip markers.
- Make `pp_list_markers` return a stable `markerId` for each marker.

## API hints (UXP, `require("premierepro")`)
- Sequence and clip markers through the `Markers` API (`createAddMarkerAction`, `createMoveMarkerAction`, delete action); check names in the target version.
- Use the project's undo transaction so each tool is one undo step.

## Acceptance tests
1. Add three markers; `pp_update_marker` changes only one.
2. `pp_delete_marker({ all: true })` clears them; one undo restores.
3. A clip marker round-trips through add, list, update, and delete.
4. Not-connected-path test and round-trip test per tool.

## Definition of done
See `00_PREAMBLE.md`.
