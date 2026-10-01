---
id: AE-02
app: after-effects
title: Project items — delete, folders, move, rename, duplicate comp
priority: P1
status: open
evidence: verified
depends_on: []
---

# AE-02 — Project items: delete, folders, move, rename, duplicate comp

## Problem
A client that creates comps during automation cannot clean up or organize them.
- No tool deletes a composition, footage item, or folder. The only `.remove()` calls in `after-effects.ts` act on layers (line ~491) and the temporary preview comp (~847).
- No tool creates folders or moves items. A search for `addFolder`, `parentFolder`, and `FolderItem` in `after-effects.ts` finds nothing.
- Comps can be renamed through `ae_set_comp_props`, but footage and folders cannot.
- No tool duplicates a composition.
Result: scratch comps made while testing stayed in the project and had to be deleted by hand in the UI.

## Add
All take an item by `itemId` (integer id from `ae_list_compositions` / `ae_list_footage`) **or** `itemName` (exact; error with the list of matches if ambiguous). Name addressing is formalized in `AE-03`.
- **`ae_delete_item`** — inputs: `itemId`, `force` (boolean, default `false`). Without `force`, refuse when the item is used by other comps and list them (`item.usedIn`). `destructiveHint: true`.
- **`ae_create_folder`** — `name`, `parentFolderId` (optional, default project root). Returns the folder id.
- **`ae_move_item`** — `itemIds` (array), `folderId` (null = project root).
- **`ae_rename_item`** — `itemId`, `name`.
- **`ae_duplicate_comp`** — `compId`, `name` (optional; default "<name> copy"). Returns the new id and layer count.
- Annotations: all mutate (wrap in `__undo`); only delete is `destructiveHint`. `timeoutClass: "fast"`.

## API hints (ES3)
- `item.remove()`; `app.project.items.addFolder(name)`; `item.parentFolder = folderItem`; `comp.duplicate()`; `item.usedIn` (array of CompItem); `item.id`; `app.project.item(i)` is 1-based.
- Loop over `app.project.items` from the end when deleting.
- Refuse to delete a folder that still has children unless `force`.

## Acceptance tests
1. Create comp "A"; `ae_create_folder("F")`; `ae_move_item([A], F)`; the project tree shows A under F.
2. `ae_duplicate_comp(A)` returns a new id; both comps have the same layer count.
3. A comp used as a precomp in another comp: `ae_delete_item` refuses and names the parent; with `force: true` it deletes.
4. Each tool is one Ctrl-Z.
5. ES3 check, `__undo(` check, and an escaping sample with a quote in the name.
Add each builder to `SAMPLES` and the `__undo(` list (see `00_PREAMBLE.md`).

## Definition of done
See `00_PREAMBLE.md`.
