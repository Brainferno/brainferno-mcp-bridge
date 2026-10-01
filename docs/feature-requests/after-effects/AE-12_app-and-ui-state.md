---
id: AE-12
app: after-effects
title: App and UI state — active comp, selection, current time, open comp in viewer
priority: P2
status: open
evidence: verified
depends_on: [AE-03]
---

# AE-12 — App and UI state

## Problem
A client cannot see what the operator is looking at.
- `ae_project_info` returns the project path, item count, bit depth, and dirty flag only. It does not say which comp is active.
- Every comp tool needs a `compId`, and nothing says which comp the operator has open.
- Nothing reads the layer selection, selected properties, or the current time indicator; nothing selects layers or opens a comp in the viewer.
- Operators often say "the layer I have selected" or "the comp I'm in"; the client must ask or guess.

## Add
- **`ae_get_app_state`** — no inputs. Returns `{ version, language, projectPath, dirty, activeItem: { id, name, kind }|null, activeComp: { id, name, time, workAreaStart, workAreaDuration }|null, selectedLayers: [{ index, name, kind }], selectedProperties: [{ layerIndex, path, name }] }`. `readOnlyHint: true`, `timeoutClass: "fast"`.
- **`ae_open_comp`** — `compId|compName`; opens it in the viewer and makes it active.
- **`ae_set_current_time`** — `compId|compName` (default active comp), `seconds`.
- **`ae_select_layers`** — `compId|compName`, `layers` (names/indexes), `mode` (`"replace"` default | `"add"` | `"clear"`).
- Optional **`ae_get_selected_keyframes`** if the API allows (see hints); otherwise document the limit.

## API hints (ES3)
- `app.version`, `app.isoLanguage`, `app.project.activeItem` (a `CompItem` when a comp or timeline is focused, else a footage item or `null`), `app.project.file`, `app.project.dirty` (as `ae_project_info` already does).
- `comp.selectedLayers` (array), `comp.selectedProperties` (array of `Property`; use `prop.propertyGroup(...)` or `prop.matchName`/`prop.name` to build a path), `comp.time`, `comp.workAreaStart`, `comp.workAreaDuration`.
- `comp.openInViewer()`; `layer.selected = true`.
- Layer kind: `instanceof TextLayer` is **false** in AE 26.3 (`docs/spikes/06-…`), so derive kind from `matchName` as the existing `__layerInfo` does.
- Selected keyframes are not exposed by the scripting API on all versions: check `prop.selectedKeys` and fall back to "not available".

## Acceptance tests
1. With a comp open and two layers selected, `ae_get_app_state` returns that comp and both layers.
2. `ae_open_comp` changes `activeComp`; `ae_set_current_time` changes `activeComp.time`.
3. `ae_select_layers({ mode: "add" })` extends the selection.
4. With no project open it returns a clear "No project is open" error, consistent with the other tools.
5. ES3 check.

## Definition of done
See `00_PREAMBLE.md`. (Detecting an open modal dialog belongs to `X-02`.)
