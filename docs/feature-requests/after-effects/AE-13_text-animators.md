---
id: AE-13
app: after-effects
title: Text animators — range selector, per-character properties, typewriter helper
priority: P3
status: open
evidence: verified
depends_on: [AE-05, AE-06]
---

# AE-13 — Text animators

## Problem
No tool can add a text animator. Character-by-character effects (a typewriter reveal, per-character tracking or opacity) were therefore built with a Source Text expression driven by a slider, which works but is not editable as a normal After Effects text animation, and cannot use the Range Selector's shape, smoothness, or randomize.
- `ae_set_keyframes` can key a property that **already exists** (for example `ADBE Text Percent Start` once an animator is present), but nothing creates the animator or selector.
- `ae_set_text` has no way to reach `layer.Text.Animators`.

## Add
- **`ae_add_text_animator`** — layer args, `name` (optional), `properties` (any of `opacity`, `position`, `scale`, `rotation`, `tracking`, `fillColor`, `strokeColor`, `blur`, `lineAnchor`; value per property), and `range`: `{ start, end, offset, units: "percentage"|"index", basedOn: "characters"|"charactersExcludingSpaces"|"words"|"lines", mode, shape, smoothness, easeHigh, easeLow, randomize }`. Returns the animator index and the property paths of `start`, `end`, `offset` so the client can key them with `ae_set_keyframes`.
- **`ae_add_typewriter`** (convenience): layer args, `charsPerSecond` or `duration`, `startTime`; builds an Opacity-0 animator with a Range Selector keyed over the text length. Returns the property paths.
- **`ae_list_text_animators`**: names, selectors, and animated properties (for `ae_get_property_tree`, `AE-05`).

## API hints (ES3)
- `layer.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator")`.
- Selector: `animator.property("ADBE Text Selectors").addProperty("ADBE Text Selector")`; its params: `ADBE Text Percent Start`, `ADBE Text Percent End`, `ADBE Text Percent Offset`, `ADBE Text Index Start`, `ADBE Text Index End`, `ADBE Text Range Units`, `ADBE Text Range Type2`, `ADBE Text Selector Mode`, `ADBE Text Range Shape`, `ADBE Text Selector Smoothness`, `ADBE Text Levels Max Ease`, `ADBE Text Levels Min Ease`, `ADBE Text Randomize Order`.
- Animator properties: `animator.property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity")` (also `ADBE Text Position 3D`, `ADBE Text Scale 3D`, `ADBE Text Rotation`, `ADBE Text Tracking Amount`, `ADBE Text Fill Color`, `ADBE Text Stroke Color`, `ADBE Text Blur`).
- Verify these match names against the running AE with `ae_get_property_tree` (`AE-05`); they vary slightly between versions.

## Acceptance tests
1. A text layer "HELLO" with `ae_add_typewriter({ duration: 1 })` reveals letters over 1 s (render frames at 0.2 s and 1.0 s).
2. `ae_add_text_animator` with `tracking: 20` and an offset range animates tracking; the returned paths accept keyframes.
3. The animator appears in `ae_list_text_animators`.
4. ES3 check; `__undo(` check.

## Definition of done
See `00_PREAMBLE.md`.
