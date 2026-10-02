# After Effects shape layers and masks (scripting)

How `ae_add_shape` and `ae_add_mask` build shape layers and masks. Solids and text
layers were already covered by `ae_add_layer` (kind solid/text), so only shapes and
masks were new.

**Shape layers** — `comp.layers.addShape()` makes an "ADBE Vector Layer". The vector tree:
`layer.property("ADBE Root Vectors Group")` (Contents) → `.addProperty("ADBE Vector Group")`
→ that group's `.property("ADBE Vectors Group")` holds the shape + fill + stroke. Shapes:
`ADBE Vector Shape - Rect` (size `ADBE Vector Rect Size` [w,h], `ADBE Vector Rect Roundness`),
`ADBE Vector Shape - Ellipse` (`ADBE Vector Ellipse Size`), `ADBE Vector Shape - Star`
(`ADBE Vector Star Type` 1=star/2=polygon, `... Points`, `... Outer Radius`, `... Inner Radius`).
Fill = `ADBE Vector Graphic - Fill` → `ADBE Vector Fill Color` ([r,g,b] 0-1); stroke =
`ADBE Vector Graphic - Stroke` → `ADBE Vector Stroke Color` + `ADBE Vector Stroke Width`. Add
fill THEN stroke (stroke draws on top). Position the whole layer via its Transform > Position;
a new shape layer defaults to the comp centre with anchor [0,0], so the shape sits at the
layer position — don't move the group.

**Masks** — `layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom")`. Set the shape
with a `Shape` object: rectangle = 4 vertices closed, zero tangents; ellipse = 4 vertices
[top, left, bottom, right] closed with 0.5522847498·radius bezier handles (in/out tangents per
the docsforadobe oval example). `mask.property("ADBE Mask Shape").setValue(shape)`,
`mask.maskMode = MaskMode.ADD` (SUBTRACT / INTERSECT / LIGHTEN / DARKEN / DIFFERENCE / NONE),
feather `ADBE Mask Feather` ([x,y]), opacity `ADBE Mask Opacity` (%), expansion
`ADBE Mask Offset` (px). Mask coords are LAYER-relative; the tool defaults bounds to the comp size.

Both verified live via the probe rig (see `ae-layer-styles.md` for the rig trick) and rendered
with `saveFrameToPng`. Match names came from the After Effects Scripting Guide shape-layer and
Shape-object pages.
