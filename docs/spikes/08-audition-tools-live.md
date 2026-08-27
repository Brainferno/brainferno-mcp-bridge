# Audition tool set v1 + audio (ffmpeg) lane — live run (2026-08-27, Windows, Audition 2026 v26.3.0 build 79, ffmpeg 8.1)

Audition is reached through the same CEP panel as After Effects (`packages/panel-cep`, host
`AUDT`, PlayerDebugMode already on). The panel picks `appId: "audition"` from
`getHostEnvironment().appId`, so nothing panel-side changed.

## How the API was learned

Audition's ExtendScript DOM is undocumented. `au_api_dump` runs Adobe's own ScriptDictionary
technique (`$.dictionary.getClasses / getClass`) and wrote **106 classes** to
`docs/api-dumps/audition-26.3.json`. What v1 is built on (all verified live):

- `app.openDocument(new DocumentOpenParameter(path))` — a bare File or string throws
  "Illegal Parameter type".
- `app.invokeCommand(id)` / `app.isCommandEnabled(id)` over **612** `Application.COMMAND_*`
  constants (ids like `Effects.Normalize`, `Multitrack.ImportAndInsertFilesAsClips`,
  `File.Export.MultitrackMixdownAll`).
- `WaveDocument`: `sampleRate`, `duration` and `playheadPosition` in **samples**,
  `audioFormat {sampleRate, bitDepth, channelLayout}`, `markers[]`, `applyFavorite(name)`,
  `addMarker(start, duration, name, type, description)`, `saveAs(path, export)`,
  `saveDocument(null)`, `closeDocument()`.
- `MultitrackDocument`: `audioTracks.audioClipTracks[i].audioClips[j]` (`startTime`,
  `duration`, `name`), `saveAsDocument`, `exportDocument`; an `AMEServer` class can queue a
  session to Media Encoder.
- `app.transport.play() / stop() / pause() / record()`, `isPlaying`, `loop`.

## Live run

1. `au_app_state` → 26.3.0 / build 79, no documents. `au_api_dump` → 106 classes.
2. `au_open_document` a generated 4 s WAV → WaveDocument, 48 kHz, 16-bit stereo, "Wave PCM".
3. `au_apply_favorite` "Normalize to -0.1 dB" → `true`; `au_add_marker` "hit" at 1.5 s → type "cue".
4. `au_transport` play → playhead moved; stop → playhead at 4 s.
5. `au_save_document` export=true → `voice-test-normalized.wav`; `audio_measure_loudness` on it
   read **−0.05 dBTP** (was −33 dBTP) — the Favorite really ran, hands-off.
6. ffmpeg lane on the original: `audio_measure_loudness` −40.5 LUFS → `audio_normalize_loudness`
   → **−15.99 LUFS** (target −16); `audio_waveform_image` → image block.

## Gotchas

- `applyFavorite` returns before the document reports `dirty: true`; read state after the next
  call if you need it.
- `isPlaying` is still `false` immediately after `play()` returns `true`.
- Marker `duration` reads back `null` on a cue marker (Audition exposes no duration for cues).
- A quiet source (−40 LUFS) still normalizes cleanly; loudnorm reports `normalization_type:
  dynamic` for such large gains — that is expected.
- Not yet exercised: multitrack sessions (creating one goes through a dialog command),
  `AMEServer` queueing. The reads (`__tracks`) are in place for when a `.sesx` is opened.

## Tool inventory
`au_*` (12): app_state · document_info · list_commands · invoke_command · apply_favorite ·
set_playhead · transport · add_marker · open_document · save_document · close_document · api_dump
`audio_*` (9, ffmpeg, no Adobe app needed): probe · measure_loudness · normalize_loudness ·
convert · trim · trim_silence · denoise · mix · waveform_image
