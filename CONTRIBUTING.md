# Contributing — the tool-interface style guide

This file is the frozen contract that per-app tool work builds against. Parallel
builders (human or agent) follow it exactly; changes to it go through whoever is
acting as architect, never through a per-app branch. The full design lives in
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Tool naming

- One prefix per host, plus one for cross-app tools:
  `ps_` Photoshop · `pp_` Premiere Pro · `ae_` After Effects · `ai_` Illustrator ·
  `au_` Audition · `cc_` shared/cross-app.
- Verb-object after the prefix: `ae_create_comp`, `ps_set_layer_props`,
  `pp_insert_clip`. List/get tools read as `<prefix>_list_<things>` /
  `<prefix>_get_<thing>`.
- `title` is `"<App name>: <what it does>"`. `description` says what the tool
  does, what it acts on (the operator's open project — there is no separate
  workspace), and anything the model must know to call it safely.

## Engines — the rule that breaks builds

| Host | Engine | Script style |
| --- | --- | --- |
| Photoshop | UXP | Modern JS. Mutations must run inside `executeAsModal`. |
| Premiere Pro (≥ 25.6) | UXP | Modern JS via `require("premierepro")`; promise-based — a command may return a Promise, the panel awaits it. Mutations run inside `lockedAccess` + `executeTransaction`, whose callbacks are synchronous. |
| After Effects | ExtendScript | ES3. Wrap mutations in `app.beginUndoGroup`/`app.endUndoGroup`. |
| Illustrator | ExtendScript | ES3, via the os-script lane (COM / AppleScript — no panel). Scripts are one IIFE expression; put helper functions *inside* it. Coordinates are artboard-relative, y-down. |
| Audition | ExtendScript | ES3, undocumented API reached via CEP `evalScript`. |

**UXP panels never evaluate script strings.** The server sends Photoshop and Premiere Pro
*named commands*; each panel implements them as functions in its `commands.js`
(`packages/panel-uxp`, `packages/panel-uxp-ppro`) and advertises the names in its hello
`capabilities`. Only the ExtendScript hosts run script source the server builds.

**ES3 means:** `var` only — no `const`/`let`, no arrow functions, no template
literals, no `JSON` global (ExtendScript has none, and nothing loads a polyfill: the CEP
panel's `host.jsx` and the os-script lane's wrapper each define their own small
`__acmJson` serializer), no
`Array.prototype.map`/`filter`/`forEach`. Reviewers grep ExtendScript strings
for `const `, `let `, `=>`, `` ` `` and `JSON.` — any hit is a rejection.

## Script conventions

- Every ExtendScript script is a single IIFE whose final expression is the
  JSON-serializable return value: `(function () { ... return value; })()`. UXP has no
  script to build: a Photoshop or Premiere Pro tool sends a named command
  (`bridge.execute("ps.fill", params)`), and the panel function behind it (modern JS, may be
  `async`) returns a JSON-serializable value.
- Interpolate dynamic values into scripts **only** through `jsStringLiteral`
  (`packages/server/src/bridge/script-escape.ts`), which also escapes the line- and
  paragraph-separator characters U+2028 and U+2029 that a raw `JSON.stringify` would leave to
  break the script. Use the `lit`/`opt`/`num` helpers built on it (see `after-effects.ts`).
  Never concatenate raw user input into script source.
- Throw `Error` with an actionable message for expected failures ("No project is
  open") — the bridge surfaces it as a `ScriptError`.
- Host lookups by id/name fail loudly (`throw`), never by acting on a guessed
  default — except where a tool documents "defaults to the active document".

## Registration pattern

Every tool goes through `server.registerTool` in its app's
`packages/server/src/tools/<app>.ts`, with the body wrapped in `guard()` from
`packages/server/src/tools/result.ts` and results built with `jsonResult`/`textResult` (and
`imageResult` once it exists):

```ts
server.registerTool(
  "ae_project_info",
  { title, description, inputSchema: { /* zod raw shape */ }, annotations: { readOnlyHint: true } },
  async (args) => guard(async () => jsonResult(await bridge.evaluate(SCRIPT))),
);
```

- Zod schemas: every parameter carries `.describe()`. Optional params state
  their default in the description.
- Tools are registered unconditionally — a closed app returns the actionable
  `AppNotConnectedError` message, it does not vanish from the tool list. The raw-script
  escape hatches follow the same rule: `cc_eval_script` (After Effects, Illustrator,
  Audition) and `ps_batch_play` (Photoshop) are always registered and *refuse* — before
  touching any bridge — unless `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` names the app (`1`/`all`,
  or a comma list of app ids) and, for a remote (shared HTTP) session,
  `BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1`. `cc_get_capabilities` reports that gate per
  tool. The one remaining registration gate is deliberate: the Illustrator-delegate tools
  register only with a configured key.

## Annotations — set honestly

- `readOnlyHint: true` on every tool that cannot change host state.
- `destructiveHint: true` on delete/overwrite/save/flatten and on raw-script
  escape hatches.
- `idempotentHint: true` only where re-running with the same args is a no-op.

## Errors

`guard()` converts typed bridge failures (`AppNotConnectedError`, `ScriptError`,
timeouts) into readable tool errors. Error text always says what happened **and what
to do next**; for expected failures `throw new Error("<what happened> — <what to do
next>")`. (Earlier drafts planned a code prefix such as `SCRIPT_ERROR:`; that was not
adopted — the actionable message is the contract.) The raw-script tools are the one place a
tool error carries JSON; see the next section.

## Raw-script tools — one contract

Every raw-script tool (today `cc_eval_script` and `ps_batch_play`) builds on
`packages/server/src/tools/raw-script.ts` — the envelope, the ES3 wrapper, the gate, the
refusal texts and the audit line live there once. A new raw tool imports them; it
re-implements none of them.

- **Envelope.** Results are `{ ok, error?: { message, line, bodyLine }, durationMs, value,
  logs, logsDropped? }`, built with `makeEnvelope` so the keys keep that order and the verdict
  survives a client truncating a long result. `error` is present only when `ok` is false and
  `logsDropped` only when it is above 0. `bodyLine` is the line in the caller's script when
  the host's numbering could be calibrated, else `null`; `durationMs` is the server round
  trip. `envelopeResult` returns an `ok` envelope as a normal JSON result and any other as
  `isError` with the envelope as its text.
- **Error-shape rule.** `isError` with **plain text** = nothing was dispatched (raw scripts
  disabled, app not enabled, app not connected). `isError` with a **JSON envelope** = the
  script or batch was dispatched and may have partly run. After dispatch, map `ScriptError`,
  `EvalTimeoutError` and `AppDisconnectedError` through `dispatchedFailure`; rethrow
  `AppNotConnectedError` (not dispatched) so `guard()` returns plain text. Say this rule in
  the tool's description.
- **Gate first.** Check `rawGateState(app, rawScriptApps, enabledApps, { remote,
  allowRemote })` before any bridge call; a refusal returns `errorResult(reason)` and calls no
  bridge at all. Refusals, in precedence order: the app's tools are not enabled on this
  server; the raw-script gate does not include the app; the session is remote and remote raw
  scripts are not allowed.
- **Audit every call.** Exactly one `auditRawCall` per call, run or refused. It writes
  through `log.audit`, which no log level silences, and records a hash and the length of the
  payload — never the payload itself.
- **ExtendScript enters only through `rawScriptWrapper`.** The caller's script becomes a
  pure-ASCII string literal (built on `jsStringLiteral`) that the ES3 wrapper runs with a
  direct `eval` inside its own inner function; the wrapper collects `__log` output and refuses
  a result that is not plain data.
- **Illustrator goes through the os-script lane** — the same `OsScriptBridge` instance the
  `ai_*` tools use, so its queue serializes them — never through the socket hub, where
  Illustrator has no panel.

## Timeouts

Pass a `timeoutClass` (`"fast"`, `"slow"`, `"render"`) in `EvalOptions`; the default
comes from config. Anything that can run longer than ~2 minutes (renders, big exports)
becomes a job through `runOrQueue` (`packages/server/src/tools/jobs.ts`) with a `wait`
parameter — `wait: false` returns a jobId at once and the client polls it with
`cc_job_wait`.

## Process rules

- **stdout is the MCP wire.** Never `console.log`; use `log` from
  `packages/server/src/logging.ts` (stderr).
- Per-app work touches only `packages/server/src/tools/<app>.ts`, that app's panel glue, and
  `test/` — shared core (`packages/protocol/`, `packages/server/src/bridge/`, `server.ts`,
  `tools/result.ts`, `tools/raw-script.ts`) changes go through the architect.
- `npm run typecheck && npm test` must pass before every commit. Tests use the
  in-memory MCP transport plus a fake panel over a real WebSocket
  (`packages/server/test/server.test.ts`) — new tools get at least a not-connected-path test,
  and a round-trip test where behavior warrants it.
- Panels carry no version of their own: `npm run panels:stamp` writes the server package's
  version into the manifests and `PANEL_VERSION` literals, and the suite fails if they drift.
- Tool counts in `README.md` and `docs/HANDOFF.md` are enforced by
  `packages/server/test/tool-counts.test.ts` — do not hand-edit a count; the test prints the
  right number. The per-app test pattern (the `SAMPLES` map, the ES3 and `__undo` coverage
  checks) is written up in `docs/feature-requests/00_PREAMBLE.md`.

## License of contributions

By contributing you agree that your contribution is licensed under the Apache License 2.0
(see `LICENSE`). Do not copy code from Adobe sample repositories or SDKs into this project;
read them for behavior and write our own. Never commit keys, tokens, or Adobe-authored
documentation text. Use full Adobe product names in user-facing text ("Adobe Photoshop
software"), never as verbs, nouns, or abbreviations, and never Adobe logos or icons.
