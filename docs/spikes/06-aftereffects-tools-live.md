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
  `suppressDialogs` and `args` texts now follow them. The run numbered its probes 1–14; the code
  and the other docs cite them as "AE-01 probe N", and the bullets below give the number where one
  is cited. What they settled:
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
  - Project switch (probe 7):
    `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); 1` returned `ok` with
    no dialog, and the Edit menu then read "Can't Undo": the undo history was reset, as the
    description's carve-out says.
  - Errors: `line` = `bodyLine` = the caller's line for a runtime error (`null.x`, line 3), a native
    error from a bad lookup (line 2, "After Effects error: internal verification failure, sorry!
    {Item Not Found}"), a SyntaxError on line 1 and on line 3 ("; does not have a value") and a
    `throw` (line 2).
  - Scope and shims: `__args`, `__log` and the shims reach the script, `typeof __comp` is
    `"undefined"`, and `e.source === __src`. A bare `alert` after a `__log` came back `ok: false`
    with the shim's message, `line` and `bodyLine` null, the log kept, and no dialog; `confirm` and
    `prompt` gave their own next step. `Object.prototype.zz = 1` was reported and removed, and
    returning `app.project` was refused as a host object in 11 ms.
  - Dialogs (probes 8 and 9): on a saved project whose text layer uses a missing font, a script
    that saved and exported a Motion Graphics template with `suppressDialogs: false` blocked on
    "After Effects Warning: You must add at least one property controller before exporting a
    motion graphics template." until its 15 s timeout; with suppression it returned in 0.3 s
    (export `false`) and left no dialog. `app.open()` of that project with suppression returned in
    0.5 s with no dialog; without it, the "Missing fonts" dialog blocked until the operator closed
    it (20 s timeout). So suppression hides the open-time missing-font dialog on 26.5, and the
    `Hide Missing Font Dialog` preference was neither read nor changed.
  - **Auto-save hazard (probe 10):** with suppression on, `app.open()` of another project while
    the open one had unsaved changes showed no save prompt. After Effects saved the open project
    over its file (its modified time changed, and the file held the comp the script had just
    added), then opened the other. The call itself timed out at 20 s, queued behind the control's
    still-open "Missing fonts" dialog, so it returned no value: the outcome was read afterwards,
    from the project then open, the file's modified time and its contents. To discard such
    changes, close first with `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)`. The
    description warns of it.
  - `args` (probe 11): strings round-trip exactly (a quote, a backslash, `é`, U+2028), and so do
    `1e21` and the keys `default`, `""` and `constructor`. Numbers do not quite: `0.1 + 0.2`
    arrives exact (`=== 0.1 + 0.2` is true) but comes back in `value` as `0.3`, since After Effects
    writes numbers with 15 significant digits (`String(n)` and `toPrecision(17)` alike), and it
    reads a number below about 2.2e-308 as 0 (`5e-324` in `args`, `2.2250738585072014e-308` as a
    literal). The ae-host unit tests run on V8, which is exact. `reflect`, `toSource` and `watch`
    enumerate as data, so the encoder refuses no extra keys.
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
    that calls `alert`, not probed live by design. What the project-switch calls do with unsaved
    changes was tried in the consent live run below (its not-tried list is at the end).
- **AE-01 consent live run — After Effects 26.5x89, Windows 11, 2026-10-12.** Owner request
  2026-10-12: a script that closes or replaces the open project must not run without the
  operator's OK, never asked in After Effects. The branch build at afd2b21 (MCP elicitation when
  the client advertised it, a plain-text refusal plus `allowProjectSwitch` otherwise) ran with the
  gate set to `after_effects`, against the real CEP panel, on scratch projects only: `a.aep` (a
  fresh copy of a one-comp project before each test) and `b.aep` (one comp). "Dirty" = the script
  added a comp "AE01 probe" first; "saved over" = `a.aep`'s modified time changed and the file
  held that comp; "unchanged" = same time and size, no comp. The ids below are the run's own; the
  code and the other docs cite them.
  - **Fallback (a client with no elicitation).** F1: no flag, `a.aep` clean, the script would make
    it dirty and then `app.open(b)` → refused in plain text (that build's wording, which also said
    the client could not ask), project and file unchanged, audit `refused consent=needed`. F1b:
    `a.aep` dirty → the refusal said "it has unsaved changes right now". F2:
    `allowProjectSwitch: true` (that build honoured the flag with no earlier refusal) → it ran, and
    `a.aep` was **saved over** (probe 10 again), audit `run consent=flag`. `cc_eval_script` with
    `app.open` → refused, pointing to `ae_run_script`.
  - **Elicitation with a scripted client** (E1–E3: decline, accept-false with the flag set, accept
    true) behaved as built: refused, refused (the flag did not skip the question), ran.
  - **Claude Code's own dialog (Claude Code 2.1.296, Windows 11 terminal).** In three tries (auto
    mode twice, manual once) Claude Code advertised form elicitation and received the question,
    but **did not show a dialog**: it answered
    `{"action":"accept","content":{"allowProjectSwitch":false}}` (the schema's default) by
    itself — auto mode after 11 s and 14 s, manual mode after 1 s — while the operator, at the
    terminal, saw nothing and pressed nothing. The server failed closed (each call refused), but
    in this setup no yes came through, and the server cannot tell that no person saw the
    question. No `Elicitation` hook was set in user or project settings; managed settings were not
    checked conclusively. **Owner decision 2026-10-12: chat only.** `ae_run_script` no longer asks
    through the MCP client at all; every client gets the refusal, and `allowProjectSwitch: true`
    runs only the same call (script, `args` as sent, `suppressDialogs`) that this session refused
    within the last 10 minutes, once (`SwitchRefusals` in `after-effects.ts`). The server cannot
    tell whether the operator was asked: the guard only makes sure the refusal, with the risk,
    reached the model first; the asking happens in the chat, where the operator can see the
    model's tool calls. F1 and F2 saw the earlier build's refusal (older wording) and a flagged
    run with no guard; the recheck below saw the guard on the current build.
  - **A script could not wrap the three triggers tried.** `app.open` is a native function;
    assigning `app[n] = function () {}` (with `n` computed) raised no error and changed nothing,
    and the same for `app.project.close` and `app.newProject`. `app.openFast`, `app.quit`,
    `app.restart` and other ways to wrap were not probed. So the text scan
    (`projectSwitchCalls`) stays the only guard. (Calling through was skipped on purpose:
    `app.open()` with no file would open a file picker; not run.)
  - **What After Effects does with unsaved changes** (the refusal's `riskSentence` states exactly
    this, by the project's state and `suppressDialogs`):

    | Id | Call | suppressDialogs | Project | Seen |
    | --- | --- | --- | --- | --- |
    | probe 10, F2 | `app.open(b)` | on | dirty, saved | no prompt; **saved over** the file |
    | T1 | `app.newProject()` | on | dirty, saved | no prompt; **saved over** the file |
    | T2 | `app.openFast(b)` | on | dirty, saved | no prompt; **saved over** the file |
    | T3 | `app.open(b)` | on | dirty, **never saved** | **After Effects' save prompt showed anyway** and blocked After Effects; the call timed out (15 s). After Don't Save, the untitled project was still open with its comp and `b.aep` was **not** opened |
    | t4#0 | `close(DO_NOT_SAVE_CHANGES)` | on | dirty, never saved (read just before: no file, unsaved changes, 1 item) | no prompt; returned ok in 48 ms, and the project open afterwards had no file, no unsaved changes and no items |
    | T4 | `close(PROMPT_TO_SAVE_CHANGES)` | on | dirty, saved | **no prompt; saved over** the file |
    | T5on | `close(DO_NOT_SAVE_CHANGES)` | on | dirty, saved | no prompt; file unchanged (changes thrown away) |
    | T5 | `close(DO_NOT_SAVE_CHANGES)` | off | dirty, saved | no prompt; file unchanged |
    | T6 | `close(SAVE_CHANGES)` | off | dirty, saved | no prompt; **saved over** the file |
    | T7 | `app.open(b)` | off | dirty, saved | **save prompt**, blocked After Effects; the call timed out (8 s). After Don't Save, `b.aep` opened and `a.aep` was unchanged |

  - **Not tried:** `app.quit` (T8, skipped: it needs a relaunch) and `app.restart`; `app.openFast`
    and `app.newProject` with suppression off or on a never-saved project; `close(SAVE_CHANGES)`
    with suppression on; `close(PROMPT_TO_SAVE_CHANGES)` with suppression off;
    `close(SAVE_CHANGES)` or `close(PROMPT_TO_SAVE_CHANGES)` on a never-saved project; `app.open`
    with suppression off on a never-saved project; `close(DO_NOT_SAVE_CHANGES)` with suppression
    off on a never-saved project. The refusal says "not verified live" for each (an expected save
    prompt with suppression off is marked expected), and states nothing else about them.
  - The checklist this run followed (Claude Code's dialog, the fallback, the wrap probe, the
    trigger table) is done; its open points are the "Not tried" list above.
- **AE-01 chat-only recheck — After Effects 26.5x89, Windows 11, 2026-10-13, build bd1fd51.**
  Claude Code (this repo's session) drove `ae_run_script` through its own MCP connection, gate set
  to `after_effects`, on an untitled project with no file and 0 items. Script:
  `if (__args.go) { app.newProject(); }\napp.project.numItems` with `args` `{go: false}`, so
  `app.newProject` never ran.
  - R1: no flag → plain-text refusal in the current wording: `app.newProject (line 1)`, "never
    been saved (no file), 0 items; it has no unsaved changes right now", the "Not verified live
    (suppressDialogs on, a project with no file)" clause for `app.newProject`, the "as it is now"
    sentence and the `cc_eval_script` warning.
  - R2: `allowProjectSwitch: true` with `args` `{go: false, t: 2}` (never refused) → refused, with
    the lead sentence "allowProjectSwitch is honoured only for …" and the full risk.
  - R3: the model asked the operator in the chat; they agreed. The flagged retry came **10 min 4 s**
    after R1 (19:28:05 → 19:38:09 UTC in Claude Code's MCP log) and was refused as expired, with
    the same lead sentence: the 10-minute limit, seen live. That refusal recorded a new one; the
    same flagged call, sent again at once under the operator's same OK, **ran**: `ok: true`,
    `value: 0`, 518 ms.
  - R4: the same flagged call again → refused (one use).
  - Audit lines were not seen: Claude Code's MCP log for the server kept its stderr from start-up
    only, not per call. The `refused consent=needed` / `run consent=flag` pair was seen in the
    2026-10-12 run (F1, F2).
  - Not rechecked live: the 64-refusal cap, a second session, `suppressDialogs` as part of the key,
    the OK kept when After Effects is not connected, a failed or cancelled check, the remote line,
    `closeOptionsOf` and the later-calls sentence. They stay unit-tested only.
  - Follow-up: an operator who steps away can take longer than 10 minutes to answer; the model then
    gets the expiry refusal and must ask for the call again (it did here, and the retry ran).

- aerender reads the project **from disk**: `ae_render_comp` saves first, and needs a project
  that has been saved once (`ae_save_project` with a path).

## AE-03 probes (2026-10-13, After Effects 26.5x89, Windows 11, English UI)

Run before AE-03 was built, through `cc_eval_script` with the gate set to `after_effects`, on a
scratch project. They settled how `ae_undo` / `ae_redo` and `ae_batch`'s rollback work. The
operator saw no dialog, popup or block in After Effects, which was running in the background.
The probes cover the host facts only; the AE-03 tools themselves are unit-tested, and their live
run is pending. Index-based scripts are byte-identical to b2f9060 (AT7) with two named
exceptions: `ae_add_marker` (its layer lookup moved before the group) and `ae_queue_render` (its
repeated-name check).

- **Menu ids (L1).** `app.findMenuCommandId("Undo")` and `("&Undo")` return 2371; `"Purge"`
  returns 2370 and `"All Memory"` 2373, so **2371 is Edit > Purge > Undo**, which clears the undo
  history. Never use the label lookup for Undo. `findMenuCommandId("Redo")` returns 0. For
  reference: Cut 18, Copy 19, Paste 20, Clear 21, Select All 23, Save 5, Revert 7, Close Project
  3154, History 2995.
- **Undo and Redo by id (L2).** `app.executeCommand(16)` is Edit > Undo, `app.executeCommand(2035)`
  is Edit > Redo (it restored a removed folder). An Undo takes effect synchronously inside the same
  eval, run right after `app.endUndoGroup()`: the same script reads the undone state.
- **History.** Two groups, then two Undos, removed them one at a time; Redo restored the last.
- **Nothing to undo (L3).** Edit > Undo with nothing to undo is a silent no-op (no dialog, 235 ms).
- **A partial group.** Two adds, then a caught throw, then `endUndoGroup()`: one Undo removed both adds.
- **An empty group** (`beginUndoGroup` / `endUndoGroup` with no change) makes **no** undo entry: a
  following Undo removed the previous group instead. So an atomic `ae_batch` makes a change first
  inside its group (an empty folder, `__acm_batch`); otherwise a rollback after a first-operation
  failure would undo the operator's previous step.
- **itemByID of a removed item throws** ("internal verification failure ... {Item Not Found}"), as
  it does for an id that never existed: it never returns null. `ae_batch` reads a throw for its
  folder as "rolled back".
- **Render queue and Essential Graphics (L6b).** `renderQueue.items.add` and
  `Property.addToMotionGraphicsTemplate` inside a group are both reversed by one Undo, so
  `ae_queue_render` and `ae_add_to_essential_graphics` stay batchable.
- **Decision (D1).** `ae_batch` rolls back in one eval: `endUndoGroup()`, then
  `executeCommand(16)`, then the folder check. After a rollback the failed batch is on the Redo
  stack (Ctrl+Shift+Z or `ae_redo` would re-apply it); the tool's result says so.
- **Not tried:** a 200-operation batch's duration and script size (L8), a non-English After
  Effects (L12; the fixed ids are expected not to depend on the UI language, not verified), and the
  AE-03 tools end to end (L4–L7, L10, L11). For L7 with `atomic: false`, a lookup that fails in
  operation 1 changes nothing, so expect **no** new undo entry (an empty group), not one.

## Tool inventory (24)
project_info · list_compositions · list_footage · get_comp · get_layer · open_project ·
save_project · import_footage · create_comp · add_layer · set_layer_props · duplicate_layer ·
delete_layer · set_keyframes · get_keyframes · remove_keyframes · set_expression ·
apply_effect · set_effect_param · set_text · add_marker · render_frame · queue_render ·
render_comp
