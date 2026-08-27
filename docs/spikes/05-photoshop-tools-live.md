# Photoshop tool set v1 — live run (2026-08-27, Windows, Photoshop 2026 v27.9.1)

Driven entirely from Claude Code through the hub and the Brainferno MCP Bridge panel:

1. `ps_create_document` 1080×1080 → id 66.
2. `ps_create_layer` "background" → `ps_fill` `#1e1e2e` (whole canvas, via batchPlay `fill`).
3. `ps_create_text_layer` "Brainferno", Arial-BoldMT 140 pt, `#f5a623` at (160, 600) → real bounds back.
4. `ps_duplicate_layer` → "glow"; `ps_apply_filter` gaussianBlur 24; `ps_set_layer_props` 70% screen.
5. `ps_get_preview` → image block (dark canvas, orange glowing title — matched intent).
6. `ps_save_document` → `.psd`; `ps_export` → `.png`. Both files on disk.
7. `ps_place_image` (a PNG from the Illustrator lane) → new smart-object layer.

## Gotchas found

- **A filter on a text layer makes Photoshop ask "convert to smart object / rasterize?"** — a
  modal that blocks every command (both queued tools timed out). The panel now rasterizes
  text and smart-object layers before a filter (`rasterizeLayer`, `dialogOptions: dontDisplay`).
  When the user clicks OK on that dialog, Photoshop converts to a smart object and the layer gets
  a **new id** — re-list layers after any dialog.
- **`/mcp` reconnect reuses a healthy server process.** After a rebuild, the old process keeps
  serving old code. Kill the process (its pid is in `~/.adobe-cc-mcp/bridge.json`) and reconnect;
  the port-fallback change makes a stale holder harmless either way.
- The panel's **kill switch** stops retries by design; after it, press Connect.
- Opacity reads back as 70.196… (Photoshop stores it in 8-bit).

## Tool inventory (18)
list_documents · list_layers · create_document · open_document · save_document · export ·
get_preview · create_layer · create_text_layer · set_layer_props · move_layer ·
duplicate_layer · delete_layer · place_image · fill · apply_filter · resize_image · crop
(+ `ps_batch_play` when `ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS=1`).
