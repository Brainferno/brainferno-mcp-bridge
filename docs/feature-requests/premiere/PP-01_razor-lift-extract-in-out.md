---
id: PP-01
app: premiere
title: Razor / split, lift and extract, sequence in and out points
priority: P1
status: open
evidence: unverified
depends_on: []
---

# PP-01 — Razor / split, lift / extract, in and out points

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/premiere.ts`, `docs/BUILD_PLAN.md:204` ("Premiere gaps (Essential Graphics text, captions, razor)"), and `docs/spikes/07-premiere-tools-live.md`. Check the `premierepro` UXP API for what is actually available in the target Premiere version before designing.

## Problem
A client can insert, move, trim, and remove clips, but it cannot **cut** a clip in two, and it cannot remove a range from a timeline.
- No razor / split at a time. Splitting a clip needs the editor's razor tool.
- No lift or extract of a time range across tracks.
- Sequence in/out points are **read** (`pp_get_sequence`; unset points read as `null`, `docs/spikes/07-…:34`) but cannot be set.
- Existing relevant tools: `pp_insert_clip`, `pp_remove_clips` (`clips[]`, `ripple`), `pp_move_clip`, `pp_trim_clip`, `pp_set_clip_props` (`name`, `disabled`).

## Add
- **`pp_split_clip`** — `clipRef` (`trackType`, `trackIndex`, `clipIndex`), `seconds` (sequence time), `allTracks` (default `false`), `sequenceId` (optional).
- **`pp_set_sequence_in_out`** — `inSeconds`, `outSeconds` (either optional; `null` clears), `sequenceId`.
- **`pp_lift`** and **`pp_extract`** — `startSeconds`, `endSeconds` (default: sequence in/out), `trackTargets` (optional), `sequenceId`. Lift leaves a gap; extract ripples. `destructiveHint: true`.

## API hints (UXP, `require("premierepro")`)
- Look for edit operations on the sequence / `SequenceEditor` and `TrackItem` APIs; if no split exists, implement it as: duplicate the clip, trim the first copy's out and the second copy's in at `seconds`, preserving effects (document any limits).
- Sequence in/out: `sequence.setInPoint(time)` / `setOutPoint(time)` with `TickTime` objects.
- Keyframe and clip times are **media time**, not sequence time (`docs/spikes/07-…:29-31`); convert carefully.
- Wrap mutations in the panel's existing transaction/undo helper (see the existing `pp.*` commands in `packages/panel-uxp-ppro/commands.js`).

## Acceptance tests
1. A 10 s clip at 0 s: `pp_split_clip({ seconds: 4 })` yields two clips (0–4, 4–10) with identical effects.
2. `pp_set_sequence_in_out` reads back through `pp_get_sequence`.
3. `pp_extract` over 2–4 s shortens the sequence by 2 s; `pp_lift` leaves a 2 s gap.
4. Error when `seconds` is outside the clip.
5. Not-connected-path test and round-trip test per tool.

## Definition of done
See `00_PREAMBLE.md`. Reload the Premiere panel in the UXP Developer Tool to live-verify.
