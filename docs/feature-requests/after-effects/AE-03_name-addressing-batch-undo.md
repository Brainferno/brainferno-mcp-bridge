---
id: AE-03
app: after-effects
title: Address layers and comps by name; ae_batch; ae_undo / ae_redo
priority: P1
status: in-review
evidence: verified
depends_on: []
---

# AE-03 — Name addressing, `ae_batch`, undo / redo

## Problem
Every layer tool takes `layerIndex`, and every comp tool takes a numeric `compId`.
- New layers are added **at the top**, so each add shifts every existing index. A client building a 10-layer comp must track indexes by hand, and one mistake edits the wrong layer. Observed: an expression meant for a text layer was sent to a layer index that had just become a shape layer, and failed with `Property path not found at ADBE Text Properties`.
- A client building six comps made roughly 700 tool calls, most of them one property each.
- Parallel calls ran in submission order, but nothing guarantees that.

## Add
1. **Name addressing on every layer tool.** Accept `layerName` (exact) **or** `layerIndex`. If the name matches more than one layer, fail with the list of matching indexes. Accept `compName` as well as `compId` (same rule). Implement once in the shared helpers (`__comp` and `__layer` in `HELPERS`, `after-effects.ts`) so every After Effects tool gets it. Note: zod raw shapes cannot express "one of"; validate in the helper and say so in `.describe()`.
2. **`ae_find_layers`** — inputs: `compId`/`compName`; `nameContains`, `kind` (text|shape|solid|null|precomp|footage|adjustment), `textContains`, `enabled` (all optional). Returns `[{ index, name, kind, enabled }]`. `readOnlyHint: true`.
3. **`ae_batch`** — `operations: [{ tool, args }]` (tool names limited to `ae_*` mutating tools), `atomic` (default `true`). Runs the whole list in **one panel eval and one undo group**. Returns `{ results: [...], nameToIndex: { "<layer name>": index } }`. On the first failure: stop, report the failing operation's position and message, and (if `atomic`) undo the group.
   - Build the script by concatenating the per-tool script bodies the tools already export; do not duplicate logic.
4. **`ae_undo` / `ae_redo`** — run the app's own Edit > Undo / Redo. Look the command id up with `app.findMenuCommandId("Undo")` instead of hard-coding it, then `app.executeCommand(id)`. `destructiveHint: true`.

**AE-16 groundwork.** `__comp(id)` / `__layer(comp, index, role)` failures already list their candidates (`__compList`, `__layerList`, `__layerLabel` = `3 "Logo" (shape)`), cut by length (`__BUDGET`). For names, let each helper take one argument that is a number (id/index) or a string (exact name) — builders emit `num()` or `lit()`, so `__layer(c, 1)` stays byte-identical — and add: `No layer named "Titel" in "Main" (id 12): 1 "Title" (text), … — names match exactly, case included; pass one of these names or its layerIndex.` / `The name "dup" matches 2 layers in "Main" (id 12): 2 "dup" (text), 5 "dup" (shape) — pass layerIndex to pick one.` (and the same pair for comps). Check "exactly one of layerIndex / layerName" on the server before dispatch. Resolve every lookup before the undo group opens (as AE-16 does for `parentIndex` and footage `itemId`). **`ae_batch`**: one script holds N body segments, so `locateAeError` (one prelude, one body) does not apply as is: record each operation's first script line and line count while assembling (after `asciiSource`, which never changes line counts), map a reported line with the same rules (helper range → helper name; guard, line 1, between segments, after the end → outside), take the failing operation from a runtime cursor (`__at`), not from the line, run each operation's enrichment in `runAsToolCall({tool, args})` and echo only that operation's args. (The prelude starts with the host-line guard, `HOST_LINE_GUARD`; its size is `AE_PRELUDE_LINES`.)

## Acceptance tests
1. Add three layers named A, B, C; `ae_set_layer_props({ layerName: "B", opacity: 50 })` changes B only, regardless of order.
2. Two layers named "dup": a name-addressed call fails and lists both indexes.
3. `ae_find_layers({ kind: "text" })` returns only text layers.
4. `ae_batch` with 5 operations → one Ctrl-Z removes everything; `nameToIndex` is correct.
5. `ae_batch` with a bad 3rd operation and `atomic: true` leaves the comp unchanged.
6. `ae_undo` reverses the last tool call; `ae_redo` restores it.
7. Existing index-based calls still work (no breaking change).
Follow the test pattern in `00_PREAMBLE.md`.

## Definition of done
See `00_PREAMBLE.md`. Update every tool's `.describe()` for the new parameters.
