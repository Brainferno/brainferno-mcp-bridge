---
id: PP-02
app: premiere
title: Clip speed, duration, reverse; track management
priority: P2
status: open
evidence: unverified
depends_on: []
---

# PP-02 — Clip speed / duration / reverse, and track management

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/premiere.ts` and `packages/panel-uxp-ppro/commands.js:169` and `:194`. Check the `premierepro` UXP API for what is writable in the target Premiere version.

## Problem
- Clip **speed** is only read (`commands.js:169`). Nothing sets speed, duration, or reverse, so a client cannot do slow motion, time-fit, or reverse playback.
- Track **mute** is only read (`commands.js:194`). Nothing adds or deletes tracks, locks or targets them, or sets track names.
- Effect keyframes are **not** missing: `pp_set_effect_param` already takes `seconds` and `interpolation` (`linear | bezier | hold`) — do not duplicate that.

## Add
- **`pp_set_clip_speed`** — `clipRef`, `speedPercent` (default 100), `reverse` (default `false`), `maintainAudioPitch` (default `true`), `rippleEdit` (default `false`), `sequenceId`.
- **`pp_set_clip_duration`** — `clipRef`, `durationSeconds`, `adjustSpeed` (default `false`: trim instead of retime).
- **`pp_add_track`** — `type` (`video | audio`), `count` (default 1), `atIndex` (optional), `sequenceId`.
- **`pp_delete_track`** — `type`, `trackIndex`, `sequenceId` (`destructiveHint: true`; refuse when the track has clips unless `force`).
- **`pp_set_track_props`** — `type`, `trackIndex`, any of `name`, `muted`, `locked`, `targeted`, `soloed` (audio), `sequenceId`.

## API hints (UXP, `require("premierepro")`)
- Look for clip speed / duration actions on `TrackItem` (and the `SequenceEditor`) and track mute / lock / target on `VideoTrack` / `AudioTrack`; if a setter is missing, record what you tried in `docs/spikes/07-premiere-tools-live.md`.
- Times use `TickTime`; keep the media-time vs sequence-time rule from the spike doc.

## Acceptance tests
1. A 10 s clip at 50 % speed lasts 20 s on the timeline (with `rippleEdit: false`, the next clip is overwritten or the call errors — pin the behavior and document it).
2. `reverse: true` plays backward (check via an exported frame at the start).
3. `pp_add_track` raises the track count by one in `pp_get_sequence`.
4. `pp_set_track_props({ muted: true })` reads back.
5. Not-connected-path test and round-trip test per tool.

## Definition of done
See `00_PREAMBLE.md`.
