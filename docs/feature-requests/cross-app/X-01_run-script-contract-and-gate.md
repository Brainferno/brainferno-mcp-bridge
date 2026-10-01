---
id: X-01
app: cross-app
title: One run-script contract and a gate that clients can see
priority: P1
status: open
evidence: verified
depends_on: []
---

# X-01 — One run-script contract and a visible gate

> Source-verified for the gate behavior (`config.ts`, `tools/diagnostics.ts`, `tools/photoshop.ts`). The Premiere paragraph is an **investigation** and is unverified.

## Problem
Raw-script escape hatches exist but are invisible and inconsistent.
- **Gate.** `cc_eval_script` (After Effects, Illustrator, Audition; `tools/diagnostics.ts:60-95`) and `ps_batch_play` (Photoshop; `tools/photoshop.ts:407-424`) are registered **only** when `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1` (`config.ts:267`). When off, the tools do not appear in the tool list, and the only trace is an info line on stderr. A client that needs a multi-step script never learns the capability exists or how to enable it.
- **Contradicts the repo's own rule.** `CONTRIBUTING.md`: "Tools are registered unconditionally — a closed app returns the actionable error, it does not vanish from the tool list."
- **Coarse.** One switch enables everything for every app.
- **Inconsistent contract.** `cc_eval_script` takes `appId`, `script`, `timeoutMs?`; `ps_batch_play` takes `descriptors[]`. Results and errors differ in shape. Premiere has no equivalent: its UXP panel exposes about 30 named commands and no eval (`packages/panel-uxp-ppro/commands.js`), and `cc_eval_script` excludes Premiere (`diagnostics.ts:21-22`).
- **Stale docs.** `docs/spikes/05-photoshop-tools-live.md:30` names `ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS`; the code reads `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS`.

## Add
1. **Register all raw-script tools unconditionally.** When the gate is off, a call returns: `Raw scripts are disabled. Set BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1 (or a comma list of app ids, e.g. after_effects,photoshop) in the MCP server env and restart.` Keep `destructiveHint: true`.
2. **Finer gate.** Accept `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` as `1` (all apps) **or** a comma list of app ids (`after_effects`, `photoshop`, `illustrator`, `audition`). Parse in `config.ts`; keep `allowRawScripts: boolean` for existing callers and add `rawScriptApps: string[]`.
3. **`cc_get_capabilities`** (new, `readOnlyHint: true`): returns per-tool gate state — `[{ tool, app, enabled, enableWith }]` — plus server and panel versions (see `X-02`).
4. **Shared result contract** for every raw-script tool: `{ ok, value, logs: string[], durationMs, error?: { message, line, bodyLine } }` (line correction: `AE-16`).
5. **Audit line** for every raw call (script hash, app, length), as `diagnostics.ts:92` already does — apply it to `ps_batch_play` too.
6. **Premiere (investigate, do not build blindly).** Find out whether the `premierepro` UXP API permits a gated script-eval or a generic action runner. If yes, add `pp_run_action` behind the same gate. If not, write the finding into `docs/spikes/07-premiere-tools-live.md` and add the missing **named** commands instead (see `PP-01` to `PP-05`).
7. Fix the env var name in `docs/spikes/05-…:30`.

## API hints
- `config.ts` already has `boolFromEnv` and `envValue` helpers (`BRAINFERNO_MCP_*`, with a legacy `ADOBE_CC_MCP_*` fallback and a one-time warning).
- `registerDiagnosticTools(server, bridge, { allowRawScripts, enabledApps })` in `server.ts:94`; `registerPhotoshopTools(..., { allowRawScripts })` at `server.ts:97`.

## Acceptance tests
1. Gate off: `tools/list` includes `cc_eval_script` and `ps_batch_play`; a call returns the message above and **does not reach the panel**.
2. `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=after_effects`: AE script works; Photoshop `ps_batch_play` still refused.
3. `cc_get_capabilities` reflects both cases.
4. A script error returns the shared error shape.
5. Update `server.test.ts` expectations (tool list now contains the tools when disabled) rather than deleting them.
6. Every raw call writes one audit log line.

## Definition of done
See `00_PREAMBLE.md`. Shared core (`config.ts`, `server.ts`, `tools/diagnostics.ts`, `tools/photoshop.ts`) changes — call it out for the architect.
