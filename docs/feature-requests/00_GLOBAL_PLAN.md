# 00_GLOBAL_PLAN — how the repo should use MD files, and the global fixes

Scope: the `brainferno-mcp-bridge` repo and the owner's Claude setup for it. Every change to the repo, `~/.claude.json`, Claude memory, or the installed panel **needs the owner's OK first.**

## Why
- The repo has **no `CLAUDE.md` or `AGENTS.md`**.
- Docs have drifted (tool counts, versions, an env var name, a path).
- Durable per-app knowledge sits in Claude memory (`~/.claude/projects/…brainferno-mcp-bridge/memory/`), which is not in git, so other clones and machines never see it.
- A stale duplicate memory folder from before the repo rename still exists.

## The rule: one fact, one home
| File | Holds | Does not hold |
|---|---|---|
| Repo `CLAUDE.md` (new, under 60 lines) | What the repo is; commands; the non-negotiables (ES3, one IIFE, `__undo`, `jsStringLiteral`, no `console.log`); "read `docs/spikes/<app>` before editing that app"; `@CONTRIBUTING.md` and `@docs/HANDOFF.md` imports | Copies of the style guide |
| `CONTRIBUTING.md` | The one tool-interface contract | Status, counts |
| `docs/HANDOFF.md` | Current state and routines (reload, release) | Hand-typed counts or versions |
| `docs/spikes/NN-*.md` | Durable per-app quirks learned live | Personal preferences |
| `docs/feature-requests/` (new) | This pack: one file per prompt plus `INDEX.md`; one prompt = one PR | Finished work (moves to `CHANGELOG.md` + spikes) |
| Claude memory | Personal and session-only facts, as one-line index entries | Anything the repo already says |
| `~/.claude/CLAUDE.md` (global) | The owner's cross-project preferences only | Project facts |

Working rules: link, never copy. Generate counts and versions; never type them by hand. Keep `CLAUDE.md` thin. Put status in frontmatter, not prose.

## Global fixes (do in this order; each needs the owner's OK)

### G1 — Add the repo `CLAUDE.md`, and the pack
Copy this folder to `docs/feature-requests/`. Add `CLAUDE.md` (draft at the bottom of this file).

### G2 — Fix `CONTRIBUTING.md`
- "Script conventions" says to interpolate with `JSON.stringify`. The code uses `jsStringLiteral` (`packages/server/src/bridge/script-escape.ts`), which also escapes U+2028 and U+2029. Update the text.
- The "Errors" section says error codes are "planned … once Phase A hardening lands." Update it to the current state.
- Add: the raw-script gate (`BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS`), `timeoutClass`, `runOrQueue`, and a pointer to the test pattern in `00_PREAMBLE.md`.
- The file calls itself frozen; the owner is the architect, so the owner approves this edit.

### G3 — Stop doc drift (full prompt: `cross-app/X-03`)
No test enforces any hand-written count today. Known stale numbers (actual After Effects count is 34):
- `README.md:19` "124 tools"; `:81` PS 21; `:88` AE **33**; `:98` PP 29; `:105` AI 7 (+46); `:111` AU 12; `:116` AME 6; `:121` audio 9; `:126` pipelines/jobs 8.
- `README.md:346-354` table: `ps_` 18, `ae_` **24**, `pp_` 28, `ai_` 7, `au_` 12, `ame_` 6, `audio_` 9, `pipeline_` 4.
- `docs/HANDOFF.md:16` "After Effects 24" (and PS 18, PP 28, AI 7, AU 12, AME 6, audio 9, pipelines 4, jobs 4); `:5-17` header says v0.2.2 is current (repo is v0.3.2); `:94-95` "Expect 127 tools".
- `docs/spikes/14-release-process.md:98` "125 tools (ps 21, ae 32, pp 29, …)".
- `docs/spikes/06-aftereffects-tools-live.md:33` "Tool inventory (24)".
- `docs/spikes/11-remote-mode-and-installer.md:15` "116 tools".
- `CHANGELOG.md:143` "After Effects 24".
Other drift:
- `docs/spikes/05-photoshop-tools-live.md:30` names `ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS`; the code reads `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS`.
- `docs/spikes/06-…:` shows `~/.adobe-cc-mcp/bridge.json`; the panel reads `~/.brainferno-mcp-bridge/bridge.json`.
- `docs/BUILD_PLAN.md:142` lists "MOGRT insert" as remaining, but `pp_insert_mogrt` exists.
- `packages/server/README.md` repeats counts but is generated (`scripts/prepack-server.mjs:21`); fix the source, not the copy.

### G4 — Move durable notes out of Claude memory into the repo
From `~/.claude/projects/…brainferno-mcp-bridge/memory/` into `docs/spikes/` (or a new `docs/quirks/`):
`ae-layer-styles`, `ae-mogrt-export`, `ae-import-psd-ai`, `ae-shapes-masks`, `panel-packaging`.
Keep `live-verify-routine` as memory (it is a personal routine; the same steps are in `HANDOFF.md`). Update `project-status` (it says v0.2.2) or delete it and rely on `HANDOFF.md` and `CHANGELOG.md`. Leave one-line pointers in `MEMORY.md`.

### G5 — Turn on the raw-script tools
Add `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1` to `mcpServers.brainferno.env` in `~/.claude.json` (the `env` object is empty today) and restart Claude Code. This enables `cc_eval_script` and `ps_batch_play`. They are raw-script escape hatches, so this is the owner's call. Prompt `X-01` makes the gate discoverable.

### G6 — Reinstall the After Effects panel
The only installed copy is `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\Brainferno MCP Bridge` with `PANEL_VERSION = "0.2.0"`. The server is 0.3.2. There is no dev junction in `%APPDATA%\Adobe\CEP\extensions` (the memory note describing one is out of date on this machine). New tools still work because the `eval` command is generic. Reinstall with `npm run install-cc`, keep exactly one install, and confirm which copy After Effects loads. Prompt `X-02` adds a version-mismatch warning.

### G7 — Remove the stale old-name memory and config
- Compare, then delete `~/.claude/projects/C--Users-Vince-Parker-Documents-GitHub-adobe-cc-mcp/memory/` (4 notes + `MEMORY.md`, duplicates from before the rename).
- Remove the `githubRepoPaths` entry for `adobe-cc-mcp` from `~/.claude.json` (that folder no longer exists).

### G8 — Audit the new `CLAUDE.md`
Run the installed `claude-md-improver` skill (plugin `claude-md-management`) on it.

## Draft `CLAUDE.md` for the repo (paste into the repo root; trim if over 60 lines)
```markdown
# brainferno-mcp-bridge

TypeScript MCP server (npm workspaces: `packages/server`, `protocol`, `panel-cep`, `panel-uxp`, `panel-uxp-ppro`) that lets an MCP client drive Adobe apps. Windows and macOS only.

@CONTRIBUTING.md
@docs/HANDOFF.md

## Commands
- `npm run typecheck && npm test` — must pass before every commit
- `npm run build` — then kill the running server pid (`~/.brainferno-mcp-bridge/bridge.json`) and `/mcp` reconnect
- `npm run panels:stamp` — sync panel versions after a version bump
- `npm run install-cc` — installer (panels + client config)

## Non-negotiables
- ExtendScript is ES3: no const/let/arrow/template literals/JSON.*; one IIFE per script
- Mutations go in `__undo("Name", fn)`; dynamic values only via `jsStringLiteral`
- Never `console.log` (stdout is the MCP wire) — use `log`
- Tools register unconditionally; a closed app returns an actionable error
- Before editing an app's tools, read its spike in `docs/spikes/`
- Never hand-type tool counts or versions in docs

## Feature requests
`docs/feature-requests/` — one prompt file per feature; start with `00_PREAMBLE.md`.
```

## What the repo session should do first
1. Read `README.md` and `00_PREAMBLE.md` in this folder.
2. Ask the owner which of G1–G8 to run (each one edits something outside the code).
3. Start the prompts in the order given in `00_PREAMBLE.md`.
