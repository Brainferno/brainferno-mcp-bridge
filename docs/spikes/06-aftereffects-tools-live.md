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
- Same restart discipline as Photoshop: after a rebuild, kill the server pid from
  `~/.adobe-cc-mcp/bridge.json`, then `/mcp` reconnect. The CEP panel reconnects on its own.
- aerender reads the project **from disk**: `ae_render_comp` saves first, and needs a project
  that has been saved once (`ae_save_project` with a path).

## Tool inventory (24)
project_info · list_compositions · list_footage · get_comp · get_layer · open_project ·
save_project · import_footage · create_comp · add_layer · set_layer_props · duplicate_layer ·
delete_layer · set_keyframes · get_keyframes · remove_keyframes · set_expression ·
apply_effect · set_effect_param · set_text · add_marker · render_frame · queue_render ·
render_comp
