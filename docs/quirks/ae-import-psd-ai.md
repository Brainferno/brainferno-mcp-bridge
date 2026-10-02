# Importing layered PSD / AI into After Effects

How `ae_import_as_comp` brings layered Photoshop and Illustrator files in as compositions.

`ae_import_as_comp(path, cropped?)` imports a layered `.psd` or `.ai` as a composition via
`ImportOptions.importAs = ImportAsType.COMP` (or `COMP_CROPPED_LAYERS` when `cropped:true`).
`importFile` returns the CompItem; the tool guards with `instanceof CompItem` and throws a
clear message for a flat/single-layer file instead of silently returning footage.

Verified live on AE 26.3:

- **PSD** — each Photoshop layer becomes its own AE layer, and **layer styles come in
  editable** (no ImportOptions flag needed — AE's default is editable, not merged). A box
  with a drop shadow imported with the drop shadow as an editable AE layer style holding the
  exact values (opacity 70, distance 12, size 15), readable with `ae_get_layer_styles`. So
  the whole Photoshop → After Effects layer-style pipeline round-trips.
- **AI** — imports as a comp with vector content intact, but AE maps **top-level Illustrator
  LAYERS** to AE layers, NOT individual objects. Two shapes on Illustrator's single default
  layer came in as ONE AE layer. For separate AE layers the objects must be on separate
  Illustrator layers (Release to Layers). The `.ai` must be RGB (not CMYK) and saved
  PDF-compatible (a native `.ai` save is PDF-compatible by default).

Related: `ae-layer-styles.md` (the same ADBE Layer Styles the import brings in).
