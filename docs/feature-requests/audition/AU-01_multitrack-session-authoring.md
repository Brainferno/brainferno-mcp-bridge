---
id: AU-01
app: audition
title: Multitrack session authoring — create session, tracks, clips, mixer settings
priority: P1
status: open
evidence: unverified
depends_on: []
---

# AU-01 — Multitrack session authoring

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/audition.ts:61-79`, `docs/BUILD_PLAN.md:143` ("Remaining: multitrack session tools"), `docs/spikes/08-audition-tools-live.md:46-47` (multitrack sessions were not exercised; creating a session goes through a dialog command), and `docs/api-dumps/audition-26.3.json`, which lists `AudioTrackCollection.add` and `AudioClipCollection.add`. Audition's scripting API is undocumented: use `au_api_dump` and a live probe first.

## Problem
The Audition tools **read** documents and drive transport and menu commands, but they cannot **build** a multitrack session.
- No session creation without a dialog (`au_invoke_command` opens dialogs).
- No add track, no insert clip, no move or trim clip, and no mixer settings (volume, pan, mute, solo).
- Existing tools (12): `au_app_state`, `au_document_info`, `au_list_commands`, `au_invoke_command` (612 menu commands), `au_apply_favorite`, `au_set_playhead`, `au_transport`, `au_add_marker`, `au_open_document`, `au_close_document`, `au_save_document`, `au_api_dump`.

## Add
- **`au_create_session`** — `name`, `path` (`.sesx`), `sampleRate` (default 48000), `bitDepth`, `channels` (`stereo|mono|5.1`). Must not open a dialog; if the DOM cannot do this, document the limit and fall back to opening a template session (`templatePath`).
- **`au_list_tracks`** / **`au_list_clips`** — `documentId?`; return ids, names, types, start/duration. `readOnlyHint: true`.
- **`au_add_track`** — `type` (`audio | bus | video`), `name`, `index?`.
- **`au_insert_clip`** — `trackId`, `path`, `startSeconds`, `name?`.
- **`au_move_clip`** — `clipId`, `startSeconds`, `trackId?`; **`au_trim_clip`** — `clipId`, `inSeconds`, `outSeconds`.
- **`au_set_track_props`** — `trackId`, any of `name`, `volumeDb`, `pan` (-100..100), `muted`, `solo`, `armed`.
- **`au_delete_clip`**, **`au_delete_track`** (`destructiveHint: true`).

## API hints (ES3 through the CEP `evalScript`)
- Use `au_api_dump` (and `docs/api-dumps/audition-26.3.json`) to find the real object names: `AudioTrackCollection.add`, `AudioClipCollection.add`, and their parameters; there is no public documentation, so probe on a live session and record the results in `docs/spikes/08-audition-tools-live.md`.
- Wrap mutations so one tool = one undo step if the API exposes undo grouping; otherwise note it.

## Acceptance tests
1. `au_create_session` creates a saved `.sesx` with the requested sample rate, without a dialog.
2. `au_add_track` + `au_insert_clip` of a WAV at 2 s; `au_list_clips` shows start 2 s and the right duration.
3. `au_set_track_props({ volumeDb: -6, muted: true })` reads back.
4. `au_trim_clip` shortens a clip; `au_delete_clip` removes it.
5. If a call needs a dialog, the tool fails with an actionable message rather than hanging (see `X-02`).
6. ES3 check; not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`. Reopen the Audition panel to live-verify.
