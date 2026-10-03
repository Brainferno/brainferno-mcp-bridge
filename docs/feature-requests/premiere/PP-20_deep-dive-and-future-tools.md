---
id: PP-20
app: premiere
title: Deep dive and future-tools brainstorm
priority: P3
status: open
evidence: unverified
depends_on: [PP-01, PP-02, PP-03, PP-04, PP-05]
---

# PP-20 — Premiere Pro deep dive and future-tools brainstorm

> **UNVERIFIED — a planning prompt, not a build prompt.** This runs **after** the base
> Premiere features (PP-01…PP-05) ship. It (1) maps the real `@adobe/premierepro` UXP surface to
> find what video and audio editing is still missing, and (2) brainstorms candidate tools for
> better video production, color, and audio. Each accepted idea becomes its own numbered prompt
> (`PP-21`, `PP-22`, …), verified live first. CEP is EOL — never plan a CEP shim.

## Why a deep dive
Premiere's UXP API (`require("premierepro")`) grows most months, and some editing lives only in
the QE/undocumented layer or not at all. Before planning each tool, confirm the setter exists;
where it does not, decide per gap: *accept*, *.mogrt workaround*, or *FCPXML / OTIO round-trip*
(the decision pattern from `docs/BUILD_PLAN.md`).

## Deep-dive method
1. **Dump the typings.** Record the installed `@adobe/premierepro` version and list its objects,
   methods, and enums into `docs/api-dumps/premiere-<version>.md` (ours, not Adobe docs).
2. **Gap matrix** against the current 29 tools: each capability area (below) is *covered*,
   *gap — API exists*, or *gap — no API → workaround*.
3. **Spike the risky ones live** on 26.3 stable and the current beta: Lumetri params, Essential
   Sound, .mogrt parameter editing, captions/transcription. Note results in
   `docs/spikes/07-premiere-tools-live.md`.
4. **Prioritize** and **write one prompt file per accepted tool.**

## Brainstorm — candidate tools (grouped by goal)

### Timeline editing (beyond PP-01/PP-02/PP-03)
- **`pp_multicam`** — build a multicam source sequence from synced angles and switch the active angle.
- **`pp_nest` / `pp_unnest`** — nest selected clips into a sub-sequence and back.
- **`pp_sync_audio`** — merge/sync a camera clip with a separate audio recording by waveform.
- **`pp_scene_edit_detection`** — cut a flattened clip at detected scene changes.
- **`pp_replace_footage` / `pp_relink`** — swap or re-link a clip's source media.
- **`pp_subclip`** — create a subclip from an in/out range.

### Color (Lumetri)
- **`pp_apply_lut`** — apply a `.cube` input/creative LUT to a clip or an adjustment layer.
- **`pp_set_lumetri`** — white balance, exposure, contrast, highlights/shadows, saturation, curves,
  and color-wheel values. **Spike** whether these are reachable via the component/parameter API.
- **`pp_apply_lumetri_preset`** — apply a saved `.look` / Lumetri preset.

### Audio
- **`pp_set_audio_gain`** — clip volume in dB, and **`pp_audio_keyframes`** for volume/pan automation.
- **`pp_essential_sound`** — tag a clip (dialogue / music / sfx / ambience) and apply the matching
  Essential Sound preset (loudness, EQ, reduce noise). **Spike** API reach.
- **`pp_auto_duck`** — duck a music track under dialogue (sidechain), a core production move.
- **`pp_track_mixer`** — track-level volume, pan, mute, solo.

### Titles, graphics, captions
- **`pp_set_mogrt_params`** — edit the exposed fields (text, color, position) of a `.mogrt` already
  placed by `pp_insert_mogrt` — closes the Essential Graphics loop with After Effects. High value.
- **`pp_transcribe` / `pp_import_srt` / `pp_export_srt`** — speech-to-text captions and interchange.
  (Coordinate with **PP-05**, which already covers captions/interchange — fold in, don't duplicate.)

### Video production and delivery
- **`pp_auto_reframe`** — reframe a sequence to new aspect ratios (9:16, 1:1) for social.
- **`pp_create_proxies` / `pp_attach_proxy`** — proxy workflow for heavy media.
- **`pp_apply_effect` presets** — warp stabilizer, morph cut, and effect presets (`.prfpset`).
- **`pp_batch_export`** — queue several sequences / in-out ranges to Media Encoder as one job
  (builds on `ame_encode` + `cc_job_*`).
- **`pp_export_still_sequence`** — export a frame range as an image sequence.

## Overlap and constraints to resolve during the deep dive
- Captions overlap **PP-05**; track management overlaps **PP-02** — extend, don't duplicate.
- Several color/audio setters may be absent from the UXP API. Where so, record the gap and pick a
  workaround (adjustment layer + preset, or hand off to Media Encoder) instead of forcing it.
- Long renders/exports are jobs (`runOrQueue` + `cc_job_wait`), never blocking calls.

## Output of this prompt
A gap matrix in `docs/api-dumps/`, plus new numbered prompt files (`PP-21`+) for accepted tools,
each following `00_PREAMBLE.md`. No production code lands under this id itself.
