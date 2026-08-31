# Hand-off notes (for a new Claude Code session, any machine)

Read this first, then `docs/BUILD_PLAN.md` (Phase 6) and the live-run notes in `docs/spikes/`.

## Where the project stands (2026-08-30)

- Public repo `Brainferno/brainferno-mcp-bridge` (renamed from `adobe-cc-mcp` for Adobe's
  trademark rules), Apache-2.0, `main` is the release branch. CI on every push covers
  **Windows and macOS** on Node 20/22 — the two platforms Adobe ships Creative Cloud for, and
  so the only ones this software supports. (The extra build runner in `ci.yml` is just a fast
  machine for the platform-independent tests; the comment there explains it.)
  `v0.2.2` is the current release; npm packages `brainferno-mcp-bridge` and
  `@brainferno/mcp-bridge-protocol` published with trusted publishing — a `vX.Y.Z` tag
  publishes and creates the GitHub release by itself. See **Releasing** below.
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

## Releasing

Full write-up with the measurements and the failure modes: `docs/spikes/14-release-process.md`.

A `vX.Y.Z` tag is the whole release: `publish.yml` runs the tests, checks the tag against
both package versions, publishes both packages to npm over OIDC, and creates the GitHub
release from the matching `CHANGELOG.md` section. Pushing that tag is the irreversible step —
npm permanently burns a version number even if you unpublish it (and unpublish is only
possible for 72 hours). Everything before the tag is a normal commit you can amend.

- **Four version spots, not three**: `package.json` (root, private), `packages/protocol`,
  `packages/server`, **and** the `@brainferno/mcp-bridge-protocol` dependency inside
  `packages/server/package.json`, which is pinned to an exact version. Then
  `npm run panels:stamp` (writes the version into the three panel manifests and their
  `PANEL_VERSION` literals — `test/panel-versions.test.ts` fails if you forget) and
  `npm install` to refresh `package-lock.json`. The workflow refuses to publish unless the
  tag equals both package versions.
- **Nothing else carries the version by hand.** The server reads it from `package.json`
  (`src/version.ts`), and the README's npm badge tracks what is published — its prose used to
  name a version and went stale within a day, twice. Keep it that way.
- **Rename `## Unreleased`** to `## vX.Y.Z — <date>` before tagging; that heading is what the
  release-notes step greps for. Dry-run it:
  `awk -v tag=vX.Y.Z '$0 ~ "^## " tag "([ —-]|$)" {on=1;next} on && /^## / {exit} on {print}' CHANGELOG.md`
- **npm is slow to catch up.** The version endpoint went live 45 s–2 min after publish and the
  `latest` dist-tag took up to ~3.5 min more. In that window `npm install -g <pkg>` still gets
  the old version, and a client with a cached packument reports `ETARGET: No matching version`
  for a version that demonstrably exists — `--prefer-online` gets past it. The publish log's
  `+ <pkg>@<version>` line is the ground truth, not `npm view`.
- **npm's "Your package is being processed" notice is normal** for the server package (~190 kB):
  the small protocol package appears instantly, the big one lags. Not a half-publish.

### Verify a release the way the last one was verified

Install it somewhere isolated and make it talk, rather than trusting the workflow's green tick:

    npm install -g brainferno-mcp-bridge --prefix /tmp/t --prefer-online

then spawn `/tmp/t/bin/brainferno-mcp-bridge` with `HOME` pointed at a scratch directory (a
fresh-machine simulation — no user config, no remote-mode port to collide with the running
server) and speak JSON-RPC over stdio: `initialize`, `notifications/initialized`, `tools/list`.
Expect 113 tools and the right `serverInfo` version. Two false alarms this catches: without an
isolated `HOME`, the test instance reads the real `config.json`, tries to bind the shared-mode
port 7898 that the live server already holds, and dies with `EADDRINUSE`; and it will clobber
`~/.brainferno-mcp-bridge/bridge.json`, pointing the panels at a dead port on their next reload.

**This is how the version-drift bug was found, and the lesson worth keeping:** the server had
been telling every MCP client and every panel that it was `0.1.0` since the first release. The
version was typed out in four files — `serverInfo`, the panels' welcome frame, and two
client-identity strings — and none of them moved when `package.json` did. Nothing in CI could
notice, because every test agreed with the same wrong constant. It now comes from
`package.json` at runtime via `src/version.ts`, and `test/version.test.ts` both pins the value
and fails if a literal `version: "x.y.z"` reappears anywhere in the server source. Generalise
it: a fact that lives in more than one file will drift, and only an end-to-end check on the
built artifact will tell you.

## Picking it up on Windows

The project was built and verified on Windows first, then brought up on macOS (spike 13).
Everything below is what a fresh Windows session needs; the shared code changed since that
last Windows run, so step 6 is not optional.

1. **Prerequisites.** Windows 10/11, [Node.js](https://nodejs.org) 20+, git, Claude Code, the
   Adobe 2026 apps you want to drive, and ffmpeg for the audio tools (`winget install ffmpeg`).
2. **Get the code and check it builds.**
   `git clone` (or `git pull` on `main`), then `npm install && npm run build && npm test` —
   expect the full suite green. If the folder was moved or renamed, re-run `npm install`;
   workspace links break.
3. **Run the installer**: `npm run install-cc`. It asks which apps and local-vs-shared, then
   links the CEP panel (junction + `PlayerDebugMode` for CSXS 11–14), writes Media Encoder's
   `ame_webservice_config.ini` beside the exe in Program Files (one UAC prompt), opens or
   closes the firewall port, prints the UXP panel paths, and offers to register the server
   with Claude Code.
4. **Do not copy `~/.brainferno-mcp-bridge/config.json` from the Mac.** Two keys in it are
   machine- or platform-specific:
   - `illustratorKey` is a capability key for *that* machine's Illustrator — get a fresh one
     from Illustrator's MCP preferences and let the installer check it.
   - `illustratorApp` holds a macOS **bundle id** (`com.adobe.illustratorBeta`). On Windows
     that value is handed to COM as a ProgID and fails with "Could not reach Illustrator over
     COM". Leave it unset on Windows — the default `Illustrator.Application` is right — and
     set it only to pin a version, e.g. `Illustrator.Application.30`.
   `bridge.json` is regenerated by the server; never copy it.
5. **Open the panels.** After Effects / Audition: Window → Extensions → Brainferno MCP Bridge.
   Photoshop / Premiere Pro: load `packages/panel-uxp` and `packages/panel-uxp-ppro` in the UXP
   Developer Tool (Premiere needs Settings → Plugins → Enable developer mode, then a restart).
   Then `/mcp` → brainferno → reconnect, and `cc_connected_apps` should list them.
6. **Re-verify the lanes the macOS work touched.** Done on the primary Windows 11 machine
   2026-08-30 — all five checks below green against the live Adobe 2026 apps. Still required on
   any *other* Windows machine picking this up. The Windows branches were kept identical and
   are unit-tested, and CI runs the suite on Windows every push — but that does not replace a
   run against the real apps:
   - `ame_server start:true` then `ame_encode` — `detectConsoleExe` and the ini path were
     reworked (`iniPathFor`), and the service is stopped differently now.
   - `ae_render_comp` on a small comp — `aerenderExecutable` was rewritten.
   - `pp_list_export_presets` — `presetRoots` was restructured.
   - Kill and restart the server twice over and reload a panel — the handshake file is now only
     removed by the instance that owns it.
   - Ask the server its version (`/mcp` shows it, panels log `welcome: server X.Y.Z`): it must
     match the installed version, not `0.1.0`. That bug is fixed but was invisible for two
     releases.

## Secrets and keys

Never commit keys. The Illustrator MCP key and the remote token live in
`~/.brainferno-mcp-bridge/config.json` (mode 600), written by the installer.
