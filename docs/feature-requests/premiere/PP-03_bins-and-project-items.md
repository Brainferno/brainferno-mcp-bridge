---
id: PP-03
app: premiere
title: Bins and project-item management — create, move, rename, delete, subclip, relink
priority: P2
status: open
evidence: unverified
depends_on: []
---

# PP-03 — Bins and project items

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/premiere.ts` (`pp_list_project_items`, `pp_import_files`) and the absence of any bin or item-management tool. Check the `premierepro` UXP API (`ProjectItem`, `FolderItem`) first.

## Problem
`pp_import_files` can bring media in and `pp_list_project_items` can list it, but the project cannot be organized or cleaned up afterwards.
- No bin (folder) creation, moving items between bins, renaming, or deleting project items.
- No subclips, and no relinking of offline media.
- A client importing a batch of media cannot sort it into bins or remove a bad import, so the operator has to do it by hand.

## Add
- **`pp_create_bin`** — `name`, `parentBinId` (default project root). Returns the bin id.
- **`pp_move_project_items`** — `projectItemIds` (array), `binId` (null = root).
- **`pp_rename_project_item`** — `projectItemId`, `name`.
- **`pp_delete_project_items`** — `projectItemIds`, `force` (default `false`; refuse when items are used in a sequence and list them). `destructiveHint: true`.
- **`pp_create_subclip`** — `projectItemId`, `name`, `startSeconds`, `endSeconds`, `hardBoundaries` (default `false`).
- **`pp_relink_media`** — `projectItemId`, `path`.
- Extend `pp_list_project_items` so each item includes `binId`, `type` (bin | clip | sequence), and `offline` (boolean) if not already returned.

## API hints (UXP, `require("premierepro")`)
- Project-level actions on `Project.getRootItem()`, `FolderItem` (create bin, move item), `ProjectItem` (rename, relink, `isOffline`, create subclip) — check which exist in the target version.
- Use the project's transaction / undo mechanism so each tool is one undo step (see existing `pp.*` commands).

## Acceptance tests
1. `pp_create_bin("Footage")` then `pp_move_project_items` puts two imported items inside it (confirm with `pp_list_project_items`).
2. `pp_rename_project_item` changes the name only.
3. `pp_delete_project_items` refuses an item used in a sequence, and lists the sequence; with `force: true` it deletes.
4. `pp_create_subclip` yields a new item with the given range.
5. `pp_relink_media` reconnects an offline item.
6. Not-connected-path test and round-trip test per tool.

## Definition of done
See `00_PREAMBLE.md`.
