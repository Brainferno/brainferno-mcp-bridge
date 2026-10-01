---
id: AU-02
app: audition
title: Apply effects with parameters; create favorites
priority: P2
status: open
evidence: unverified
depends_on: []
---

# AU-02 — Effects with parameters, and favorites

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/audition.ts` (`au_apply_favorite`, `au_invoke_command`) and `docs/spikes/08-audition-tools-live.md`. Audition's scripting API is undocumented; probe with `au_api_dump` first.

## Problem
Effects can be applied only in two ways.
- **`au_apply_favorite`** applies a **named, pre-existing Favorite**.
- **`au_invoke_command`** runs a menu command; many effect commands open a dialog and need a human.
So a client cannot apply an effect with chosen parameters (for example a specific EQ band, a compression ratio, a noise-reduction amount), and cannot create the Favorite it needs.

## Add (only for what the DOM supports)
- **`au_list_effects`** — `query?`, `limit`; returns `[{ id, name, category }]`. `readOnlyHint: true`.
- **`au_apply_effect`** — `effectId|name`, `params` (object of name → value), `scope`: `selection | clip | track | wholeFile`, `trackId?`/`clipId?`. Must not open a dialog; if only a dialog route exists, return an error that says so.
- **`au_create_favorite`** — `name`, `effectId`, `params`. Writes a Favorite that `au_apply_favorite` can then use.
- **`au_list_favorites`** — names, effect ids. `readOnlyHint: true`.
- Make long processing (noise reduction, normalization of a long file) report progress or run as a job via `runOrQueue`.

## API hints
- Use `au_api_dump` and the checked-in dump (`docs/api-dumps/audition-26.3.json`) to find effect-application calls and parameter objects.
- Favorites are stored in the app's preferences/support files; creating one may be possible by writing the preset XML — verify before relying on it, and record the finding in the spike doc.
- Where a dialog cannot be avoided, document the command id and let `X-02` surface a clear "dialog open" error.

## Acceptance tests
1. `au_apply_effect` with explicit parameters changes a test tone's level or spectrum as expected (`audio_measure_loudness` before and after).
2. `au_create_favorite` then `au_apply_favorite` gives the same result as step 1.
3. `au_list_effects({ query: "reverb" })` returns usable ids.
4. A dialog-only effect returns an actionable error, not a hang.
5. ES3 check; not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`.
