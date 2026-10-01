---
id: PP-05
app: premiere
title: Captions, transcription, and interchange export (FCPXML / OTIO)
priority: P3
status: open
evidence: unverified
depends_on: []
---

# PP-05 — Captions, transcription, interchange export

> **UNVERIFIED — verify against current behavior before building.** This is a roadmap item: `docs/BUILD_PLAN.md:142` lists "FCPXML/OTIO export, transcribe" as remaining for Premiere. First **investigate** whether the `premierepro` UXP API exposes any of this; if it does not, write the finding into `docs/spikes/07-premiere-tools-live.md` and stop, instead of building a workaround.

## Problem
A client cannot work with captions or transcripts, and cannot hand a timeline to another editor in an interchange format.
- No import or creation of caption tracks (for example from an `.srt`), and no caption export.
- No transcription trigger or transcript read-back.
- No FCPXML, OTIO, or EDL export of a sequence. (`pp_export_sequence` renders media through presets or Media Encoder; it does not write interchange files.)

## Add (only for what the API supports)
- **`pp_import_captions`** — `path` (`.srt`/`.vtt`/`.scc`), `format`, `sequenceId`, `trackName`.
- **`pp_export_captions`** — `path`, `format`, `sequenceId`.
- **`pp_get_transcript`** / **`pp_transcribe_sequence`** — if a transcription action is exposed; `timeoutClass: "slow"` and a job via `runOrQueue`.
- **`pp_export_interchange`** — `format` (`fcpxml | otio | edl`), `path`, `sequenceId`; if only one format is reachable, ship that one and document the others as unsupported.
- Gate anything long-running through the job registry (`cc_job_*`), like `ame_encode`.

## API hints
- Check `require("premierepro")` for caption and transcript objects and for any export-as-XML/EDL action; compare with the menu commands if the panel can invoke them.
- Where only a menu command exists, document it and decide with the owner whether to drive it (menu commands can open dialogs).

## Acceptance tests
1. `pp_import_captions` of a 3-line `.srt` adds a caption track with three items.
2. `pp_export_captions` writes a readable `.srt`.
3. If transcription is available: a short clip returns a transcript with timestamps.
4. If an interchange format is available: the exported file parses and lists the same clips.
5. If the API does not support an item, the spike doc records that and no tool is added.

## Definition of done
See `00_PREAMBLE.md`. A finding that the API lacks a feature counts as done if documented in the spike doc.
