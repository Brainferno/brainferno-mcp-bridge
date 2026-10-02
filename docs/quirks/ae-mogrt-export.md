# After Effects Motion Graphics template (.mogrt) export

Relevant to `ae_export_mogrt` / `ae_add_to_essential_graphics`.

Exporting a comp as a `.mogrt` from After Effects has three traps, all hit and
fixed live on AE 26.3:

1. **`exportAsMotionGraphicsTemplate(overwrite, file_path)` takes a FOLDER**, not a
   file path, and names the file from `comp.motionGraphicsTemplateName`. So set the
   name first, pass the directory, and the result is `<folder>/<name>.mogrt`. The
   pre-24.3 "always returns false" bug is gone — but still verify the file exists.
2. **The export invalidates the comp reference.** Reading `c.name` or
   `c.motionGraphicsTemplateControllerCount` AFTER the export throws "Object is
   invalid". Read everything off the comp BEFORE calling export.
3. **A missing font (or any project warning) pops a modal**, and any AE modal blocks
   ALL scripting until a human clicks it (the bridge just times out and every later
   call hangs behind the open dialog). Wrap save+export in
   `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)`. Also the project
   must be saved (a dirty project makes AE prompt) — the tool calls `app.project.save()`.

Essential Graphics "creation": `property.canAddToMotionGraphicsTemplate(comp)` then
`property.addToMotionGraphicsTemplate(comp)` on the comp the property lives in. The
control is named after the property; `setMotionGraphicsTemplateControllerName` does
NOT exist in 26.3 (only get/count), so no script rename. Source Text lives at
`ADBE Text Properties > ADBE Text Document`.

General AE lesson (see also `ae-layer-styles.md`): concatenating an AE error object
with a string in a catch can itself throw the "Object … where a Number, Array, or
Property is needed" error — use `e.toString()`. UXP panel code changes (Photoshop
gradient overlay lives in `panel-uxp/commands.js`) need a UXP Developer Tool reload,
not just a server restart.
