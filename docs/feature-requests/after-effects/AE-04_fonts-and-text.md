---
id: AE-04
app: after-effects
title: Fonts and text — font list, resolve feedback, missing-font audit, text style fields
priority: P1
status: open
evidence: verified
depends_on: []
---

# AE-04 — Fonts and text

## Problem
1. **Unknown font names silently fall back.** `ae_set_text({ font: "<bad name>" })` succeeds, and the text renders in a default serif font. Only a rendered preview shows it.
2. **No way to find the right name.** A variable font's Medium instance resolved only as `JetBrainsMonoRoman-Medium`. `JetBrainsMono-Regular` worked, `JetBrainsMono-Medium`, `JetBrainsMono-Bold`, and `JetBrainsMono-Regular_Medium` did not, and a name containing a space fails with `Unable to set "font". Contains invalid character`. The name was found by trial and error. An Adobe Fonts family also resolves by PostScript name (for example `<Family>-Regular`).
3. **Reopening a project can ask for a missing font.** A text layer left with an invalid font name caused a missing-font prompt on reopen. No tool can list fonts used by text layers or find missing ones.
4. **Text style is mostly unreachable.** `ae_set_text` can set only `text`, `fontSize`, `font`, `color`, and `anchor` (`after-effects.ts:786-795`, `805-816`). `ae_add_layer kind="text"` takes only `name`, `text`, `anchor` (`1134-1147`); `color` there applies only to solids (`297`, `308`). No tracking, leading, faux bold, all caps, stroke, box size, or position. Setting a styled text layer needs 3 calls (`ae_add_layer`, `ae_set_text`, `ae_set_layer_props`).
5. **`ae_get_layer` returns only the text string** for a text layer (`after-effects.ts:170`) — no font, size, color, or justification.
6. **Center justification is unreliable.** `justification: "center"` maps to `ParagraphJustification.CENTER_JUSTIFY` (`after-effects.ts:809-810`), but in After Effects 26.x point text does not center on the anchor (`docs/spikes/06-…:25-27`). The workaround, `__centerAnchor` (`82-85`, applied at `816`), sets the anchor **once** from `sourceRectAtTime(0,false)`. It is skipped with `anchor:"origin"`, and it goes stale when the text changes later (expression-driven or re-edited text). Observed: with `justification:"center"` the rendered text ended at the anchor (right-aligned look); `left` and `right` behaved correctly. Workaround that worked: `justification:"left"` plus an Anchor Point expression `var r=thisLayer.sourceRectAtTime(time,false);[r.left+r.width/2, <y>]`.

## Add
- **`ae_list_fonts`** — `query` (substring over family / style / PostScript name, optional), `limit` (default 50). Returns `[{ postScriptName, familyName, styleName, isSubstitute }]`. Include variable-font named instances if the API exposes them. `readOnlyHint: true`.
- **`ae_set_text` result** gains `fontApplied` (the PostScript name read back), `fontResolved` (boolean), `fontSubstituted` (boolean), and, when unresolved, `suggestions` (closest matches by family). Optionally add `strictFont` (default `false`) that throws instead of falling back.
- **`ae_get_text_info`** — `compId|compName`, `layerIndex|layerName`, `time` (default 0). Returns text, font, fontSize, fillColor, applyFill, strokeColor, strokeWidth, applyStroke, justification, tracking, leading, autoLeading, fauxBold, fauxItalic, allCaps, smallCaps, baselineShift, horizontalScale, verticalScale, boxText, boxTextSize.
- **Style fields on `ae_set_text` and `ae_add_layer kind="text"`** (all optional, state defaults): `tracking` (1/1000 em), `leading`, `autoLeading`, `fauxBold`, `fauxItalic`, `allCaps`, `smallCaps`, `baselineShift`, `horizontalScale`, `verticalScale`, `strokeColor`, `strokeWidth`, `applyStroke`, `boxSize` ([w,h] for paragraph text), `position`, `justification` (add full-justify values). `ae_add_layer` also gains `font`, `fontSize`, `color`.
- **`ae_list_missing_fonts`** — no inputs. Walks every comp's text layers; returns `[{ comp, layer, font, isSubstitute }]` for fonts that are missing or substituted.
- **`anchor: "center-dynamic"`** on `ae_set_text`: write an Anchor Point expression that re-centers on `sourceRectAtTime(time,false)` each frame, so text that changes keeps its center. Document that vertical centering uses the first-call rect.

## API hints (ES3)
- `app.fonts.allFonts` (array of arrays of `Font`: `postScriptName`, `familyName`, `styleName`, `isSubstitute`); `app.fonts.getFontsByPostScriptName(ps)`.
- `TextDocument`: `font`, `fontObject`, `fontSize`, `fillColor`, `applyFill`, `strokeColor`, `strokeWidth`, `applyStroke`, `tracking`, `leading`, `autoLeading`, `fauxBold`, `fauxItalic`, `allCaps`, `smallCaps`, `baselineShift`, `horizontalScale`, `verticalScale`, `justification`, `boxText`, `boxTextSize`, `boxTextPos`.
- Set a `TextDocument` back with `prop.setValue(td)`. Read `td.fontObject` after setting to learn what was actually applied.
- Reading `boxTextSize` / `boxTextPos` on **point** text throws `Text document not of Box document type` — guard with `td.boxText` first (see `AE-05`).

## Acceptance tests
1. `ae_list_fonts({ query: "mono" })` returns PostScript names; one of them works in `ae_set_text`.
2. `ae_set_text({ font: "NotARealFont-Regular" })` returns `fontResolved: false` and `suggestions`.
3. `ae_add_layer({ kind: "text", text: "A", font, fontSize: 40, color: "#ff8800", position: [100, 200], justification: "center" })` creates a styled layer in **one** call.
4. `ae_get_text_info` round-trips every field set above.
5. A text layer with an invalid font appears in `ae_list_missing_fonts`.
6. `anchor: "center-dynamic"`: a layer whose text grows keeps its visual center (render two frames and compare the ink bounds' center).
7. ES3 check, `__undo(` check, escaping sample with a quote in the text.

## Definition of done
See `00_PREAMBLE.md`. Add a line to `docs/spikes/06-aftereffects-tools-live.md` about variable-font instance names.
