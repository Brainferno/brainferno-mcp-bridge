# Spike: Adobe Illustrator (Beta) built-in MCP — live tool inventory

Date: 2026-08-26. Machine: Windows 11. Illustrator (Beta) MCP at `http://localhost:18412/v1/mcp`.
Probed with our delegate (`src/drivers/illustrator-delegate.ts`). Status: **reachable**, **46 tools**.

## Correction to earlier research

Earlier research said Adobe’s server was analyze/batch/export only. The live list shows more:
- **Can:** create documents, artboards, layers, groups, clipping masks; open/switch documents; move/scale/rotate/align/distribute/arrange objects; set appearance (fill, stroke, opacity); replace text and fonts; export; capture a PNG preview; vectorize; preflight.
- **Cannot (no tool for it):** draw new shapes, paths, or text frames; save a `.ai`; run a script.
- So our os-script lane is still needed for drawing new art and saving. The two lanes compose.

## Tools (46)

| Tool | Description |
|---|---|
| `AlignObjects` | Aligns one or more objects along a specified edge or center axis. Objects can be aligned relative to each other (selection bounding box) or to the active artboard. Alignment is single-axis: 'left'/'center'/'right' shift  |
| `DistributeObjects` | Distributes objects evenly along an axis. If spacing is provided, objects are placed with that exact gap between them. If spacing is omitted, objects are distributed evenly within the total span from first to last. Prefe |
| `SetAppearance` | Sets visual appearance and state properties (fill, stroke, opacity, blend mode, locked, hidden, overprint) on one or more objects in a single call. All properties are optional — only provided properties are changed. To r |
| `ListArtboards` | Get details of all artboards including name, locked state, bounds, and valid canvas bounds. Coordinates are canvas-global in points with Y-down. Returns canvas_bounds defining the valid coordinate range. |
| `CreateArtboard` | Add a new artboard to the current document. This is the default way to get a new canvas at a different size (book cover, poster, social variant, print format) — an Illustrator document can hold many artboards at differen |
| `SetArtboardProperties` | Sets one or more properties of an artboard atomically in a single update. Resolves the target artboard by artboardIndex, then artboardName, then falls back to the active artboard. newName: rename the artboard. background |
| `DuplicateArtboard` | Duplicate an existing artboard at a new position with optional new name. If no name is provided, generates a unique name automatically. Coordinates are canvas-global in points with Y-down. |
| `GetActiveArtboard` | Get details of the currently active artboard. Returns index, name, locked state, and bounds [left, top, right, bottom] in Y-down points. Derive width = right - left, height = bottom - top for proportional positioning (e. |
| `ScaleArtboards` | Scale or resize artboards. Do NOT use this tool for named preset requests like 'iPhone X', 'A4', 'Instagram Story', 'HDV/HDTV 720' — call GetArtboardProperties to look up dim1_pt/dim2_pt, decide which to use as width/hei |
| `FitArtboard` | Resize an artboard's bounds to tightly enclose artwork — does NOT change the viewport or zoom level. The 'scope' parameter controls which artwork is considered: 'artboard' (default) fits to any artwork whose bounds inter |
| `DeleteArtboard` | Remove an artboard from the document. By default the artwork on the artboard is preserved; set removeContent=true ONLY when the user explicitly asks to delete the artwork too. Returns the updated artboard list with new i |
| `SetActiveArtboard` | Set a specific artboard as active and selected. Locked or hidden artboards become active but may not be selected. |
| `MoveArtboards` | Reposition multiple artboards in a single batch operation. Artwork on each artboard moves with it by default (moveContent=true). This tool snapshots art-to-artboard associations before any moves, so artboards can safely  |
| `GetArtboardProperties` | Look up artboard presets available in Illustrator (Print, Web, Video, Social, Branding, Mobile). Each preset reports dim1_pt and dim2_pt — the raw values returned by the Illustrator preset table. Mobile preset dimensions |
| `GetCanvasStructure` | Browse the document's layer hierarchy. Returns objects_basic_details array with basic details per node: uuid, name, object_type, bounds (when present), child_count, child_types, locked (when true), hidden (when true) — b |
| `GetArtboardStructure` | Get all objects visually overlapping an artboard, regardless of which layer they belong to. Returns artboard_details (index, bounds) and objects_basic_details array in z-order (0=frontmost/top). To browse by layer hierar |
| `VisualizeSelection` | Get the selection roots (the objects the user actually selected, not descendants of an already-selected parent), in z-order (0=frontmost/top). Returns objects_basic_details array; each entry has uuid, name, object_type,  |
| `CreateDocument` | Create a new, separate Illustrator file. Most tasks do NOT need one — an Illustrator document holds many artboards at different sizes, and keeping variants (book cover, poster, social sizes, print formats) in one file le |
| `OpenDocument` | Opens an existing file in Illustrator. Returns document metadata and artboard details so you can immediately start working. The previously active document remains open and can be switched back to with SwitchDocument. |
| `ListDocuments` | Lists all open documents with metadata. The active document includes full details: colorMode, units, artboardCount, bleedInsets, rasterEffectsResolution, colorProfiles, width, height, document_profile (Print/Web/Video/Mo |
| `SwitchDocument` | Switches the active document by index, name, or file path. Returns full document metadata and artboard details for the newly active document. Use ListDocuments first to see available documents. Provide exactly one of: in |
| `Export` | Exports artwork to a file, returns it as a stream, or uploads it to an Adobe-hosted URL. Supports raster formats (PNG, JPEG, TIFF, PSD, WEBP, BMP), vector formats (SVG, PDF, EPS, DWG, DXF), and native Illustrator format  |
| `CapturePreview` | Captures artwork as a PNG file for visual inspection. Returns a preview_path field with the file location — read that file to view the image. For permanent file exports (PNG/JPEG/SVG/PDF), use Export instead. Use this to |
| `Vectorize` | Traces a raster or placed image into vectors with Image Trace, or expands an existing live Image Trace into a final vector group. Before tracing, determine what the image actually is — its content is NOT in the object me |
| `CreateLayer` | Creates a new layer with the specified name. Position defaults to front (top) of the layer stack. Use parentID to create a sublayer inside an existing layer. For 'above:<uuid>' or 'below:<uuid>', the new layer is created |
| `GetVisualAppearance` | Get detailed visual appearance properties for one or more objects. Response format: {success, details, visual_appearance: [{uuid, properties: {fill_stack, stroke_stack, has_fill, has_stroke, opacity, blend_mode, graphic_ |
| `GetGeometry` | Get detailed geometry properties for one or more path/shape objects. Response format: {success, details, geometry_refinement: [{uuid, properties: {transformation_matrix?, is_proportionally_scaled?, path_topology}}, ...]} |
| `GetTypographyMetrics` | Get detailed typography properties for one or more text objects including text content, length, and overflow status. Use this to read text content and character indices. Response format: {success, details, typography_met |
| `GetObjectStructure` | Get recursive structure for one or more objects (including layers). Returns 'structures' array. Each entry: uuid, name, object_type, bounds, locked (when true), hidden (when true) — both inherited from ancestors. Bounds  |
| `GetBounds` | Get bounds for one or more objects. Returns visual bounds that include live effect expansion (e.g. a Gaussian blur with radius=20 expands bounds ~36pt per side). Empty groups/layers have no bounds and are reported in fai |
| `CleanupPath` | Cleans up messy or hand-drawn paths by reducing anchor points and/or smoothing jaggedness. This EDITS geometry — it approximates the original shape within a tolerance, it does not preserve it exactly. Higher curvePrecisi |
| `RunPreflightChecks` | Single-traversal production QA inspection of the active document. Walks the art tree once and returns a categorized JSON report of findings aggregated by issue tag, each with a display_name, count, and affected_objects[] |
| `RenameObject` | Rename one or more objects (including layers). IMPORTANT: Parameters are arrays, even for a single object. Example: uuids=['123'], newNames=['MyShape']. For batch: uuids=['123','456'], newNames=['Shape1','Shape2']. Array |
| `SelectObjects` | Select or deselect one or more art objects by UUID in Adobe Illustrator. Supports batch selection. Set select=false to deselect instead. BATCH PROCESSING: When selecting/deselecting multiple objects, pass array of UUIDs  |
| `DeleteObjects` | Removes one or more objects (including layers) from the canvas by their UUIDs. When deleting layers, or when the UUIDs come from an earlier turn rather than a tool call in the current turn, call GetCanvasStructure first  |
| `DuplicateObjects` | Creates copies of one or more objects by their UUIDs with optional positional offset. Offsets are in points with Y-down (positive offsetY moves down). Response format: {success, details, uuids: [new_copy_uuids], parent_n |
| `CreateGroup` | Create a new empty group. Returns `uuid` of the created group. Position defaults to top of the layer stack (frontmost). IMPORTANT: Each new group is placed at the front, so creating multiple groups without explicit posit |
| `MoveObjectsToContainer` | Relocates one or more objects into a new parent container at a specified position. Objects are always placed in their current visual z-order (front-to-back stacking from the artwork), regardless of the array order provid |
| `CreateClippingMask` | Creates a clipping mask group. The maskUuid object becomes the clipping path (defines the visible area). The clipUuids objects are the content that gets clipped. All objects are moved into a new group, with the clipping  |
| `ArrangeArt` | Changes the z-order (stacking order) of objects within their current layer or group. When applied to a top-level layer UUID, reorders that layer in the document's layer stack. Operations: 'bring_to_front' moves to top wi |
| `GetSwatches` | Read available swatches from the active document's Swatches panel or any swatch library. Use whenever a swatch's name, group, or color is needed. Defaults to 'Document Swatches'; pass swatchLibraryName for a preset libra |
| `ReplaceText` | Style-preserving find and replace within a text frame. Replaced text inherits the original character styles. Occurrences using missing/substituted fonts, embedded glyph-subset fonts, or spanning mixed character styles ar |
| `ReplaceFont` | Find every occurrence of one font in the active document and replace it with another, leaving other fonts in mixed-font text frames untouched. Operates document-wide. 'findFontFamily'/'findFontStyle' match only what's ac |
| `MoveObjects` | Move or place one or more art objects. x and y are each optional; omit one to leave that axis unchanged. TWO MODES: (1) 'relative' (default): x/y are shift distances added to every object. Example: x=50, y=0 nudges objec |
| `RotateObjects` | Rotate one or more art objects by a specified angle in degrees around the center of their combined bounding box. Example: angle=90 rotates 90 degrees counterclockwise, angle=-45 rotates 45 degrees clockwise. |
| `ScaleObjects` | Scale one or more art objects around the center of their combined bounding box, preserving relative positions. TWO MODES: (1) 'factor' (default): sx/sy are multipliers (sx=2 doubles, sx=0.5 halves, sx=1 is no change). (2 |

Full schemas: call `ai_beta_list_tools` / `ai_beta_call` locally; names and inputs are Adobe’s and may change between Beta builds.
