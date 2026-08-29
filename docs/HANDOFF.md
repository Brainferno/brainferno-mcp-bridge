# Hand-off notes (for a new Claude Code session, any machine)

Read this first, then `docs/BUILD_PLAN.md` (Phase 6) and the live-run notes in `docs/spikes/`.

## Where the project stands (2026-08-28)

- Public repo `Brainferno/brainferno-mcp-bridge` (renamed from `adobe-cc-mcp` for Adobe's
  trademark rules), Apache-2.0, `main` is the release branch. CI on every push (Ubuntu +
  Windows, Node 20/22). `v0.1.0` released; npm packages `brainferno-mcp-bridge` and
  `@brainferno/mcp-bridge-protocol` published with trusted publishing — a `vX.Y.Z` tag
  publishes and creates the GitHub release by itself.
- Everything is verified live on **Windows 11** with the Adobe 2026 apps: Photoshop 18,
  After Effects 24, Premiere Pro 28, Illustrator 7 (+ Adobe's 46 via `ai_beta_call`),
  Audition 12, Media Encoder 6, audio/ffmpeg 9, pipelines 4, jobs 4.
- **macOS has never been run.** The code has macOS paths (CEP folder, aerender, AME
  console, Illustrator via osascript, installer `defaults write` commands) — all unverified.

## Working routine that saved the most time

- Server change: `npm run build`, kill the running server (`pid` in
  `~/.brainferno-mcp-bridge/bridge.json`), then `/mcp` → brainferno → reconnect in Claude Code.
  A plain reconnect reuses the old process.
- UXP panel change (Photoshop, Premiere): reload in the UXP Developer Tool. CEP panel change
  (After Effects, Audition): close and reopen the panel.
- Batch several fixes per reload; every reload needs the operator's hands.
- After moving or renaming the repo folder, run `npm install` (workspace links break).
- ExtendScript stays ES3 (`var`, no arrow functions, no `JSON`). Each app has quirks listed in
  its spike doc — read the spike before touching that app's tools.

## First tasks on a Mac

1. `npm install && npm run build && npm test` (the ffmpeg test runs if `brew install ffmpeg`).
2. `npm run install-cc` — check what it prints for the CEP folder
   (`~/Library/Application Support/Adobe/CEP/extensions`) and the `defaults write
   com.adobe.CSXS.N PlayerDebugMode 1` step; fix `src/install/lib.ts` if a path is off.
3. Load the UXP panels in the UXP Developer Tool; open the CEP panel in After Effects;
   `cc_connected_apps` should list them.
4. Illustrator lane: `src/drivers/osscript.ts` uses `osascript` on macOS — run
   `ai_create_document` and `ai_get_preview`.
5. aerender path: `Folder.appPackage` differs on macOS — run `ae_render_comp` on a tiny comp.
6. Media Encoder: `ame_webservice_console` lives inside the app bundle on macOS —
   `ame_server start:true` tells you if `detectConsoleExe` found it.
7. Write `docs/spikes/13-macos-live.md` with what differed, and mark macOS verified in
   README "Status".

## Secrets and keys

Never commit keys. The Illustrator MCP key and the remote token live in
`~/.brainferno-mcp-bridge/config.json` (mode 600), written by the installer.
