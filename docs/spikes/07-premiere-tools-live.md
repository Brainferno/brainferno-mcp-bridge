# Premiere Pro tool set v1 — live run (2026-08-27, Windows, Premiere Pro 2026 v26.3.2, UXP API 26.3)

Driven from Claude Code through the hub and the Brainferno MCP Bridge UXP panel
(`packages/panel-uxp-ppro`, loaded with the UXP Developer Tool after enabling
**Settings → Plugins → Enable developer mode** and restarting Premiere):

1. `pp_import_files` the After Effects aerender output (`brainferno-title.avi`) and the Photoshop PNG.
2. `pp_create_sequence` "Brainferno Cut" from the AVI (New Sequence From Clip → 1920×1080 30 fps, 3V/3A).
3. `pp_insert_clip` the PNG at 5 s → V1 clip 1 (5–10 s). `pp_trim_clip` end → 8 s.
4. `pp_add_transition` Cross Dissolve, 1 s, end of clip 0. `pp_add_marker` "cut to still" at 5 s.
5. `pp_apply_effect` "Gaussian Blur" on the still; `pp_set_effect_param` Motion → Scale 60 (static),
   then keyframes 60 @ 5 s → 100 @ 8 s (bezier). `pp_get_clip_effects` read every component/param back.
6. `pp_export_frame` at 2 s / 5.2 s / 7.8 s → image blocks (title; small still; big still — the keys animate).
7. `pp_move_clip`, `pp_set_clip_props` (rename), `pp_remove_clips` (ripple, end 8 → 5 s), re-insert.
8. `pp_list_export_presets` "H264 Match Source" → `pp_export_sequence` immediately → 4.7 MB `.mp4`
   (`ftyp` header), then `pp_save_project`.

## Gotchas found (all handled in `commands.js`)

- **`project.importFiles(paths, suppressUI, undefined, stills)` throws "Illegal Parameter type"** on
  26.3. Pass the root `FolderItem` (`project.getRootItem()`) as the target bin. The panel tries the
  documented call shapes in order and reports which one worked (`signature`).
- **`Exporter.exportSequenceFrame` needs the extension in the file name** ("File Format is not
  supported" otherwise). The server passes `<uuid>.png` and waits for either `<uuid>.png` or
  `<uuid>.png.png`.
- **`TrackItem.createMoveAction(t)` is a relative shift**, not an absolute start. `pp_move_clip`
  converts (delta = target − current start) and re-finds the clip by start time.
- **Effect keyframe times are media time**: sequence second S ↔ `inPoint + (S − clipStart)`.
  Stills have an in point near 3600 s, so keys at "0" sit an hour before the visible range.
  Turning a param time-varying also auto-adds a key at media 0; the panel hides keys outside
  the clip.
- **`ComponentParam.getValueAtTime` returns wrapped values** (`{ value: … }`, sometimes nested).
  Unwrapped in `plainValue`; points → `[x, y]`, colors → `{r,g,b,a}`.
- Unset sequence in/out read as −400000 s → reported as `null`.
- On Premiere 2026 the effect whose display name is "Gaussian Blur" is `AE.Impact_Blur_FX`
  (the modern one); Adobe's old one is "Gaussian Blur (Legacy)" = `AE.ADBE Gaussian Blur 2`.
  Display-name matching therefore lands on the modern effect, which is what a user means.
- `AddTransitionOptions` / `OpenProjectOptions` are factories in Adobe's samples but classes in
  the typings; `make()` tries `new` first.
- The hub serializes commands per app, so a burst of tool calls runs in send order.

## Tool inventory (28)
project_info · list_sequences · list_project_items · get_sequence · list_markers ·
list_transitions · list_effects · get_clip_effects · open_project · create_project ·
save_project · import_files · create_sequence · set_active_sequence · set_player_position ·
insert_clip · remove_clips · move_clip · trim_clip · set_clip_props · add_transition ·
apply_effect · remove_effect · set_effect_param · add_marker · export_frame ·
list_export_presets · export_sequence
