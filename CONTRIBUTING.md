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
| Premiere Pro (≥ 25.6) | UXP | Modern JS via `require("premierepro")`; promise-based — scripts may return a Promise, the panel awaits it. |
| After Effects | ExtendScript | ES3. Wrap mutations in `app.beginUndoGroup`/`app.endUndoGroup`. |
| Illustrator | ExtendScript | ES3, via the os-script lane (COM / AppleScript — no panel). Scripts are one IIFE expression; put helper functions *inside* it. Coordinates are artboard-relative, y-down. |
| Audition | ExtendScript | ES3, undocumented API reached via CEP `evalScript`. |

**ES3 means:** `var` only — no `const`/`let`, no arrow functions, no template
literals, no `JSON` global (the CEP panel loads `json2.jsx`), no
`Array.prototype.map`/`filter`/`forEach`. Reviewers grep ExtendScript strings
for `const `, `let `, `=>`, `` ` `` and `JSON.` — any hit is a rejection.

## Script conventions

- Every script is a single IIFE whose final expression is the JSON-serializable
  return value: `(function () { ... return value; })()` in ExtendScript,
  `(() => { ... })()` or `(async () => { ... })()` in UXP.
- Interpolate dynamic values into scripts **only** through `JSON.stringify` on
  the TypeScript side (see `renderQueueScript` in `packages/server/src/tools/after-effects.ts`).
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
  `AppNotConnectedError` message, it does not vanish from the tool list.

## Annotations — set honestly

- `readOnlyHint: true` on every tool that cannot change host state.
- `destructiveHint: true` on delete/overwrite/save/flatten and on raw-script
  escape hatches.
- `idempotentHint: true` only where re-running with the same args is a no-op.

## Errors

`guard()` converts typed bridge failures into readable tool errors. Error text
always says what happened **and what to do next**. Planned error codes
(`APP_NOT_CONNECTED`, `SCRIPT_ERROR`, `TIMEOUT`, `JOB_FAILED`, `PATH_DENIED`)
prefix the message once the Phase A hardening lands.

## Timeouts

The default eval timeout comes from config. Tools whose operation is known-slow
(exports, renders, big imports) pass an explicit `timeoutMs` via `EvalOptions`;
anything longer than ~2 minutes must become a job (Phase A step 3) instead of a
long-blocking call.

## Process rules

- **stdout is the MCP wire.** Never `console.log`; use `log` from
  `packages/server/src/logging.ts` (stderr).
- Per-app work touches only `packages/server/src/tools/<app>.ts`, that app's panel glue, and
  `test/` — shared core (`src/bridge/`, `src/server.ts`, `packages/server/src/tools/result.ts`,
  `src/apps.ts`) changes go through the architect.
- `npm run typecheck && npm test` must pass before every commit. Tests use the
  in-memory MCP transport plus a fake panel over a real WebSocket
  (`packages/server/test/server.test.ts`) — new tools get at least a not-connected-path test,
  and a round-trip test where behavior warrants it.
