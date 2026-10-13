# After Effects tool set v1 — live run (2026-08-27, Windows, After Effects 2026 v26.3)

Driven entirely from Claude Code through the hub and the Brainferno MCP Bridge CEP panel:

1. `ae_create_comp` "Brainferno Title" 1920×1080, 30 fps, 5 s → id 1.
2. `ae_add_layer` solid `#1e1e2e` "background"; `ae_add_layer` text "Brainferno".
3. `ae_set_text` Arial-BoldMT 160 pt `#f5a623`, justification center.
4. `ae_set_keyframes` position (−400, 540) → (960, 540) over 0–1 s, easy ease on the last key.
5. `ae_apply_effect` `ADBE Glo2` (Glow) → `ae_set_effect_param` radius 60, intensity 1.5.
6. `ae_add_marker` comp marker "in" at 1 s; `ae_get_comp` / `ae_get_layer` / `ae_get_keyframes` read it all back.
7. `ae_render_frame` at 0 s (title still off-screen) and 2 s (glowing centered title) → image blocks.
8. `ae_save_project` → `brainferno-title.aep`; `ae_render_comp` "Lossless" → `.avi` via aerender in 8 s,
   UI stayed free.

## Gotchas found

- **`layer instanceof TextLayer` is false** in AE 26.3 ExtendScript. Layer kinds come from
  `layer.matchName` (`ADBE Text Layer`, `ADBE Camera Layer`, `ADBE Light Layer`, `ADBE AV Layer`
  + `SolidSource`).
- **`setTemporalEaseAtKey` on a spatial property takes one `KeyframeEase`**, not one per
  dimension ("Value array does not have 1 elements"). Non-spatial arrays (scale) take one per
  dimension.
- **`saveFrameToPng` returns before the file exists.** The server polls until the file is
  present and its size is stable (`waitForFile`) before reading it.
- **`ParagraphJustification.CENTER_JUSTIFY` did not center point text on the anchor** — the
  text ended at the anchor. `ae_set_text` and text `ae_add_layer` now move the anchor point to
  the center of `sourceRectAtTime`, so `position` always means the visual center of the text.
- Same restart discipline as Photoshop: after a rebuild, kill this session's server, then `/mcp`
  reconnect. With several Claude Code windows open, the pid in `~/.brainferno-mcp-bridge/bridge.json`
  may be another window's server (see HANDOFF "Kill the right server"). The CEP panel reconnects on
  its own only after an abnormal drop; a clean shutdown sends "bye", the panel engages its kill
  switch, and you press **Connect** in it.
- **Line numbers are relative to the innermost eval** (verified live on 26.5, 2026-10-09, during
  X-01): a script run through `eval(src)` — even nested inside another eval, as the raw-script
  wrapper is inside `host.jsx`'s `__acmEval` — reports `e.line` counted within `src` itself. A
  SyntaxError reports the line too (line 1 for `var x = ;`). So a typed tool's error line is
  relative to the whole `wrap()`ped script, and AE-16's prelude subtraction is the right fix.
- **How AE-16 reads a typed tool's error line** (`locateAeError` in `after-effects.ts`): the
  first body statement is body line 1 (`AE_PRELUDE_LINES` is derived from the prelude, never
  typed); a line inside a shared helper names the helper (`in helper __prop`), since After
  Effects reports the helper's own line, not the call site; and a line that falls in neither
  reads as "outside this tool's own code". The CEP panel's `host.jsx` serializes the result in
  the same `try` as the `eval`, so an error it raises there — a host object in the result —
  carries host.jsx's own line number (the observed "line 40" was `__acmJson`'s `var x = v[k];`).
  Every After Effects script therefore starts with `HOST_LINE_GUARD` (100) blank lines, so a
  host.jsx line can never land on a helper or a body line. After Effects scripts also travel as
  pure ASCII since AE-16 (`\uXXXX` escapes; same text in the host).
- **AE-16 live probes — verified on After Effects 26.5 (Windows 11, 2026-10-10).** Typed `ae_*`
  tools only (no raw-script gate), on a new project, with a server built before the Card Dance
  change below: every probe passed except the empty-name noise that change fixes.
  Probe 21 (a disconnect, optional) was skipped, as the unit tests cover its text; with debug
  logging off, the effect list's re-read after the panel was reopened (probe 20) was not seen,
  though the suggestions still came back. What they settled:
  - `PropertyType.PROPERTY` exists: a path that goes on past a leaf
    (`["ADBE Transform Group", "ADBE Position", "X"]`) says the segment "is a property, not a
    group" and to end the path there.
  - `canAddProperty` is case-sensitive for match names ("adbe gaussian blur 2" was refused, so
    `EFFECT_NAMES_CASE_SENSITIVE` stays `true`; a display name in the wrong case was not tried)
    and takes display names ("Gaussian Blur" was
    applied as `ADBE Gaussian Blur 2`, so `EFFECT_DISPLAY_NAMES_ACCEPTED` is now `true` and the
    "or display name" in `ae_apply_effect` holds).
  - Cameras and lights: the Effect Parade and Mask Parade are null on both, and
    `ae_get_layer_styles`, `ae_apply_effect`, `ae_set_effect_param` and `ae_add_mask` give their
    camera-and-light messages.
  - A native error in a statement inside an `else if` branch reports that statement's own line
    (`ae_add_layer` solid of width 40000: body line 7, the `else if` line just above it in the
    excerpt).
  - The range errors come from After Effects with curly quotes (non-ASCII text from the host):
    `c.width = 40000` gives "Unable to set “width”. Value 40000 out of range 1 to 30000", and
    `addSolid` gives "Unable to call “addSolid” because of parameter 3. Value 40000 out of range 1
    to 30000". The width stayed 1920 and no layer was added.
  - Card Dance's match name is `APC CardDanceCam`, not `ADBE Card Dance`. It has 80 parameters:
    `APC CardDanceCam-` and 4 digits (not in list order), then "Compositing Options",
    `ADBE Effect Built In Params` (Gaussian Blur ends with it too). 12 of them have an empty name,
    the end of each topic (0027, 0037 … 0097, 0117, 0133, 0149, 0159). They took room in the
    children list and showed in "repeated:" as `""` with 12 numbers, a name no one can pass, so the
    helpers now leave them out of lists by name. `test/ae-host.ts` holds this layout; the change
    itself is unit-tested only, not re-run live.
  - Undo: after all the probes the Edit menu read "Undo Apply effect", the last call that
    succeeded. Calls that failed before changing anything (the lookups, the empty-group and
    effect-name misses, the width and `addSolid` range errors) left no undo entry; a call that
    fails after an earlier statement changed something keeps its one undo group (see the
    `ae_set_comp_props` note below). The display-name refusal note that
    `EFFECT_DISPLAY_NAMES_ACCEPTED = true` selects was not triggered live.
  - Follow-ups: a parameter typo gets no "did you mean" when the parameter is past the 20 names
    the list shows ("Light Intensty": Light Intensity is Card Dance's 69th), since suggestions rank
    only the names the host listed. The `app.effects` read took under 3 s (no slow-read line in the
    log; full read mode), but its count and time were not recorded: debug logging was off.
    Not AE-16, seen on the way: `ae_set_comp_props` sets its fields in order, so a name set before a
    width that fails stays until undone (one undo group; Ctrl-Z restores it).
- **AE-01 live probes — verified on After Effects 26.5 (Windows 11, 2026-10-12).** `ae_run_script`
  on a probe server built from the branch with `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=after_effects`,
  talking to the real CEP panel; the operator watched the Edit menu, pressed Ctrl+Z, and reported
  and dismissed dialogs. Every probe passed or settled an open fact, and the description and the
  `suppressDialogs` and `args` texts now follow them. What they settled:
  - Gate: the `cc_get_capabilities` row read enabled, connected and supported, and
    `(function(){ return app.version; })()` returned `"26.5x89"` in 27 ms. With the gate off (the
    normal server, no env var) the call was refused in plain text ("… currently enabled for:
    none.") while After Effects was connected. `app.beginUndoGroup("inner"); 1` was refused as
    plain text in 3 ms.
  - One undo step: a script that added a solid and a text layer with `undoGroupName`
    "AE01 two layers" put **Undo AE01 two layers** in the Edit menu; one Ctrl+Z removed both
    layers and one Redo brought both back. A script that added a null and then threw left one entry,
    which removed the null. A read-only call left the Edit menu as it was. A script cannot read that
    label: `app.findMenuCommandId("Undo AE01 two layers")` returns 0 (`"Undo"` alone gives 2371).
  - End calls: `app["end" + "UndoGroup"](); 1` (the tool's group closed early) returned `ok`, value
    1, with no note and no dialog: a second `endUndoGroup` neither throws nor warns, so the end-call
    notes have no live trigger. Neither does R10 (a note after a throw): ExtendScript has no getter
    literals, and `({ get a() { … } })` is a SyntaxError ("Expected: :").
  - Project switch: `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); 1`
    returned `ok` with no dialog, and the Edit menu then read "Can't Undo": the undo history was
    reset, as the description's carve-out says.
  - Errors: `line` = `bodyLine` = the caller's line for a runtime error (`null.x`, line 3), a native
    error from a bad lookup (line 2, "After Effects error: internal verification failure, sorry!
    {Item Not Found}"), a SyntaxError on line 1 and on line 3 ("; does not have a value") and a
    `throw` (line 2).
  - Scope and shims: `__args`, `__log` and the shims reach the script, `typeof __comp` is
    `"undefined"`, and `e.source === __src`. A bare `alert` after a `__log` came back `ok: false`
    with the shim's message, `line` and `bodyLine` null, the log kept, and no dialog; `confirm` and
    `prompt` gave their own next step. `Object.prototype.zz = 1` was reported and removed, and
    returning `app.project` was refused as a host object in 11 ms.
  - Dialogs: on a saved project whose text layer uses a missing font, a script that saved and
    exported a Motion Graphics template with `suppressDialogs: false` blocked on "After Effects
    Warning: You must add at least one property controller before exporting a motion graphics
    template." until its 15 s timeout; with suppression it returned in 0.3 s (export `false`) and
    left no dialog. `app.open()` of that project with suppression returned in 0.5 s with no dialog;
    without it, the "Missing fonts" dialog blocked until the operator closed it (20 s timeout). So
    suppression hides the open-time missing-font dialog on 26.5, and the `Hide Missing Font Dialog`
    preference was neither read nor changed.
  - **Auto-save hazard:** with suppression on, `app.open()` of another project while the open one
    had unsaved changes showed no save prompt. After Effects saved the open project over its file
    (its modified time changed, and the file held the comp the script had just added), then opened
    the other. The call itself timed out at 20 s, queued behind the control's still-open "Missing
    fonts" dialog, so it returned no value: the outcome was read afterwards, from the project then
    open, the file's modified time and its contents. To discard such changes, close first with
    `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)`. The description warns of it.
  - `args`: strings round-trip exactly (a quote, a backslash, `é`, U+2028), and so do `1e21` and the
    keys `default`, `""` and `constructor`. Numbers do not quite: `0.1 + 0.2` arrives exact
    (`=== 0.1 + 0.2` is true) but comes back in `value` as `0.3`, since After Effects writes numbers
    with 15 significant digits (`String(n)` and `toPrecision(17)` alike), and it reads a number below
    about 2.2e-308 as 0 (`5e-324` in `args`, `2.2250738585072014e-308` as a literal). The ae-host
    unit tests run on V8, which is exact. `reflect`, `toSource` and `watch` enumerate as data, so
    the encoder refuses no extra keys.
  - Queueing: an 8 s loop with `timeoutMs: 2000` gave the timeout envelope at 2.0 s, and an
    `ae_project_info` sent next took 5.8 s, waiting for the loop to end. A call sent while an earlier
    call's dialog is still open waits behind it the same way (the first try of the suppressed export
    timed out behind the unsuppressed one's dialog).
  - Audit: 65 calls gave 65 audit lines (64 `run`, 1 `refused`) plus the startup line, none with
    script text.
  - Observation, not AE-01: `ae_open_project` (a typed tool, which does not suppress dialogs)
    opened the missing-font project in 0.8 s and left the "Missing fonts" dialog on screen.
  - Still unit-tested only: the end-call notes, after a result and after a throw (no live trigger,
    above); the refused audit line with the gate off (the client's MCP log keeps no server stderr;
    the refusal text was seen); and `Window.alert`, `$.global.alert`, `this.alert` and global code
    that calls `alert`, not probed live by design. The server side of the project-switch OK
    below is unit-tested only too.
  - Not tested at all: opening another project over a never-saved one under suppression. It was
    not tried live, and ae-host has no save prompt to stand in for After Effects'. Nor, under
    suppression over unsaved changes: `app.newProject()`, `app.openFast()`, `app.quit()`,
    `app.restart()`, `app.project.close(CloseOptions.PROMPT_TO_SAVE_CHANGES)` and
    `close(DO_NOT_SAVE_CHANGES)` (the project switch above closed a project saved just before,
    almost certainly clean: it shows no dialog, not a discard); nor `close(SAVE_CHANGES)` either
    way, or `close(DO_NOT_SAVE_CHANGES)` and `app.open()` with suppression off (AE-01 consent,
    step 4 below). Nor Claude Code's elicitation dialog (step 1) or whether `app.open` can be
    wrapped at run time (step 3).
- **AE-01 project-switch OK — unit-tested; live check pending.** Owner request 2026-10-12: a script
  that closes or replaces the open project must not run without the operator's OK, asked in the MCP
  client, never in After Effects. Built: `ae_run_script` scans the script's text (case-sensitive;
  comments and strings count) for `app.open(`, `app.openFast(`, `app.newProject(`,
  `app.project.close(`, `app.quit(`, `app.restart(` (each with a dot or as a quoted name in
  brackets, `app['open'](`) and the word `CloseOptions` (`projectSwitchCalls`). On a match it runs
  `PROJECT_INFO` (`ae_project_info`'s read-only script, `timeoutClass: "fast"`) and then, when the
  session's client advertises form elicitation, asks the operator once (one required boolean,
  default false; 10 minutes to answer) with the file name or "never saved", whether there are
  unsaved changes, and what After Effects does with them, saying which part was seen live
  (`app.open` over a saved project saving over the file without asking, with suppression on,
  probe 10) and which are not verified (the other calls and a never-saved project; a close,
  whose `CloseOptions` it gives as Adobe documents them). It runs only on accept + `true`. A
  client without form elicitation gets a plain-text refusal; `allowProjectSwitch: true` is
  honoured only then, set after the model passed that refusal on and the operator agreed in the
  chat. Every refusal is plain text with the script not sent, audited once: after the question
  or the fallback only the check was sent, and the line carries `consent=`; a failed check is
  refused with no `consent=`, and with After Effects not connected nothing is sent. A call the
  client cancels during the check or the question gets no result (the client's own request ends
  with -32001), and the script is not sent either. `cc_eval_script` refuses such an After
  Effects script and points to `ae_run_script`. The scan reads the text only and does not
  catch, among others: a computed name, an alias, `with (app) { open(f) }`, `(app).open`,
  `.call`/`.apply`, a comment or escape inside the call, a menu command, or code run from
  elsewhere at run time (`$.evalFile`, `eval` of a file's text or of text passed in `args`);
  step 3 decides whether a runtime guard can close that. The checklist below is the live run;
  fill in each result and keep the raw results, as the AE-01 run did. Every project used is a
  scratch copy.
  1. **Claude Code's dialog, gate on, the real server.** Set
     `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=after_effects` for this session's server, kill *this
     session's* server (HANDOFF "Kill the right server"), `/mcp` → brainferno → reconnect, press
     Connect in the CEP panel if needed; `cc_get_capabilities` should show the `ae_run_script` row
     enabled, connected and supported. Note `claude --version`. Then, on a saved clean scratch
     project, call `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);\napp.newProject();\napp.project.numItems`:
     - [ ] the dialog appears (if the plain-text fallback comes back instead, this build does not
       advertise elicitation: record it and use step 2 with Claude Code as the client); record the
       message as shown (line breaks kept?), how the boolean renders and its default, the title and
       description, the buttons, and what Esc does;
     - [ ] decline → the decline text; project, file time and Edit menu unchanged;
     - [ ] Esc or close → the cancel text (or record what Claude Code sends instead);
     - [ ] submit with the field left at its default → the "submitted without…" text; record
       whether Claude Code sends `false` or leaves the field out (both map here);
     - [ ] yes → `ok`, `value` 0. If the failed-ask text says "must be boolean", Claude Code sends
       the boolean as a string: stop and report to the owner, do not patch it;
     - [ ] a dirty saved project → "it has unsaved changes right now"; decline; file time unchanged;
     - [ ] a never-saved project with a comp → "has never been saved (no file)"; decline;
     - [ ] answer yes after about 90 s (past the SDK's 60 s default) → it still runs; optional: no
       answer for 10 minutes → "no answer within 10 minutes", and whether the dialog closes itself;
     - [ ] After Effects stays responsive while a question is open;
     - [ ] from a subagent of this session (a client that cannot show the question): record the
       action Claude Code returns and the text the subagent gets (expected: the cancel text with
       its "If no question appeared…" clause);
     - [ ] `cc_eval_script` with `appId: "after_effects"` and the same script → its refusal,
       nothing changed in After Effects.
  2. **Fallback, a client with no elicitation** (the AE-01 probe-server pattern, this session's
     server stopped first, the real CEP panel): no flag → the plain-text refusal with the real file
     name, path and dirty state, nothing changed; `allowProjectSwitch: true` → it runs; a second
     client with `{ elicitation: { form: {} } }` scripted to decline, then to accept true → refused,
     then it runs. Keep this server for step 4, then restore this session's server and press
     Connect.
  3. **Can `app.open` be wrapped at run time?** Through `ae_run_script` on a scratch project, one
     name per call, the name computed so the scan does not match, each assignment restored in its
     own `try/finally`. Stop rule: if a restore check is not `true`, stop, report it, run nothing
     else and restart After Effects. (a) `typeof app["op" + "en"]` and its `String(...)`;
     (b) assign without calling anything and restore: taken, ignored or refused; (c) only if
     taken: call through the stub, confirm the restore, and in a fresh call compare
     `String(app["op" + "en"])` with (a); check `app.project === app.project`, then repeat (b) for
     `app.project["clo" + "se"]`, `newProject`, `openFast`, `quit` and `restart`, never calling an
     original. If all are assignable and restorable, a runtime guard is the follow-up; if not, the
     text-only guard stays and this note says why.
  4. **What After Effects does on each trigger** (the step 2 server, `allowProjectSwitch: true`,
     scratch copies; make the project dirty in the same call by adding a comp "AE01 probe"; record
     the file time, whether the file holds the comp, any dialog, the result and the project open
     afterwards; dismiss any dialog with Don't Save or Cancel, never Save): `app.newProject()`, on,
     saved; `app.openFast(<other>)`, on, saved; `app.open(<other>)`, on, never saved;
     `close(PROMPT_TO_SAVE_CHANGES)`, on, saved; `close(DO_NOT_SAVE_CHANGES)`, on, saved
     (expected: no prompt, time unchanged, comp absent; the project switch above closed only a
     project saved just before); `close(DO_NOT_SAVE_CHANGES)`, off, saved (expected: no prompt,
     time unchanged, comp absent); `close(SAVE_CHANGES)`, off, saved (expected: no prompt, time
     changed, comp present); `app.open(<other>)`, off, saved (expected: the save prompt, the call
     timing out); last, `app.quit()`, on, saved (relaunch and reopen to check; `app.restart()`
     optional). Then tighten `riskSentence`, the `allowProjectSwitch` text, the README bullet and
     the CHANGELOG sub-bullet to what was seen and re-pin T25. If a result contradicts the owner's
     background facts (for example `DO_NOT_SAVE_CHANGES` not discarding), stop and report before
     changing texts.
  5. **After the run:** mark what was verified "verified live on After Effects 26.5 (Windows 11,
     <date>)" in README, CHANGELOG, HANDOFF, this note and the AE-01 prompt, keep a "Still
     unit-tested only" list, and restore the gate to the operator's normal setting.
- aerender reads the project **from disk**: `ae_render_comp` saves first, and needs a project
  that has been saved once (`ae_save_project` with a path).

## Tool inventory (24)
project_info · list_compositions · list_footage · get_comp · get_layer · open_project ·
save_project · import_footage · create_comp · add_layer · set_layer_props · duplicate_layer ·
delete_layer · set_keyframes · get_keyframes · remove_keyframes · set_expression ·
apply_effect · set_effect_param · set_text · add_marker · render_frame · queue_render ·
render_comp
