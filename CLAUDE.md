# brainferno-mcp-bridge

TypeScript MCP server (npm workspaces: `packages/server`, `protocol`, `bridge-client`, `panel-cep`, `panel-uxp`, `panel-uxp-ppro`) that lets an MCP client drive Adobe apps (Photoshop, After Effects, Premiere Pro, Illustrator, Audition, Media Encoder). Windows and macOS only.

@CONTRIBUTING.md
@docs/HANDOFF.md

## Commands
- `npm run typecheck && npm test` — must pass before every commit
- `npm run build` — then kill the running server pid (`~/.brainferno-mcp-bridge/bridge.json`) and `/mcp` → brainferno → reconnect (a plain reconnect reuses the old process)
- `npm run panels:stamp` — sync the six panel version spots after a version bump
- `npm run package` — build installable panels (.ccx / self-signed .zxp)
- `npm run install-cc` — installer (panels + client config)

## Non-negotiables
- ExtendScript (After Effects, Illustrator, Audition) is **ES3**: no `const`/`let`/arrow/template literals/`JSON.*`; one IIFE per script, helpers inside it
- Mutations go in `__undo("Name", fn)` (one tool call = one Ctrl-Z); dynamic values enter scripts only via `jsStringLiteral` (never raw concatenation)
- UXP (Photoshop, Premiere) uses modern JS; Photoshop mutations run inside `executeAsModal`
- Never `console.log` — stdout is the MCP wire; use `log` from `src/logging.ts`
- Tools register unconditionally; a closed app returns an actionable error, never a guess
- zod params each get `.describe()`; set `readOnlyHint`/`destructiveHint` honestly; pass `timeoutClass`
- Before editing an app's tools, read its spike in `docs/spikes/` and any note in `docs/quirks/`
- Never hand-type tool counts or versions in docs — `tool-counts.test.ts` enforces them

## Feature requests
`docs/feature-requests/` — one prompt file per feature; start with its `00_PREAMBLE.md`.
