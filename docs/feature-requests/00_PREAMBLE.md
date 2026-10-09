# 00_PREAMBLE — paste this first

You are working in the `brainferno-mcp-bridge` repo: a TypeScript MCP server for Adobe apps (v0.3.2 when this pack was written). You will be given **one prompt file at a time** from this folder. Build exactly what that file asks, to the repo rules below. One prompt file = one branch = one PR.

## Read before you write code
1. `CONTRIBUTING.md` — the frozen tool-interface contract.
2. `docs/protocol.md`, `docs/HANDOFF.md`, `docs/BUILD_PLAN.md`.
3. The spike notes for the app you touch:
   - After Effects: `docs/spikes/04-aftereffects-cep.md`, `06-aftereffects-tools-live.md`
   - Photoshop: `03-photoshop-uxp.md`, `05-photoshop-tools-live.md`
   - Premiere Pro: `07-premiere-tools-live.md`
   - Illustrator: `02-illustrator-osscript.md`, `12-illustrator-beta-sweep.md`, `docs/illustrator-beta.md`
   - Audition: `08-audition-tools-live.md`
4. The tool file for that app (`packages/server/src/tools/<app>.ts`) and its test in `packages/server/test/`.

## Hard rules (reviewers reject violations)
- **Naming.** Prefix per host: `ps_` `pp_` `ae_` `ai_` `au_`; `cc_` for cross-app. Verb-object (`ae_create_comp`). `title` is `"<App>: <what it does>"`.
- **ExtendScript is ES3** (After Effects, Illustrator, Audition): `var` only. No `const`, `let`, arrow functions, template literals, `JSON.` global, or `Array.prototype.map/filter/forEach`. Reviewers grep for `const `, `let `, `=>`, `` ` `` and `JSON.`. UXP (Photoshop, Premiere) uses modern JS; Photoshop mutations run inside `executeAsModal`.
- **One IIFE per script**; its final expression is the JSON-serializable result. Helper functions go *inside* it.
- **Mutations are wrapped in `__undo("Name", fn)`** so one tool call is one Ctrl-Z.
- **Dynamic values go into scripts only through `jsStringLiteral`** (`packages/server/src/bridge/script-escape.ts`). It also escapes U+2028 and U+2029, which a raw `JSON.stringify` would leave in place (CONTRIBUTING says the same since `G2`). Use the `lit`/`opt`/`num` helpers built on it. Never concatenate raw input into script source.
- **zod raw shapes**: every parameter has `.describe()`, and optional ones state their default. Reuse the shared schemas (`compId`, `layerIndex`, near `after-effects.ts:958-959`).
- **Annotations, set honestly**: `readOnlyHint` on anything that cannot change host state; `destructiveHint` on delete / overwrite / save / flatten / raw-script tools; `idempotentHint` only when a repeat call is a no-op.
- **Errors**: expected failures `throw new Error("<what happened> — <what to do next>")`. Host lookups by id or name fail loudly; never act on a guessed default.
- **Timeouts**: pass `timeoutClass` (`"fast"`, `"slow"`, `"render"`). Anything over about 2 minutes becomes a job through `runOrQueue`.
- **No `console.log`** — stdout is the MCP wire. Use `log` from `packages/server/src/logging.ts`.
- **Shared core** (`packages/protocol/`, `packages/server/src/bridge/`, `server.ts`, `tools/result.ts`) changes go through the architect (the repo owner). If a prompt needs one, say so in the PR.
- **Never** commit keys or tokens, copy code from Adobe sample repos, or paste Adobe-authored documentation. Use full Adobe product names in user-facing text.

## Tool pattern
```ts
server.registerTool(
  "ae_get_comp",
  { title: "After Effects: comp details with layers", description: "...",
    inputSchema: { compId }, annotations: { readOnlyHint: true } },
  async ({ compId: id }) => run(getCompScript(id), { timeoutClass: "fast" }),
);
```
`run` is `guard(async () => jsonResult(await bridge.evaluate(script, opts)))`. Export every script builder (`xxxScript(...)`) built with `wrap`, `lit`, `opt`, `num` so tests can reach it.

## Test pattern (After Effects; copy it for other apps)
File: `packages/server/test/after-effects-tools.test.ts`.
- `SAMPLES` map: one entry per exported script builder, called with sample arguments (include a string with quotes so escaping is exercised). Every sample must pass `es3Violations(src)` (exported from `packages/server/test/es3.ts`).
- **Classify every exported `xxxScript` builder** (an exported function whose name ends in `Script`) in one set: `MUST_UNDO` (it mutates, so its script must contain `__undo(`; also add a sample call for it in the "every MUST_UNDO builder wraps its mutation in an undo group" test, which fails without one), `NO_UNDO_OK` (it changes state but legitimately has no undo group, such as an app-level open/save, a self-cleaning preview or an export; say why in the comment), or `READ_ONLY_BUILDERS` (it only reads). Read-only script constants such as `LIST_COMPOSITIONS` go in `READ_ONLY_CONSTS`. The "classifies every exported script builder" test finds the builders by that name pattern and fails for one in no set, and for a `MUST_UNDO` / `NO_UNDO_OK` / `READ_ONLY_BUILDERS` entry that is not an exported builder. That is all it checks: it does not discover constants (keep `READ_ONLY_CONSTS` by hand), it does not check that a name is in only one set, and helpers not named `...Script` are not classified — `aerenderExecutable` sits in `READ_ONLY_BUILDERS` as the one hard-coded exemption from the stale-entry check.
- The escaping test ("escape strings as JS literals") checks only a few samples: add a `toContain` assertion that your builder's string arguments come out escaped.
- Add targeted `toContain` assertions for the new behavior.
- Add a not-connected-path test, and a round-trip test with the fake panel in `packages/server/test/server.test.ts` where behavior warrants it.

## Definition of done (every prompt)
1. `npm run typecheck && npm test` pass.
2. `CHANGELOG.md` has an entry under `## Unreleased`.
3. Tool counts: **never hand-write them.** Since `X-03`, `packages/server/test/tool-counts.test.ts` counts the live registry and fails, printing the right number, when the README's per-app headers or total, or the "Expect N tools" line in `docs/HANDOFF.md`, disagree — copy the number it prints.
4. The matching spike doc gains a line for any new quirk you hit.
5. Live-verify on a real Adobe app when the prompt says so:
   - Server change: `npm run build`, kill the server pid in `~/.brainferno-mcp-bridge/bridge.json` (`taskkill /PID <pid> /F`), then `/mcp` → `brainferno` → reconnect. A plain reconnect reuses the old process.
   - UXP panel change (Photoshop, Premiere): reload in the UXP Developer Tool.
   - CEP panel change (After Effects, Audition): close and reopen the panel.
   - Stale servers can hold port 7897; kill them and delete a dead-owner `bridge.json` before reconnecting.
6. Open a PR with the prompt id in the title (for example `AE-04: fonts and text`).

## Evidence legend
- **verified** — the gap was hit and reproduced against After Effects 26.5 with server v0.3.2, and the source claims were checked in `packages/server/src/tools/after-effects.ts`.
- **unverified** — derived from the tool list and docs only. Every unverified file opens with a banner: *verify against current behavior before building.*

## Priorities
P1 = blocks real work or silently gives wrong results. P2 = large quality or speed gain. P3 = nice to have.

## Suggested build order
`X-03` → `X-01` → `AE-16` → `AE-01` → `AE-03` → `AE-02` → `AE-04` → `AE-05` → `AE-06` → `AE-07` → `X-02` → the P2 After Effects prompts → P3 → the other apps (start with the ones whose banner says the API is already confirmed).

## Raw-script gate (relevant everywhere)
Since `X-01`, `cc_eval_script` (After Effects, Illustrator, Audition) and `ps_batch_play` (Photoshop) are **always registered** and refuse every call — without touching any bridge — until `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` in the MCP server env names the app: `1` (or `all`) for all four, or a comma list of app ids such as `after_effects,photoshop`. Remote (shared HTTP) sessions stay refused unless `BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1`. `cc_get_capabilities` (read-only, contacts no app) shows the calling session the gate per tool. Both raw tools return the envelope `{ ok, error?: { message, line, bodyLine }, durationMs, value, logs }`; a plain-text error means nothing was dispatched, a JSON-envelope error means the script was sent and may have partly run. Gate parsing is in `config.ts`; the envelope, wrapper, gate check, refusal texts and audit line are in `packages/server/src/tools/raw-script.ts`, and a new raw tool (for example `AE-01`'s `ae_run_script`) reuses them — see the "Raw-script tools" section of `CONTRIBUTING.md`. Every raw call, run or refused, writes exactly one audit line; `raw-script.test.ts` shows how to assert it with a spy on `log.audit`.
