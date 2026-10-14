# After Effects Undo and Redo (scripting)

Relevant to `ae_undo`, `ae_redo` and `ae_batch`'s rollback (AE-03).

Probed live on After Effects 26.5x89, Windows 11, English UI, 2026-10-13, through
`cc_eval_script` on a scratch project; details in `docs/spikes/06-aftereffects-tools-live.md`
("AE-03 probes").

- **Use the fixed command ids: Edit > Undo is 16, Edit > Redo is 2035**
  (`app.executeCommand(16)`, `app.executeCommand(2035)`). They are named constants in
  `after-effects.ts` (`AE_UNDO_COMMAND`, `AE_REDO_COMMAND`). Command ids are expected not to
  depend on the UI language (not verified: only an English After Effects was probed, L12).
- **Never look Undo up by label.** `app.findMenuCommandId("Undo")` (and `"&Undo"`) returns 2371,
  which is **Edit > Purge > Undo** (it sits between Purge, 2370, and All Memory, 2373) and clears
  the undo history. `findMenuCommandId("Redo")` returns 0. The AE-03 feature request asked for the
  lookup; this is why the tools hard-code the ids instead. (AE-01 also found that
  `findMenuCommandId("Undo <label>")` returns 0, so a script cannot read which step it would undo.)
- **An Undo takes effect at once**, inside the same eval, even right after `app.endUndoGroup()`:
  the same script reads the undone state.
- **Nothing to undo is a silent no-op**: no dialog, no error.
- **An empty undo group makes no undo entry.** `beginUndoGroup` / `endUndoGroup` with no change
  in between leaves the history as it was, so an Undo after it reverts the previous entry, whoever
  made it. A script that may roll its own group back must change something first inside it
  (`ae_batch` adds an empty folder, `__acm_batch`, and removes it inside the group on success).
- **A group that failed part-way is still one entry**: two changes, then a caught throw, then
  `endUndoGroup()` — one Undo removes both changes.
- **After a rollback the undone group sits on the Redo stack**: Ctrl+Shift+Z or Edit > Redo
  re-applies it.
- **Never touch an object after `endUndoGroup()` if the group is to be undone**: the change would
  be a new entry, and the next Undo would revert that instead of the group.
- **`app.project.itemByID` throws for an item that is gone** (removed, or undone away), as for an
  id that never existed; it never returns null.
- Adding a composition to the render queue (`renderQueue.items.add`) and exposing a property in
  Essential Graphics (`addToMotionGraphicsTemplate`) inside a group are both reversed by one Undo.
- Not tried: a non-English After Effects, and Undo while a modal dialog is open.
