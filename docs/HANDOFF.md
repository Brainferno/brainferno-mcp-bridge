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
- **macOS run on 2026-08-28** (macOS 26, Adobe 2026 apps, Node 26): panels, Illustrator via
  osascript, previews, ffmpeg all fine as written. Two real bugs fixed — the aerender path
  (`Folder.appPackage` is the `.app` itself on macOS) and Media Encoder (nested console bundle,
  the ini must exist in the outer bundle's `Contents/Resources`, the renderer must be tracked
  and SIGKILLed on stop). Details and the reasoning: `docs/spikes/13-macos-live.md`.

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

## macOS specifics to keep in mind

- Media Encoder's console only listens when
  `/Applications/Adobe Media Encoder <year>/Adobe Media Encoder <year>.app/Contents/Resources/ame_webservice_config.ini`
  exists. Adobe ships none. The installer creates it; a terminal cannot write into the bundle
  (App Management protection, even with sudo) so the installer hands the copy to Finder via
  `osascript`. `ame_server start:true` fails fast with that path when the file is missing.
- Stopping the service: the hidden renderer is not in the console's process group; the driver
  SIGKILLs the renderer it started (SIGTERM makes Adobe's crash reporter pop up instead).
- Never `pkill -f` with a pattern that appears in your own command line (a shell running the
  command matches itself). Use `pkill -x <name>`.
- Trace which file a black-box Adobe binary opens with `fs_usage -w -f filesys` as admin
  (`osascript -e 'do shell script "…" with administrator privileges'` when there is no TTY for sudo).
- Illustrator release and Beta share the bundle name `Adobe Illustrator.app`, so an AppleScript
  *name* follows whichever is running. Pin the lane with `illustratorApp` in
  `~/.brainferno-mcp-bridge/config.json` (a bundle id: `com.adobe.illustrator` /
  `com.adobe.illustratorBeta`) or `BRAINFERNO_MCP_ILLUSTRATOR_APP`; the installer asks.

## Secrets and keys

Never commit keys. The Illustrator MCP key and the remote token live in
`~/.brainferno-mcp-bridge/config.json` (mode 600), written by the installer.
