# Changelog

## Unreleased

One run-script contract and a gate clients can see (X-01); After Effects errors that say where and why (AE-16); `ae_run_script`, a raw After Effects script as one undo step (AE-01).

**Breaking**

- `cc_eval_script` and `ps_batch_play` now return the raw-script envelope
  `{ ok, error?: { message, line, bodyLine }, durationMs, value, logs, logsDropped? }`, keys in
  that order. `ps_batch_play`'s results array moved under `value`.
- A raw-script tool error is now either plain text (your script was not sent: raw scripts
  disabled, app not enabled, app not connected; for `cc_eval_script` also an After Effects
  script that closes or replaces the open project; for `ae_run_script` also a project switch not
  approved, after which only a read-only check of the open project ran) or a JSON envelope (the
  script or batch was sent and may have partly run). A script that throws in the host, a
  timeout, or a panel that disconnects mid-call now gives the JSON form, where a script error
  used to come back as plain text.
- `cc_eval_script` refuses an After Effects script whose text calls `app.open`, `app.openFast`,
  `app.newProject`, `app.project.close`, `app.quit` or `app.restart` (with a dot or as a quoted
  name in brackets), or names `CloseOptions` (comments and strings included), as plain text with
  nothing sent, and points to `ae_run_script`, which needs the operator's OK in the chat first.
  Other apps are unchanged. Checked live on After Effects 26.5 with one script that calls
  `app.open` in dot form (with an earlier wording of the pointer); the other calls, the bracket
  form and `CloseOptions` are unit-tested only.
- `ps_batch_play`: a batch whose results contain an in-band `{ _obj: "error" }` entry now
  returns `ok: false` (an `isError` result) naming the failing descriptor, instead of reporting
  success.
- `cc_eval_script` runs the script through an ES3 wrapper. The value of its last statement is
  still the result (an IIFE still works; a top-level `return` is a syntax error).
  - The new `__log(msg)` collects log lines: up to 200 lines / 20000 characters, each line cut
    at 2000. `logsDropped` counts the rest, and once a line is dropped every later one is too,
    so `logs` is always a prefix of what was logged. `__log` never throws into the script: a
    value that cannot be turned into text is logged as `[unprintable]`.
  - A result that is not plain data — a host object such as a layer, a comp or a `Date` — is
    now refused with its path instead of being serialized best-effort. The check covers exactly
    what the hosts' serializer writes, inherited keys included: an instance of the ES3
    `Ctor.prototype = { … }` pattern holding a host object is refused, and a cycle fails fast
    instead of overflowing the serializer. Plain data with its own `constructor` key is
    accepted.
  - `error.bodyLine` is the failing line in the caller's script. It is set only when the host's
    line numbers can be calibrated and the error was raised in the caller's own text, not in a
    `$.evalFile`'d library or a helper an earlier call left behind; otherwise it is `null`.
  - A script that adds data (non-function) properties to `Object.prototype`, or changes ones
    already there, fails, naming them: every object would inherit them, which breaks the
    host's serializer for every later call to that app, typed tools included. Added ones are
    removed and changed ones set back to their value from before the call; the error says
    which, and names any it could not remove or restore. Members other code (another
    extension, a startup script) put there before the call are left alone. A script that had
    already failed keeps its own error first.

**Changed**

- `cc_eval_script` and `ps_batch_play` are always registered and refuse — touching no app —
  while their gate is closed; they and `cc_get_capabilities` are now part of the default tool
  list.
- `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` takes `1` (now also `true` in any case, `all` or `*`) for
  every raw-capable app, or a comma list of app ids (`after_effects`, `photoshop`,
  `illustrator`, `audition`; the short names `ae`, `ps`, `ai`, `au` work too). Premiere Pro,
  Media Encoder and unknown names are ignored with a warning, never enabled.
- `=1` / `all` now actually reaches Illustrator: its raw scripts go through the OS scripting
  lane, which launches Illustrator if it is closed. A runner failure after the script may have
  reached Illustrator — AppleScript giving up on the reply, Illustrator crashing or quitting
  mid-script — gives the JSON envelope "the script was sent; it may have partly run — check
  Illustrator before re-running". Only failures that provably happen before dispatch are plain
  text (the runner cannot start; COM cannot create the object, e.g. class not registered;
  AppleScript -600, -1728, -1743, -10814: app not running, not found, Automation not allowed),
  and a failure the lane cannot classify counts as sent. A call that leaves no result file says
  so and names the likely causes (a modal dialog, a temp file that could not be read or
  written); the script's own syntax errors come back as `ok: false`. The typed `ai_*` tools
  show the same messages as before.
- Remote (shared HTTP) sessions refuse raw scripts unless the new
  `BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1` is set.
- `cc_eval_script` refuses an app whose tools are not enabled (`BRAINFERNO_MCP_APPS`): the
  refusal says to rerun the installer and pick the app, or to set `BRAINFERNO_MCP_APPS` to the
  full list of apps, since it replaces the installer's choice rather than adding to it.
  `timeoutMs` is capped at 30 minutes.
- `cc_eval_script`'s description points After Effects work to `ae_run_script` when After
  Effects' tools are enabled (AE-01). Its `script` parameter now carries the ES3 rules and says
  how to return an object literal: wrap it in parentheses, since a bare `{ a: 1 }` on the last
  line is a block and returns 1. That keeps the description within the 2,048 characters Claude
  Code shows of a tool description; a test now checks every tool's description and parameter
  texts against that limit. Its error-shape sentence names the new project-switch refusal; to
  fit, the plain-data list and "to the server log" were cut.
- New audit line for every raw call, run or refused, on every raw-script tool (`ps_batch_play`
  had none): `AUDIT raw-script tool=… app=… sha256=<12 hex> len=… [count=…] via=stdio|http:<8 chars> outcome=run|refused[ consent=flag|needed]`
  (`consent` only on `ae_run_script` calls whose script closes or replaces the open project:
  `needed` on the refusal, `flag` on the run after it; see AE-01). It is written at every log
  level and carries no script text; the first 200 characters of a
  script that runs moved to the `debug` log (`cc_eval_script` used to put them in a `warn`
  line; see Fixed). When the gate is open the server writes one
  `AUDIT raw scripts ENABLED for …` line at startup; the "raw-script tool is disabled" info
  lines are gone.
- Errors from the typed After Effects tools (AE-16; not `ae_run_script`, whose envelope passes
  the host's message on unchanged) are one paragraph naming the tool and its arguments, where
  it failed (`at body line N (script line M)` with the failing line and its neighbours,
  `in helper __x`, or `outside this tool's own code` for an error the panel hit while
  converting the result) and what to do next; the old `(line N)` was a line of the generated
  script. Every error the tools raise ends with its own next step; a message too long to show
  whole (a long file path, a long expression error) is cut, and its own step follows the cut.
  A generic step is added only to an error After Effects raised itself, and it fits where that
  happened (inside a shared helper it no longer blames the arguments you passed). A ` — `
  inside a quoted name never counts as a next step. Echoed arguments are cut (80 characters
  per string, 5 items per array, 300 overall), lose any bidi override, and never show the
  server's keys or tokens;
  neither does the host's message, even where After Effects cut a listed name part-way
  through one, except where that cut falls less than 8 characters into a key: those (at most
  7) characters stay, too few to recognise as a key. No error-code prefix. Other apps' script
  errors read exactly as before.
- After Effects lookups explain themselves (AE-16): a bad `compId` lists the compositions (or
  says how to make one), and so does an unknown `compName` in `ae_queue_render`; an
  out-of-range `layerIndex` lists the range and each layer's name and kind; a property path
  that does not resolve names the layer and its kind, the resolved part, the failing segment
  and the child names in the vocabulary the path used (match names or display names; shape
  groups, masks, effects and text animators by name), or says the group exists only on another
  kind of layer, or that it is empty (an empty effect or mask list also names the tool that
  fills it); `ae_set_effect_param` lists the layer's effects or the effect's parameters. When
  names repeat among the children, listed or not, the message names them and the advice fits
  what can be done: rename them where After Effects allows it, otherwise pass the effect's
  index or the match name. Each repeated parameter is listed with the match names of its
  copies (just the numbers when, as on an effect, each is the effect's match name and a
  number: Card Dance's eight Offsets read `"APC CardDanceCam-" + the number: "Offset": [0022,
  0028, …]`), the one nearest the name asked for first; any that do not fit are counted. A
  child with an empty name (Card Dance ends each of its 12 topics with one) is left out of
  lists by name, their counts and the repeated names, since no one can pass that name.
  `ae_set_text`, `ae_add_mask` and the layer-style tools name the layer and kind, and the
  layer-style tools say which tool adds a style or lists the ones there. Lists are cut by
  length so a message that lists names fits the server's cap whole, advice included.
- "Did you mean" (AE-16): `ae_apply_effect` suggests up to 3 installed effects
  (`ADBE Gausian Blur 2` → `ADBE Gaussian Blur 2`), reading the installed list once per session
  on the first miss and again after the panel reconnects (a filtered read when the full list is
  slow); a name that differs from an installed match name or display name only in case gets
  that name as After Effects spells it, with a note that case counts, and an installed effect
  After Effects would not add to the layer, by match name or display name, gets a note instead
  of guesses (verified live on After Effects 26.5: match names are case-sensitive, and display
  names are accepted).
  Property, effect and parameter misses suggest from the names they list, leaving out a name
  that repeats, in the list or past it, since it cannot pick one item; when such a name is as
  near the name asked for as any (`Z Positon` on Card Dance), no name farther from it is
  suggested either: you most likely meant it, and the advice says how to reach it where the
  tool has a way (by match name for effect and layer-style parameters, by the effect's index,
  or by renaming where After Effects allows it). `ae_apply_effect` takes an effect name of at
  most 1024 characters.
- After Effects scripts are sent as pure ASCII (AE-16): non-ASCII characters travel as `\uXXXX`
  escapes; the result is the same text.
- All apps (AE-16): a panel older than the server (`UNKNOWN_COMMAND`) now says to update or
  reload the panel instead of "Script failed" (quoting the panel's text on one line, keys and
  tokens removed); a panel that disconnects mid-call says the call
  may have partly run and how to reconnect — in a tool's error, instead of "Unexpected
  failure" (and it is logged at `warn`, no longer as an unhandled error), and in a failed job
  step (`ae_render_comp`, `pp_export_sequence`, the pipelines), instead of the bare disconnect
  message.

**Added**

- `cc_get_capabilities` (read-only, contacts no app): server and protocol versions, whether the
  session is local or remote, the raw-script gate, one row per gated tool (enabled, how to
  enable it, app connected, panel supports the command), and each panel's version and host
  version.
- The hub now keeps each panel's `panelVersion`, `hostVersion` and `capabilities` from its
  hello (`BridgeServer.panelInfo`).
- `ae_run_script` (AE-01): a raw ExtendScript in After Effects as one undo step, for multi-step
  work the typed `ae_*` tools do not cover. Like `cc_eval_script` it is always listed, refuses
  — touching no app — unless `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` includes After Effects (and,
  for a remote session, `BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1`), runs the script through
  the same wrapper, returns the same envelope and writes one audit line per call.
  - The whole call runs in one undo group named `undoGroupName` (default `Brainferno script`):
    one Ctrl-Z undoes everything it changed, including what a script that failed part-way
    changed. Opening, creating or closing a project, or importing an `.aep`, inside the script
    is outside that guarantee, and so is what the script saves or writes (a saved project,
    files, renders, preferences): it stays changed.
  - `args` reaches the script as `__args` (`{}` when omitted), sent as a pure-ASCII ES3
    literal: plain JSON data, at most 32 levels deep. Deeper data, a number that is not finite
    or a nested `__proto__` key is refused before anything is sent. The `args` text says what
    After Effects does with numbers: it reads one below about 2.2e-308 as 0, and writes numbers
    in the result with 15 significant digits (`0.1 + 0.2` comes back as `0.3`); strings arrive
    exactly.
  - `suppressDialogs` (default `true`) suppresses and discards After Effects' own warning
    dialogs while the script runs. The texts name the ones verified on After Effects 26.5 (an
    export warning, and the missing-font dialog when the script opens a project) and promise no
    more. With it on, a script that opens or creates another project (`app.open`,
    `app.openFast`, `app.newProject`) while the open project has a file and unsaved changes gets
    no save prompt: After Effects saves the open project over its file (seen live). On a project
    with no file, `app.open` still showed the save prompt, which blocks After Effects;
    `app.openFast` and `app.newProject` on such a project were not tried. The description warns of
    this, and the `suppressDialogs` text says to close with
    `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)` first to discard the changes.
  - A script that closes or replaces the open project (it calls `app.open`, `app.openFast`,
    `app.newProject`, `app.project.close`, `app.quit` or `app.restart`, with a dot or as a quoted
    name in brackets, or names `CloseOptions`) is never sent on its first call. The tool reads
    the open project (read-only) and refuses in plain text with the file name, whether there are
    unsaved changes, and, for each call, what the live run saw After Effects do with them or that
    it was not tried (a close counts as one `CloseOptions` value only when its own argument is that
    value written out; any other close the scan sees gets each value's outcome, as the README
    details; with two switch calls or more,
    the later ones act on the project the first leaves open, and the refusal says so); the model
    passes that on and asks the operator in the chat. Only if they agree does it call again with
    the same script, `args` (as sent; left out counts as `{}`) and `suppressDialogs` and the new
    `allowProjectSwitch: true` (default false), which runs that call once, within 10 minutes of
    the refusal, in the same session (one MCP connection); a flag with no such refusal gets the
    refusal instead. The approved call does not read the project again, and the refusal says to
    call without the flag for a new one if the project changes first. A read-only check that
    fails, or a call the client cancelled during it, records no refusal. In a shared session the
    refusal says that the person in the chat answers for whoever is at After Effects. The server
    cannot tell whether the operator was asked: the guard makes sure the model got the refusal,
    with the risk, first. There is no question in the MCP client: in the live check, Claude Code
    2.1.296 in a Windows 11 terminal, in three tries (auto mode twice, manual once), advertised
    MCP form elicitation, did not show the question, and answered
    `accept {allowProjectSwitch: false}` by itself (no Elicitation hook in user or project
    settings; managed settings not checked conclusively). Seen live on After Effects 26.5 on an
    earlier build of this tool (older refusal wording, a flag with no refuse-first guard): a
    plain-text refusal, a flagged run, and what the calls tried did with unsaved changes (spike
    06, which lists what was not tried). The refuse-first guard, the current refusal text and the
    risk texts are unit-tested only.
  - The tool owns the undo group and the dialog suppression, so a script that names
    `app.beginUndoGroup`, `app.endUndoGroup`, `app.beginSuppressDialogs` or
    `app.endSuppressDialogs` — even in a comment or a string — is refused before it is sent.
    If one of the tool's own end calls fails after the script ran, the envelope reports it in
    `error.message` (after the script's own error, if it had one) and keeps the script's value
    and logs; if it fails after the call itself threw outside the script (the wrapper or a
    begin call), the note follows that error's message.
  - A bare `alert`, `confirm` or `prompt` written in the script's own text fails the call
    (`line` and `bodyLine` `null`) instead of opening a dialog that would block After Effects,
    and says what to do instead: `__log(msg)` for `alert`; pass the answer in `args` for
    `confirm` and `prompt`. Nothing else is stopped: `Window.alert`, `$.global.alert`,
    `this.alert`, a `$.evalFile`'d library or a global helper that calls them, ScriptUI dialogs
    and file or folder pickers still open a modal dialog.
  - The description fits the 2,048 characters Claude Code shows, with the safety text first
    (what the tool does and its one undo step, the error-shape rule, the modal-UI warning, the
    project switch (the auto-save hazard and the operator's OK in the chat), the gate, the
    envelope); the detail is in the parameters' texts.
  - Plain-text errors mean your script was not sent: raw scripts disabled, a remote session,
    args refused, a managed call named, a project switch not approved (only the read-only check
    ran), After Effects not connected. A JSON envelope means the
    script was sent and may have partly run; `bodyLine` counts lines of the caller's script,
    and the host's message is passed on unchanged: without AE-16's tool-and-arguments context,
    so the server echoes neither the script nor `args`, and without its key and token
    redaction.
  - `timeoutMs` (at most 30 minutes) overrides the slow timeout; a timeout stops the wait, not
    the script.
  - The audit payload is the JSON of `{ script, args }`, with `args` `{}` when left out (as the
    script gets it); a call whose `args` are nested too deeply to serialize is still audited,
    once.
  - `cc_get_capabilities` has an `ae_run_script` row.
  - Verified live on After Effects 26.5 (Windows 11, 2026-10-12): one Ctrl-Z for a multi-layer
    script with "Undo <undoGroupName>" in the Edit menu, `bodyLine` for a runtime, native, syntax
    and thrown error, the shims and `__args`, the refusals, a project switch, the dialog scope
    above, and later calls waiting behind a timed-out script. Still unit-tested only: the
    end-call notes (After Effects' second `endUndoGroup` does not fail, and ExtendScript has no
    getter literals to make the wrapper throw), the refused audit line with the gate off, and
    `Window.alert` or global code that calls `alert`. Not tried live: `app.quit` and
    `app.restart`; `app.openFast` and `app.newProject` with suppression off or on a never-saved
    project; `close(SAVE_CHANGES)` with suppression on; `close(PROMPT_TO_SAVE_CHANGES)` with
    suppression off; `close(SAVE_CHANGES)` or `close(PROMPT_TO_SAVE_CHANGES)` on a never-saved
    project; `app.open` with suppression off on a never-saved project;
    `close(DO_NOT_SAVE_CHANGES)` with suppression off on a never-saved project. A script could not
    wrap `app.open`, `app.newProject` or `app.project.close` at run time (assigning to them
    changed nothing; the other calls and other ways to wrap were not probed), so the text scan is
    the only guard.
  - Shared core, for architect review: `server.ts` passes the raw-script gate to
    `registerAfterEffectsTools`, whose options now require `rawScriptApps`, `remote` and
    `allowRemoteRawScripts`; `raw-script.ts` gains `auditJson`, an audit payload builder that
    always returns a string and never throws, taking its fallback already serialized
    (otherwise comment edits); `diagnostics.ts` gains the capabilities row and the
    `cc_eval_script` description and `script` parameter changes (see Changed); `config.ts`
    changes comments only. `raw-script.ts`'s `auditRawCall` takes an optional `consent`
    (`flag` or `needed`, written last as ` consent=…`; other tools' lines unchanged), and its
    error-shape comment names the project switch; `diagnostics.ts`'s `cc_eval_script` imports
    `projectSwitchCalls` and `evalSwitchRefusal` from `after-effects.ts` and refuses an After
    Effects project switch.

**Fixed**

- `cc_eval_script` for Illustrator always failed with "not connected": it was routed to the
  panel hub, where Illustrator has no panel. It now uses the same OS scripting lane as the
  `ai_*` tools.
- `ps_batch_play` reported failed descriptors as success (see Breaking).
- The OS scripting lane left the temporary script and result files on disk when the runner
  failed or timed out. Both are now removed when the call ends, whatever the outcome. A result
  written by a script that outlives its timeout, or the files of a server killed mid-call, are
  swept on a later call (and at the next start) once they are older than twice the longest
  deadline a call can get (the 30-minute `timeoutMs` cap, or `BRAINFERNO_MCP_EVAL_TIMEOUT_MS`
  when that is longer) plus 5 minutes: 65 minutes with the default settings.
- macOS: typed `ai_*` calls with a deadline above about two minutes
  (`BRAINFERNO_MCP_EVAL_TIMEOUT_MS`) failed at AppleScript's default 120 s Apple-event timeout
  (-1712) while Illustrator kept running the script. `do javascript` now runs inside
  `with timeout of <deadline + 5> seconds`, so the server's own deadline is the one that fires
  (for `cc_eval_script`, as the timeout envelope).
- `cc_eval_script` wrote the first 200 characters of every script, unescaped, into a `warn`
  log line, so a script containing line breaks could add lines of its own to the server log.
  The excerpt (now at `debug`) is escaped onto one line, so a script cannot forge a log line
  such as an `AUDIT` record.
- After Effects (AE-16): a missing `compId` surfaced "internal verification failure, sorry!
  {Item Not Found}"; so did `ae_add_layer` with `kind: "footage"` and an unknown `itemId`,
  inside an undo group. Both now say what to pass, and the footage item is looked up before
  anything changes. `ae_set_layer_props` with an out-of-range `parentIndex` applied every
  other change before failing; the parent is now checked first. `ae_apply_effect` and
  `ae_set_effect_param` on a camera or light failed with a null error; they now say which
  kinds of layer take effects (null layers included). Job and pipeline errors from After
  Effects scripts kept only the bare host message, and `pipeline_ps_to_ae`'s own step checks
  named no next step. `ae_export_mogrt` with `overwrite: false` over an existing file reported
  the old file as written; it now refuses before saving or exporting anything.
  `ae_apply_effect`'s `matchName` and `ae_set_effect_param`'s `value` had no description.

**Docs**

- `CONTRIBUTING.md` (architect review): raw-script tools are always registered and refuse when
  gated; a new "Raw-script tools — one contract" section (envelope, error-shape rule, gate,
  audit); corrected two stale claims — UXP panels run named commands and never evaluate script
  strings, and the CEP panel defines its own `__acmJson` rather than loading `json2.jsx`.
- `docs/spikes/07-premiere-tools-live.md`: the Premiere Pro raw-script investigation — no eval
  path today, the `allowCodeGenerationFromStrings` lead, an operator probe, and why no
  `pp_run_action` was built.
- README (raw scripts section, configuration, security), `.env.example`, `docs/HANDOFF.md`,
  `docs/feature-requests/00_PREAMBLE.md` and spikes 05 and 14 updated to match.
- `CONTRIBUTING.md`: failed or cancelled jobs carry JSON errors too (the job view), so JSON is
  the dispatch signal only for the raw-script tools; the error-shape rule names the os-script
  lane's `RunnerExitedError`. `docs/HANDOFF.md` no longer counts `ps_batch_play` as verified
  live and no longer names a release by hand. `AE-01` is rebased on X-01 (reuse
  `raw-script.ts`, the shared refusal text, an undo group for `ae_run_script`), and
  `00_PREAMBLE.md` describes the After Effects test pattern as it is since X-03 (every exported
  script builder classified as `MUST_UNDO`, `NO_UNDO_OK` or `READ_ONLY_BUILDERS`;
  `es3Violations` in the new `test/es3.ts`) and drops its stale notes (CONTRIBUTING's
  `jsStringLiteral` text, tool counts and the `ae_queue_render` gap before X-03).
- AE-16: the AE-16 prompt corrections (no error-code prefix, no font promise, the fake-panel
  frame with `code: "HOST_ERROR"`, stale line cites; status in review, live verification done;
  the cross-app texts to call out for the architect), `IMPLEMENTATION_PLAN.md` superseded notes
  on error codes,
  `CONTRIBUTING.md` Errors (`ScriptError.details`, `scriptErrorText`, the disconnect text in
  tool errors and failed job steps) and its registration example (now an After Effects tool on
  `evaluateAe` and the `withToolContext` server), AE-03 / AE-04 / AE-14 / AE-01 / X-01 notes,
  `00_PREAMBLE.md` (the shared-core list gains `tools/raw-script.ts`; After Effects tools call
  `evaluateAe` and register through `withToolContext`; the error-test harness; every After
  Effects throw carries its own next step and quotes names with `__q`, also in
  `CONTRIBUTING.md` Errors), the README
  (what a tool error says; the security note now says which errors remove keys and tokens),
  `docs/protocol.md`, and spike 06 (how error lines are read, and the live probes on After
  Effects 26.5 on 2026-10-10 with their two follow-ups; `docs/HANDOFF.md` records that
  verification too).
  The After Effects prompts cite `after-effects.ts` by symbol instead of by line number, which
  AE-16 shifted (AE-02 to AE-10, AE-14).
- AE-01: `CONTRIBUTING.md` (architect review: `ae_run_script` among the raw tools, a fourth
  plain-text cause, `auditJson` in the audit rule, how `__args` enters and what wraps the
  wrapper, and the 2,048-character limit a client shows of a tool description), the README
  (the After Effects section, tool table, raw scripts, what a plain-text error means, security
  and the audit line; its status line now says every *typed* tool is verified live on Windows
  and macOS and `ae_run_script` on Windows), `.env.example`, `docs/HANDOFF.md` (an AE-01 bullet
  with the live results and what stays unit-tested only), `00_PREAMBLE.md`, spike 14 and the
  comments in `config.ts` and `tool-counts.test.ts` updated to match. Spike 06 has the AE-01
  live probes on After Effects 26.5 (2026-10-12), with the auto-save hazard, the number limits,
  the undo-label facts and, as an observation, `ae_open_project` leaving the missing-font
  dialog open. The AE-01 prompt is in review, with what the build changed (the refused
  begin/end calls, the dialog scope it promises, the project-switch carve-out, the shims and
  what they do not stop, the gate fields), acceptance 5 split into the save-and-export check
  and the open-time missing-font check, and the live results; its live verification is done.

## v0.3.3 — 2026-10-01

- Doc-drift guard (X-03): `tool-counts.test.ts` counts the live tool registry under the
  default config and fails, printing the right number, when a tool count in `README.md` or
  `docs/HANDOFF.md` disagrees. Fixed the stale counts it caught (After Effects 33 → 34, total
  124 → 127, and the per-prefix table), plus a stale env-var name and handshake path in the
  spike docs and a done item in `BUILD_PLAN.md`.
- After Effects test coverage (X-03): every exported script builder is now classified
  (read-only / undo-wrapped / app-level), so a new mutating tool can't silently skip the
  `__undo` and ES3 checks; `ae_queue_render` moved from an inline script to the exported
  `queueRenderScript` builder so it joins those checks.
- Repo guide (G1): added `CLAUDE.md` — a short front-door note (commands, non-negotiables,
  where the spikes/quirks/feature-requests live) that imports `CONTRIBUTING.md` and
  `docs/HANDOFF.md`. Added the `docs/feature-requests/` pack (one prompt file per feature,
  starting from `00_PREAMBLE.md`).
- `CONTRIBUTING.md` brought in line with the code (G2): script values go through
  `jsStringLiteral` (with the U+2028/U+2029 note), the actual-message error contract (no
  planned code prefix), `timeoutClass` + `runOrQueue`/`cc_job_wait` for long work, the two
  deliberate tool gates (raw-script escape hatches, Illustrator delegate), and a note that
  `tool-counts.test.ts` enforces the counts.
- Durable quirks moved into the repo (G4): five notes under `docs/quirks/` — AE layer styles,
  AE mogrt export, AE PSD/AI import, AE shapes/masks, and panel packaging — so every clone
  carries the hard-won gotchas instead of them living only in one machine's memory.
- `CLAUDE.md` accuracy (G8): the workspace list was missing the `bridge-client` package; added
  it (found via the `claude-md-improver` audit).

## v0.3.2 — 2026-09-30

- After Effects `ae_add_shape`: create a shape layer with a parametric rectangle, ellipse,
  star, or polygon plus an optional fill and stroke (hex colors, stroke width, corner
  roundness, star/polygon points and radii). Verified live.
- After Effects `ae_add_mask`: add a rectangle or ellipse mask to a layer in the layer's
  coordinates, with mode (add/subtract/intersect/lighten/darken/difference/none), feather,
  opacity, and expansion; ellipse masks use proper bezier handles. Verified live. (Solids
  and text layers were already available via `ae_add_layer`.)

## v0.3.1 — 2026-09-27

- **Codex CLI and Gemini CLI are first-class clients.** The installer registers the
  server with every MCP client CLI it finds (Claude Code, Codex CLI, Gemini CLI; filter
  with `--clients`), each with the env defaults that suit it. Three new env vars carry
  the differences: `BRAINFERNO_MCP_DEFAULT_WAIT` (false = long tools return a jobId at
  once, for Codex's 60-second tool timeout — the advertised `wait` parameter now states
  the live default), `BRAINFERNO_MCP_PREVIEW` (`path` returns previews as file paths for
  clients that cannot show the model images; `inline`, `both`), and
  `BRAINFERNO_MCP_JOB_WAIT_SECONDS` (the default `cc_job_wait` timeout, set to 50 for
  Codex so each poll returns inside its limit). Claude Code keeps exactly the old
  behavior. In shared mode the installer prints per-client connection snippets — Codex
  reads the bearer token from an env var, Gemini from a headers block.
- **Panel versions can no longer drift.** `npm run panels:stamp` writes the package
  version into the three panel manifests and each panel's `PANEL_VERSION`, and a test
  fails when a bump forgets it. v0.3.0 shipped with its panels still reporting 0.2.0
  (Photoshop, After Effects/Audition) and 0.1.0 (Premiere); from this release on they
  carry the package version.

Found while building a lower-third .mogrt skill end to end (Illustrator → Photoshop →
After Effects → Premiere):

- After Effects `ae_apply_effect` takes an optional `name` and renames the effect once
  applied. Essential Graphics labels a control with its effect name, so a Slider Control
  named `Speed` now shows as "Speed" in Premiere instead of "Slider Control".
- After Effects `ae_import_as_comp` takes optional `duration` and `frameRate`. Without them
  the imported comp came in at the project default (241 s) and every layer with it.
  Giving a duration also trims the layers to it, so outPoint-anchored outros land at the end.
- New After Effects tool `ae_set_comp_props`: name, duration, frameRate, width, height on an
  existing comp; a shorter duration trims layers the same way.
- After Effects `ae_add_layer` (text) and `ae_set_text` take `anchor: "center" | "origin"`.
  The default keeps the anchor at the text's visual centre; `origin` leaves it at [0, 0] so
  position is the left baseline — what a left-justified lower third wants. (Before, text
  placed by its left edge rendered half its width too far left.)
- After Effects `ae_add_layer_style` retries the Layer Styles menu command up to three times
  with a short pause, reselecting the layer each time. Seen live: the command did not take
  when other scripts were queued behind it and the tool failed with "menu command did not
  take".
- Known limit, not fixed: Premiere `pp_set_effect_param` cannot set a .mogrt text field
  (`Graphic Parameters` → text control); the UXP API rejects strings ("Illegal Parameter
  type") and reads the value back as null. Numbers (sliders) work.

## v0.3.0 — 2026-09-05

- After Effects `ae_import_as_comp`: import a layered Photoshop (.psd) or Illustrator (.ai)
  file as a composition — each source layer becomes its own AE layer, keeping blend modes,
  positions, and (for PSD) editable layer styles. `cropped` chooses Composition - Cropped
  Layers. Verified live: a PSD came in as three layers with its drop shadow editable in AE.
  (Illustrator maps top-level layers to AE layers, so put objects on separate layers to keep
  them separate; the file must be RGB and saved PDF-compatible.)
- After Effects Essential Graphics: `ae_add_to_essential_graphics` exposes a layer property
  (transform channel, a text layer's source text, or any property via propertyPath) as a
  control, and `ae_export_mogrt` exports the composition as a Motion Graphics template
  (.mogrt). Verified live against AE 26.3.
- Photoshop gradient overlay: `ps_set_layer_style` now takes `style: "gradientOverlay"` with
  `colors` (two or more hex stops), `gradientStyle` (linear/radial/angle/reflected/diamond),
  `angle`, `scale`, `reverse`, `alignWithLayer`, and `dither`.
- After Effects `ae_set_expression` now rolls the property back to its previous expression
  when the new one fails to compile (it used to leave the broken source assigned).
- Layer styles for Photoshop and After Effects. Photoshop: `ps_set_layer_style` (add or edit
  a drop shadow, inner shadow, glow, bevel & emboss, satin, color overlay, or stroke — other
  styles on the layer are kept), `ps_get_layer_styles`, `ps_remove_layer_style`. After
  Effects: `ae_add_layer_style`, `ae_set_layer_style_param`, `ae_get_layer_styles`,
  `ae_remove_layer_style` — friendly names map to AE's match names (satin → `chromeFX`,
  colorOverlay → `solidFill`, stroke → `frameFX`).
- New Premiere Pro tool `pp_insert_mogrt`: drop a Motion Graphics template (.mogrt) on the
  timeline at a time, like dragging it from the Essential Graphics panel. Without
  `videoTrackIndex` it lands on the first track above every video clip playing at that time,
  so the graphic sits over the picture.

## v0.2.2 — 2026-08-30

- The server reported itself as **0.1.0** to every MCP client and every panel, whatever
  version was actually installed — the string was typed out in four files and never bumped,
  so a 0.2.1 install still announced `serverInfo: 0.1.0` and the panels logged
  `welcome: server 0.1.0`. It now comes from `package.json` at runtime, in one place, and a
  test fails the build if a literal version reappears in the source. Found by installing
  0.2.1 from npm and speaking MCP to it.
- The Photoshop and After Effects/Audition panel manifests claimed 0.1.0 while the panels
  themselves reported 0.2.0; each manifest now matches the panel it describes.

## v0.2.1 — 2026-08-30

Housekeeping on top of 0.2.0: no new tools, nothing changed for an existing Windows or macOS
install.

- The installer now checks the platform before it does anything and exits saying that the
  Adobe applications this bridge drives run on Windows and macOS only. Previously it worked
  partway through and invented a `cep-extensions-unsupported` folder under the user's home;
  `pp_list_export_presets` likewise stopped offering a `~/Documents/Adobe` root on platforms
  where Adobe cannot be installed.
- `npm publish` no longer warns that the `bin` entries were "invalid and removed" — the paths
  lost their `./` prefix, which is the rewrite npm was doing silently. Both commands worked
  before and still do; the warning was noise on every release.
- Documentation names Windows and macOS as the supported platforms throughout, and the README
  status line and hand-off notes catch up with the 0.2 release.

## v0.2.0 — 2026-08-30

macOS brought up and verified live (Adobe 2026 apps), so both platforms Adobe ships Creative
Cloud for are now covered. Windows behaviour is unchanged, and CI runs the suite on Windows and
macOS. Details: `docs/spikes/13-macos-live.md`.

- **After Effects**: fixed the `aerender` path on macOS — `Folder.appPackage` is the `.app`
  bundle itself there, and `aerender` sits beside it. `ae_render_comp` and the render pipelines
  failed with "aerender not found" before.
- **Media Encoder** on macOS: find the console inside its nested bundle; read (and create)
  `ame_webservice_config.ini` in the app bundle's `Contents/Resources`, which is the only place
  the console looks — Adobe ships none, so the service used to start and never listen. The
  installer writes the file through Finder, since macOS "App Management" refuses bundle writes
  even under `sudo`, and `ame_server` now fails fast naming the path instead of timing out.
- **Media Encoder** on macOS: stop the hidden renderer the service starts. It runs in its own
  process group, so the previous group kill missed it and every idle stop leaked one; the driver
  now tracks only the renderer it caused and never touches an instance that was already running.
- **Illustrator** on macOS: pick which Illustrator the `ai_*` tools drive. The release and the
  Beta both ship a bundle named `Adobe Illustrator.app`, so an AppleScript name followed whichever
  was running. New `illustratorApp` config / `BRAINFERNO_MCP_ILLUSTRATOR_APP` accepts a name,
  bundle id or `.app` path; the installer detects both and asks.
- **Bridge**: the handshake file is no longer deleted by a second server instance that does not
  own it, and a server taking it over from a live one says so in the log. Panels reloading after
  an unrelated instance exited used to find no handshake at all.

## v0.1.0 — 2026-08-28

First public release.

- MCP server (stdio; optional token-protected Streamable HTTP for other computers) with a
  hardened loopback hub for the in-app panels.
- Panels: Photoshop and Premiere Pro (UXP), After Effects and Audition (CEP), each with a
  live log and a kill switch.
- Tools: Photoshop 18 · After Effects 24 · Premiere Pro 28 · Illustrator 7 (+ pass-through to
  Adobe's 46 Illustrator MCP tools) · Audition 12 · Media Encoder 6 (headless web service) ·
  audio/ffmpeg 9 · pipelines 4 · jobs 4.
- Job registry with progress, cancel, per-job work folders, and failure reports naming the
  step and its recovery tool.
- Installer: choose apps, local vs shared-on-network, Illustrator key, panel setup, Claude
  Code registration.
- Verified live on Windows 11 with the Adobe 2026 applications; macOS paths written but not yet
  run (done in the next release — see Unreleased).
