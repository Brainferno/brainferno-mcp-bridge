---
id: AE-06
app: after-effects
title: Keyframe interpolation — hold, linear, bezier, ease speed and influence, tangents
priority: P1
status: open
evidence: verified
depends_on: []
---

# AE-06 — Keyframe interpolation control

## Problem
`ae_set_keyframes` accepts keys as `{ time, value, easy? }` (`after-effects.ts:1299`). `easy: true` applies `new KeyframeEase(0, 33.3333)` to both sides of the key (`:515-520`). Nothing else is controllable:
- **No hold (stepped) keys.** A client needing values that step (a counter, a text index) faked hold with two keys one frame apart, or used an expression.
- **No ease-out-only or ease-in-only.** Only symmetric Easy Ease.
- **No speed or influence**, no linear or bezier choice per side, no spatial tangents for motion paths.
- `ae_get_keyframes` returns `{ time, value }` only, so a client cannot read back what interpolation a key has.

## Add
- Extend each key in `ae_set_keyframes` with optional fields (keep `easy` working):
  - `interpolation`: `"linear" | "bezier" | "hold"` — applies to both sides.
  - `inInterpolation`, `outInterpolation`: same enum, per side.
  - `easeIn`, `easeOut`: `{ speed, influence }` (influence 0.1–100). For non-spatial properties accept an array with one entry per dimension; for spatial properties (position) one entry.
  - `preset`: `"easeIn" | "easeOut" | "easeInOut" | "linear" | "hold"` as shorthand for common curves.
  - `spatial`: `{ inTangent: [x,y,(z)], outTangent: [x,y,(z)] }` for position paths.
  - `roving`: boolean.
- Extend `ae_get_keyframes` so each key also returns `inInterpolation`, `outInterpolation`, `easeIn`, `easeOut`, `spatial`, `roving`.
- Validate: `hold` needs both sides set to hold; influence range; array length equals the property's dimension count.

## API hints (ES3)
- `prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD)`; also `LINEAR`, `BEZIER`.
- `prop.setTemporalEaseAtKey(i, [new KeyframeEase(speed, influence)], [...])`. Per `docs/spikes/06-…`: a **spatial** property takes **one** `KeyframeEase`; non-spatial properties take one per dimension.
- `prop.setSpatialTangentsAtKey(i, inTangent, outTangent)`; `prop.setRovingAtKey(i, bool)`; read with `keyInInterpolationType`, `keyOutInterpolationType`, `keyInTemporalEase`, `keyOutTemporalEase`, `keyInSpatialTangent`, `keyOutSpatialTangent`.
- Set interpolation types **before** ease values; ease on a linear key has no effect.

## Acceptance tests
1. Three `hold` keys on a slider: reading the value at times between keys returns the previous key's value (no ramp).
2. `preset: "easeOut"` on key 2 only: key 1 stays linear on its out side; read back confirms it.
3. Position keys with `spatial` tangents produce a curved path (read tangents back).
4. `easy: true` still behaves as before.
5. Bad influence (`0`) or wrong array length returns an actionable error.
6. ES3 check; `__undo(` check.

## Definition of done
See `00_PREAMBLE.md`.
