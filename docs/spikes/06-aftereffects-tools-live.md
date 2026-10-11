# After Effects tool set v1 — live run (2026-08-27, Windows, After Effects 2026 v26.3)

Driven entirely from Claude Code through the hub and the Brainferno MCP Bridge CEP panel:

1. `ae_create_comp` "Brainferno Title" 1920×1080, 30 fps, 5 s → id 1.
2. `ae_add_layer` solid `#1e1e2e` "background"; `ae_add_layer` text "Brainferno".
3. `ae_set_text` Arial-BoldMT 160 pt `#f5a623`, justification center.
4. `ae_set_keyframes` position (−400, 540) → (960, 540) over 0–1 s, easy ease on the last key.
5. `ae_apply_effect` `ADBE Glo2` (Glow) → `ae_set_effect_param` radius 60, intensity 1.5.
6. `ae_add_marker` comp marker "in" at 1 s; `ae_get_comp` / `ae_get_layer` / `ae_get_keyframes` read it all back.
7. `ae_render_frame` at 0 s (title still off-screen) and 2 s (glowing centered title) → image blocks.
8. `ae_save_project` → `brainferno-title.aep`; `ae_render_comp` "Lossless" → `.avi` via aerender in 8 s,
   UI stayed free.

## Gotchas found

- **`layer instanceof TextLayer` is false** in AE 26.3 ExtendScript. Layer kinds come from
  `layer.matchName` (`ADBE Text Layer`, `ADBE Camera Layer`, `ADBE Light Layer`, `ADBE AV Layer`
  + `SolidSource`).
- **`setTemporalEaseAtKey` on a spatial property takes one `KeyframeEase`**, not one per
  dimension ("Value array does not have 1 elements"). Non-spatial arrays (scale) take one per
  dimension.
- **`saveFrameToPng` returns before the file exists.** The server polls until the file is
  present and its size is stable (`waitForFile`) before reading it.
- **`ParagraphJustification.CENTER_JUSTIFY` did not center point text on the anchor** — the
  text ended at the anchor. `ae_set_text` and text `ae_add_layer` now move the anchor point to
  the center of `sourceRectAtTime`, so `position` always means the visual center of the text.
- Same restart discipline as Photoshop: after a rebuild, kill this session's server, then `/mcp`
  reconnect. With several Claude Code windows open, the pid in `~/.brainferno-mcp-bridge/bridge.json`
  may be another window's server (see HANDOFF "Kill the right server"). The CEP panel reconnects on
  its own only after an abnormal drop; a clean shutdown sends "bye", the panel engages its kill
  switch, and you press **Connect** in it.
- **Line numbers are relative to the innermost eval** (verified live on 26.5, 2026-10-09, during
  X-01): a script run through `eval(src)` — even nested inside another eval, as the raw-script
  wrapper is inside `host.jsx`'s `__acmEval` — reports `e.line` counted within `src` itself. A
  SyntaxError reports the line too (line 1 for `var x = ;`). So a typed tool's error line is
  relative to the whole `wrap()`ped script, and AE-16's prelude subtraction is the right fix.
- **How AE-16 reads a typed tool's error line** (`locateAeError` in `after-effects.ts`): the
  first body statement is body line 1 (`AE_PRELUDE_LINES` is derived from the prelude, never
  typed); a line inside a shared helper names the helper (`in helper __prop`), since After
  Effects reports the helper's own line, not the call site; and a line that falls in neither
  reads as "outside this tool's own code". The CEP panel's `host.jsx` serializes the result in
  the same `try` as the `eval`, so an error it raises there — a host object in the result —
  carries host.jsx's own line number (the observed "line 40" was `__acmJson`'s `var x = v[k];`).
  Every After Effects script therefore starts with `HOST_LINE_GUARD` (100) blank lines, so a
  host.jsx line can never land on a helper or a body line. After Effects scripts also travel as
  pure ASCII since AE-16 (`\uXXXX` escapes; same text in the host).
- **AE-16 live probes — verified on After Effects 26.5 (Windows 11, 2026-10-10).** Typed `ae_*`
  tools only (no raw-script gate), on a new project, with a server built before the Card Dance
  change below: every probe passed except the empty-name noise that change fixes.
  Probe 21 (a disconnect, optional) was skipped, as the unit tests cover its text; with debug
  logging off, the effect list's re-read after the panel was reopened (probe 20) was not seen,
  though the suggestions still came back. What they settled:
  - `PropertyType.PROPERTY` exists: a path that goes on past a leaf
    (`["ADBE Transform Group", "ADBE Position", "X"]`) says the segment "is a property, not a
    group" and to end the path there.
  - `canAddProperty` is case-sensitive for match names ("adbe gaussian blur 2" was refused, so
    `EFFECT_NAMES_CASE_SENSITIVE` stays `true`; a display name in the wrong case was not tried)
    and takes display names ("Gaussian Blur" was
    applied as `ADBE Gaussian Blur 2`, so `EFFECT_DISPLAY_NAMES_ACCEPTED` is now `true` and the
    "or display name" in `ae_apply_effect` holds).
  - Cameras and lights: the Effect Parade and Mask Parade are null on both, and
    `ae_get_layer_styles`, `ae_apply_effect`, `ae_set_effect_param` and `ae_add_mask` give their
    camera-and-light messages.
  - A native error in a statement inside an `else if` branch reports that statement's own line
    (`ae_add_layer` solid of width 40000: body line 7, the `else if` line just above it in the
    excerpt).
  - The range errors come from After Effects with curly quotes (non-ASCII text from the host):
    `c.width = 40000` gives "Unable to set “width”. Value 40000 out of range 1 to 30000", and
    `addSolid` gives "Unable to call “addSolid” because of parameter 3. Value 40000 out of range 1
    to 30000". The width stayed 1920 and no layer was added.
  - Card Dance's match name is `APC CardDanceCam`, not `ADBE Card Dance`. It has 80 parameters:
    `APC CardDanceCam-` and 4 digits (not in list order), then "Compositing Options",
    `ADBE Effect Built In Params` (Gaussian Blur ends with it too). 12 of them have an empty name,
    the end of each topic (0027, 0037 … 0097, 0117, 0133, 0149, 0159). They took room in the
    children list and showed in "repeated:" as `""` with 12 numbers, a name no one can pass, so the
    helpers now leave them out of lists by name. `test/ae-host.ts` holds this layout; the change
    itself is unit-tested only, not re-run live.
  - Undo: after all the probes the Edit menu read "Undo Apply effect", the last call that
    succeeded. Calls that failed before changing anything (the lookups, the empty-group and
    effect-name misses, the width and `addSolid` range errors) left no undo entry; a call that
    fails after an earlier statement changed something keeps its one undo group (see the
    `ae_set_comp_props` note below). The display-name refusal note that
    `EFFECT_DISPLAY_NAMES_ACCEPTED = true` selects was not triggered live.
  - Follow-ups: a parameter typo gets no "did you mean" when the parameter is past the 20 names
    the list shows ("Light Intensty": Light Intensity is Card Dance's 69th), since suggestions rank
    only the names the host listed. The `app.effects` read took under 3 s (no slow-read line in the
    log; full read mode), but its count and time were not recorded: debug logging was off.
    Not AE-16, seen on the way: `ae_set_comp_props` sets its fields in order, so a name set before a
    width that fails stays until undone (one undo group; Ctrl-Z restores it).
- aerender reads the project **from disk**: `ae_render_comp` saves first, and needs a project
  that has been saved once (`ae_save_project` with a path).

## Tool inventory (24)
project_info · list_compositions · list_footage · get_comp · get_layer · open_project ·
save_project · import_footage · create_comp · add_layer · set_layer_props · duplicate_layer ·
delete_layer · set_keyframes · get_keyframes · remove_keyframes · set_expression ·
apply_effect · set_effect_param · set_text · add_marker · render_frame · queue_render ·
render_comp
