# Pipelines + job registry — live run (2026-08-27, Windows)

The flagship chain from the plan, run from one Claude Code conversation with Photoshop,
After Effects, Premiere Pro and Audition open:

1. `pipeline_ps_to_ae` (compId 1) — Photoshop exported the active PSD to the job's work
   folder → After Effects imported it (item 83) → added it as layer "psd art" to
   "Brainferno Title". 0.4 s.
2. `pipeline_render_and_import` (insertAtSeconds 10) — AE project saved → aerender rendered
   the comp (6 s, frame progress logged) → Premiere imported the AVI → inserted at 10 s on V1;
   sequence grew to 15 s. 18 s total.
3. `pipeline_audio_roundtrip` (denoise, −16 LUFS, A2) — Premiere exported the sequence audio
   with the "Waveform Audio 48kHz 16-bit" preset → measured −7.55 LUFS → afftdn → two-pass
   loudnorm to **−16.0 LUFS** → imported → overwritten onto A2 at 0 s (15 s clip). 5 s total.

Every pipeline returned the job view: per-step status, artifacts (file paths in
`~/.adobe-cc-mcp/work/<jobId>/`), and the composed result.

## The failure report, seen for real

The very first `pipeline_ps_to_ae` run failed at step 3 with `AVItem is undefined`
(AE 26.3 has no `AVItem` global in ExtendScript — same family as the `TextLayer` finding).
The job answered:

```
status: failed
steps:  Export from Photoshop ✓ · Import into After Effects ✓ · Add layer to comp ✗ (recoveryTool: ae_add_layer)
error:  { step: "Add layer to comp", message: "AVItem is undefined", completedSteps: [...] }
artifacts: [ .../photoshop-export.png ]
```

Exactly what the plan asked for: the step that broke, the tool that recovers it, and the
work already done kept on disk. Fixed by testing `FootageItem || CompItem`.

## Job tools

- `cc_job_status`, `cc_list_jobs`, `cc_job_wait` (streams `notifications/progress` against
  the client's progressToken while waiting), `cc_job_cancel` (aborts aerender/ffmpeg via
  AbortSignal; in-app steps finish their current command first).
- `ae_render_comp` and `pp_export_sequence` accept `wait: false` and return a jobId.

## Gotchas

- `loudnorm` runs at 192 kHz internally and writes that rate unless told otherwise — the
  first roundtrip produced an 11.5 MB WAV for 15 s. `audio_normalize_loudness` now resamples
  back to the source rate (ffprobe) and the ffmpeg test asserts it.
- `pp_insert_clip` reported the V1 clip at the same time for an audio-only item; it now
  prefers the clip whose project item matches the one inserted.
- Premiere's `importFiles` is happy with paths under `~/.adobe-cc-mcp/work`; nothing needs
  to be in the project folder.
