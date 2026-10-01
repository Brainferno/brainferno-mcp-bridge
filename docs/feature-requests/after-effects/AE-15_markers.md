---
id: AE-15
app: after-effects
title: Markers — list, update, remove, and full marker fields
priority: P3
status: open
evidence: verified
depends_on: []
---

# AE-15 — Markers

## Problem
`ae_add_marker` can add a comp or layer marker with a time, a comment, and a duration. Nothing can **list**, **change**, or **remove** a marker, and the extra marker fields are not settable.
- A client that adds markers to label animation steps cannot correct a wrong time or comment, and cannot clear its own markers before re-adding them (duplicates accumulate).
- Fields beyond comment and duration (chapter, URL, frame target, cue-point name, label color, protected region) are unreachable.

## Add
- **`ae_list_markers`** — `compId|compName`, `layerIndex|layerName` (optional; omit for comp markers). Returns `[{ index, time, duration, comment, chapter, url, frameTarget, cuePointName, label, protectedRegion }]`. `readOnlyHint: true`.
- **`ae_update_marker`** — same target args, `index` (1-based) **or** `time` (matches the marker at that time), then any of `newTime`, `comment`, `duration`, `chapter`, `url`, `frameTarget`, `cuePointName`, `label` (0-16), `protectedRegion`.
- **`ae_remove_marker`** — same target args, `index` or `time`, or `all: true` (default `false`). `destructiveHint: true`.
- **Extend `ae_add_marker`** with `chapter`, `url`, `frameTarget`, `cuePointName`, `label`, `protectedRegion`.

## API hints (ES3)
- Comp markers: `comp.markerProperty`; layer markers: `layer.property("ADBE Marker")`.
- Read: `prop.numKeys`, `prop.keyTime(i)`, `prop.keyValue(i)` → `MarkerValue` (`comment`, `duration`, `chapter`, `url`, `frameTarget`, `cuePointName`, `label`, `protectedRegion`).
- Update: build a new `MarkerValue`, then `prop.setValueAtTime(time, mv)`; to move a marker remove the key and set a new one.
- Remove: `prop.removeKey(i)` (loop from the end); `prop.nearestKeyIndex(time)`.

## Acceptance tests
1. Add three markers; `ae_list_markers` returns them in time order.
2. `ae_update_marker({ index: 2, comment: "fixed" })` changes only that marker.
3. `ae_remove_marker({ all: true })` clears the comp's markers; one Ctrl-Z restores them.
4. A layer marker with a `url` and `label` round-trips.
5. ES3 check; `__undo(` check.

## Definition of done
See `00_PREAMBLE.md`.
