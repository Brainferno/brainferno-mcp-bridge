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

## Raw script / generic runner investigation (X-01, 2026-10-08)

Question from X-01: can the `premierepro` UXP API take a gated script-eval or a generic action
runner (`pp_run_action`)? Answer so far: **not today, possibly with a manifest permission —
unproven.** Nothing was built; this records the evidence and the probe that would settle it.

- **No eval path today.** The panel (`packages/panel-uxp-ppro/commands.js`) is a fixed table of
  named commands — 29 when this was written, advertised live in its hello `capabilities` — and
  the server's `pp_*` tools only ever send those names (`bridge.execute`); nothing in the panel
  or the server evaluates a script string. `cc_eval_script` covers only the ExtendScript hosts.
- **Where "UXP cannot eval" comes from.** Spike 03 (Photoshop 27.9.1) found `new Function`
  blocked with a "code generation from strings disallowed" error. That panel's manifest
  (`manifestVersion` 5) asks for no code-generation permission, so the finding describes UXP's
  default, not a hard limit. It was never tested in Premiere Pro.
- **Premiere Pro's runtime knows the permission.** On Premiere Pro 26.5.2 (build 26.5.2.5,
  Windows) the UXP runtime library `dynamic-torqnative.dll` (UXP 9.3) contains
  `allowCodeGenerationFromStrings` as a plugin flag: a check that it is a boolean, and loader
  checks that refuse string-code paths while it is false. Adobe's Frame.io panel that ships
  with Premiere Pro (`UXP/plugins/com.adobe.frameio.uxp/manifest.json`, `manifestVersion` 6)
  sets it to `true` under `requiredPermissions`. Found by reading the installed files; Premiere
  Pro was not run for this.
- **Untested:** whether a third-party plugin is granted it — ours is `manifestVersion` 5 —
  either dev-loaded through the UXP Developer Tool or installed as a `.ccx` through UPIA, and
  whether it needs `manifestVersion` 6.
- **Even if eval works, a raw script is not one undo step.** Every `pp_*` mutation is one undo
  step because it runs inside `project.lockedAccess` + `executeTransaction`, and those callbacks
  are synchronous (the rule at the top of `commands.js`). The `premierepro` API is
  promise-based, so a script that awaits cannot run inside a single transaction: a raw Premiere
  Pro script would be several undo steps, or limited to building one synchronous compound
  action from objects fetched beforehand.

**Operator probe** (needs Premiere Pro and someone at the UXP Developer Tool):

1. In a *copy* of `packages/panel-uxp-ppro`, add `"allowCodeGenerationFromStrings": true` to
   `requiredPermissions` in `manifest.json`.
2. In the UXP Developer Tool, **Unload** then **Load** the copy (manifest changes need both).
3. In that plugin's UDT console, run `new Function("return 1+1")()`; record the result or the
   exact error.
4. Package the copy as a `.ccx` (UDT → Package), remove the dev entry, install it through UPIA
   (see "Packaging the panels" in `docs/HANDOFF.md`) and repeat step 3.
5. Record the Premiere Pro build and the manifest's `manifestVersion` with each result; if v5
   is refused, note whether v6 changes it.

**Recommendation.** No `pp_run_action` in X-01. If the probe passes, `pp_run_action` gets its
own prompt — same gate and envelope (`packages/server/src/tools/raw-script.ts`), plus an
explicit undo story. If it fails, Premiere Pro coverage keeps growing through named commands
(`PP-01` to `PP-05`).

**Lead worth following.** Premiere Pro 26.5.2 also ships an `AgenticSkills` folder (three
`SKILL.md` skill folders). It may point to a first-party agent surface inside Premiere Pro — a
possible delegate lane like Illustrator's `ai_beta_call` — rather than an eval in our panel.
Not investigated further.
