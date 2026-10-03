---
id: AU-20
app: audition
title: Deep dive and future-tools brainstorm
priority: P3
status: open
evidence: unverified
depends_on: [AU-01, AU-02, AU-03, AU-04]
---

# AU-20 — Audition deep dive and future-tools brainstorm

> **UNVERIFIED — a planning prompt, not a build prompt.** This runs **after** the base
> Audition features (AU-01…AU-04) ship. It (1) uses the dumped scripting dictionary to find what
> audio repair, mixing, and mastering is still missing, and (2) brainstorms candidate tools. Each
> accepted idea becomes its own numbered prompt (`AU-21`, `AU-22`, …), verified live first.

## Why a deep dive
Audition's scripting is the undocumented ExtendScript DOM reached via CEP `evalScript`:
`app.invokeCommand()` over ~500 command constants, plus Favorites, Transport, and `saveAs()`.
Many effects open a **modal dialog**, and any modal blocks all scripting until a human clicks it.
So the deep dive's real job is to sort capabilities into three lanes: *scriptable headless*,
*hands-off via a saved Favorite*, or *deterministic via the ffmpeg sidecar*.

## Deep-dive method
1. **Dump the dictionary.** Run `au_api_dump` on the installed version into
   `docs/api-dumps/audition-<version>.md`, and `au_list_commands({ checkEnabled: true })` to see
   what is enabled in Waveform vs Multitrack.
2. **Classify each capability** into: *headless command* (no modal), *Favorite-only* (record once,
   apply via `au_apply_favorite`), or *ffmpeg sidecar* (deterministic batch). Note the modal risk.
3. **Spike the AI/spectral effects** (DeNoise, DeReverb, Sound Remover, spectral heal) — confirm
   whether they can run without a dialog; record in `docs/spikes/08-audition-tools-live.md`.
4. **Prioritize** and **write one prompt file per accepted tool.**

## Brainstorm — candidate tools (grouped by goal)

### Repair (the reason people open Audition)
- **`au_capture_noise_print` + `au_noise_reduction`** — sample room tone, then reduce it.
- **`au_denoise` / `au_dereverb`** — the AI DeNoise / DeReverb sliders. **Spike** for modals.
- **`au_sound_remover`** — learn and remove a recurring sound (siren, ring).
- **`au_declick` / `au_decrackle` / `au_dehum`** — fix clicks, crackle, 50/60 Hz hum.
- **`au_spectral_heal`** — heal a time-frequency selection (remove a cough/bump). Selection-based;
  spike how a selection is set via script.

### Mastering and loudness
- **`au_match_loudness`** — bring a file/batch to a target (-14 / -16 / -23 LUFS) with true-peak.
  (Pairs with the ffmpeg `audio_normalize_loudness` tool — decide which lane wins per case.)
- **`au_hard_limiter` / `au_multiband_compressor` / `au_parametric_eq`** — the master-chain effects,
  likely best shipped as recorded Favorites with named presets.

### Clip and waveform editing
- **`au_trim` / `au_split` / `au_delete_range` / `au_silence_range`** — waveform surgery by time.
- **`au_fade`** — fade in/out and crossfade with a shape; **`au_clip_gain`** — per-clip gain.
- **`au_time_stretch` / `au_pitch_shift`** — change length without pitch, or pitch without length.
- **`au_remix`** — retime a music bed to a target duration (Audition's Remix).

### Multitrack mixing (beyond AU-01 authoring)
- **`au_set_clip_gain` / `au_track_volume_pan`** — levels and pan per clip/track.
- **`au_auto_duck`** — duck music under dialogue (sidechain) — the core podcast/VO move.
- **`au_essential_sound`** — tag a clip (dialogue / music / sfx / ambience) and apply its preset.
- **`au_add_bus` / `au_send`** — routing for shared reverb/compression.

### Generate and export
- **`au_generate_tone` / `au_generate_noise` / `au_generate_silence`** — test tones, beds, spacers.
- **`au_mixdown_stems`** — bounce a session to stems (dialogue/music/sfx) plus the full mix.
- **`au_export_markers`** — markers to CSV for chapters/edit notes.
- **`au_batch_process`** — apply a Favorite across a folder as a job (`runOrQueue`).

## Overlap and constraints to resolve during the deep dive
- **Modal = not a tool.** If an effect cannot run without a dialog, ship it as a named Favorite via
  `au_apply_favorite`, or hand the deterministic version to the ffmpeg `audio_*` lane.
- Coordinate with **AU-02** (effects/favorites), **AU-03** (selection/markers), **AU-04** (export/AME)
  so the deep-dive tools extend them, not overlap.
- ES3 ExtendScript (`var`, no arrow/`JSON.`), one IIFE; `isCommandEnabled` gating differs between
  Waveform and Multitrack — always check before invoking.

## Output of this prompt
A classified capability matrix (headless / Favorite / ffmpeg) in `docs/api-dumps/`, plus new
numbered prompt files (`AU-21`+) for accepted tools, each following `00_PREAMBLE.md`. No production
code lands under this id itself.
