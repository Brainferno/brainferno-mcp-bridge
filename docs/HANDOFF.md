# Hand-off notes (for a new Claude Code session, any machine)

Read this first, then `docs/BUILD_PLAN.md` (Phase 6) and the live-run notes in `docs/spikes/`.

## Where the project stands (2026-08-30)

- Public repo `Brainferno/brainferno-mcp-bridge` (renamed from `adobe-cc-mcp` for Adobe's
  trademark rules), Apache-2.0, `main` is the release branch. CI on every push covers
  **Windows and macOS** on Node 20/22 — the two platforms Adobe ships Creative Cloud for, and
  so the only ones this software supports. (The extra build runner in `ci.yml` is just a fast
  machine for the platform-independent tests; the comment there explains it.)
  The current release is the latest `vX.Y.Z` tag (the README's npm badge shows it; no doc
  names the number by hand); npm packages `brainferno-mcp-bridge` and
  `@brainferno/mcp-bridge-protocol` published with trusted publishing — a `vX.Y.Z` tag
  publishes and creates the GitHub release by itself. See **Releasing** below.
- Everything is verified live on **Windows 11** with the Adobe 2026 apps: Photoshop 21
  (+ `ps_batch_play`, unit-tested only since X-01 — see the next bullet),
  After Effects 34 (+ `ae_run_script`, live on After Effects 26.5 since AE-01 — see the AE-01
  bullet), Premiere Pro 29, Illustrator 7 (+ Adobe's 46 via `ai_beta_call`),
  Audition 12, Media Encoder 6, audio/ffmpeg 9, pipelines 4, jobs 4. (`tool-counts.test.ts`
  checks the "Expect N tools" line below and the README's per-app headers; it does not check
  this line, so update it by hand from the numbers the test reports.)
- **X-01 (raw-script contract and gate).** `cc_eval_script`, `ps_batch_play` and the new
  `cc_get_capabilities` are always registered; the raw tools refuse unless
  `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` names the app, and return one envelope
  (`packages/server/src/tools/raw-script.ts`).
  - **Verified live on After Effects 26.5 (Windows 11, 2026-10-09)** with the gate set to
    `after_effects`, 18 probes, all as designed: completion values (statement lists, function
    declarations, IIFEs, `undefined` → `null`); `__log` and its 200-line cap; declared vars stay
    local to the call; a non-ASCII string round-trips; a SyntaxError and a runtime error come back
    as `ok: false` with `line` = `bodyLine` = the line in the caller's script (ExtendScript reports
    lines relative to the innermost eval, so the calibration gives `lineBase` 0); returning
    `app.project` is refused as a host object in milliseconds, while plain data built from host
    values passes; a script that put data on `Object.prototype` is reported and the host is
    healed for the next call; refusals for Audition and Photoshop are plain text and never
    dispatched; `cc_get_capabilities` reports the panel's version and host version from its
    hello; one audit line per call, with no payload. The stock After Effects engine has no data
    members of its own on `Object.prototype` (no stray keys in any envelope).
  - **Still unit-tested only:** the same wrapper on Illustrator (os-script lane) and Audition; the
    in-band `_obj: "error"` detection in `ps_batch_play`; and in the os-script lane, the
    runner-failure classification (it keys on PowerShell's `New-Object` / COM error text and
    osascript's trailing error number — check the real texts) and the macOS `with timeout of`
    wrapper around `do javascript`.
- **AE-16 (After Effects error quality).** A failed `ae_*` call names the tool and its arguments,
  where its line falls (a body line with the code around it, a shared helper, or outside the
  tool's code), what exists where a lookup missed, what to do next, and "did you mean" names
  (`evaluateAe` and `HELPERS` in `packages/server/src/tools/after-effects.ts`).
  - **Verified live on After Effects 26.5 (Windows 11, 2026-10-10)** with the typed tools only
    (the optional disconnect probe skipped). The probes settled the open host facts:
    `PropertyType.PROPERTY` exists; `canAddProperty` is case-sensitive for match names and takes
    display names (`EFFECT_DISPLAY_NAMES_ACCEPTED` is now `true`); cameras and lights have no
    Effect Parade or Mask Parade; a failing statement inside an `else if` branch reports its own
    line; calls that failed before changing anything left no undo entry. Card Dance is
    `APC CardDanceCam`, with 12 empty-named parameters that showed up as noise in the lists.
  - **Still unit-tested only:** leaving those empty names out of lists by name (changed after the
    live run), and the display-name refusal note that `EFFECT_DISPLAY_NAMES_ACCEPTED = true`
    selects. Details and the two follow-ups (no "did you mean" past the 20 names a list shows; the
    `app.effects` count and read time not recorded): `docs/spikes/06-aftereffects-tools-live.md`.
- **AE-01 (`ae_run_script`).** A raw ExtendScript in After Effects as one undo step, registered
  with the typed tools in `registerAfterEffectsTools` and built on the X-01 contract: the same
  wrapper, envelope, gate and audit line (`runRawScript` and `aeArgsLiteral` in
  `packages/server/src/tools/after-effects.ts`). Around the wrapper it adds the undo group
  (`undoGroupName`), `args` as `__args` (an ES3 literal, at most 32 levels deep), dialog
  suppression (`suppressDialogs`, default on), `alert`/`confirm`/`prompt` shims that fail the
  call instead of opening a dialog (only for a bare call in the script's own text: global code
  and `Window.alert`/`$.global.alert`/`this.alert` still reach After Effects' dialogs), and a
  plain-text refusal, before dispatch, of a script that names `app.beginUndoGroup`,
  `app.endUndoGroup`, `app.beginSuppressDialogs` or `app.endSuppressDialogs`. An end call that
  fails after the script ran is added to the envelope's error, keeping the value and logs; one
  that fails after the call itself threw is added to that thrown message. The description
  keeps its safety text within the 2,048 characters Claude Code shows. The audit payload is the
  JSON of `{ script, args }`, built with the new `auditJson` in `raw-script.ts`.
  `cc_get_capabilities` has an `ae_run_script` row. No panel change: the CEP panel's `eval`
  command carries it.
  - **Verified live on After Effects 26.5 (Windows 11, 2026-10-12)** with the gate set to
    `after_effects`, against the AE-01 prompt's acceptance tests: one Ctrl-Z (and one Redo) for a
    two-layer script, with "Undo <undoGroupName>" in the Edit menu, and no undo entry for a
    read-only call; `line` = `bodyLine` for a runtime, native, syntax and thrown error; `__args`,
    `__log` and the shims reach the script, the After Effects helpers do not; the managed-call
    refusal; a project switch inside the group returns ok and resets the undo history; later calls
    wait behind a timed-out script. Suppression hid an export warning and the missing-font dialog
    when the script opened a project, and each blocked without it; the texts name those and
    promise no more. Found, and now in the model-facing texts: with suppression on, opening another
    project saves the open one's unsaved changes over its file without asking (close it with
    `CloseOptions.DO_NOT_SAVE_CHANGES` first to discard them, as Adobe documents it; that probe's
    call timed out behind an open dialog, so its outcome was read from the files afterwards); After
    Effects reads a number below about 2.2e-308 as 0 and returns numbers with 15 significant
    digits. Also found: a script cannot read the Undo label (`app.findMenuCommandId` returns 0 for
    it). Details: `docs/spikes/06-aftereffects-tools-live.md`.
  - **Project-switch OK (unit-tested; live check pending).** A script that closes or replaces
    the open project is not sent until the operator agrees: `projectSwitchCalls` (the trigger),
    `PROJECT_INFO` as the read-only check, `askProjectSwitch` (MCP elicitation when the client
    advertises form mode; otherwise a plain-text refusal and `allowProjectSwitch`).
    `cc_eval_script` refuses such an After Effects script. The audit line carries `consent=`.
    Live check: `docs/spikes/06-aftereffects-tools-live.md`, AE-01 consent.
  - **Still unit-tested only:** the end-call notes — a second `endUndoGroup` does not fail, and
    ExtendScript has no getter literals to make the wrapper throw (R10); the refused audit line
    with the gate off (the refusal text was seen live); `Window.alert` and global code that calls
    `alert`, not probed live by design; and the server side of the project-switch OK (the scan,
    the question and its answers against an in-memory client, the plain-text fallback and
    `allowProjectSwitch`, the 10-minute timeout, the cancel text for a client that cannot show
    the question, the remote line).
  - **Not tested at all** (live check pending where the spike 06 AE-01 consent checklist has a
    step): opening another project over a never-saved one under suppression (not tried live;
    ae-host has no save prompt to model); Claude Code's elicitation dialog (how it shows the
    question, what it sends back, and whether a host that cannot show it answers cancel);
    `close(DO_NOT_SAVE_CHANGES)` over unsaved changes with suppression on (the live project switch
    closed a project saved just before); what `app.newProject`, `app.openFast`, `app.quit`,
    `app.restart` and `close(PROMPT_TO_SAVE_CHANGES)` do with unsaved changes under suppression,
    what `close(SAVE_CHANGES)` does, and `close(DO_NOT_SAVE_CHANGES)` and `app.open` with
    suppression off; and whether `app.open` can be wrapped at run time.
- **macOS run on 2026-08-28** (macOS 26, Adobe 2026 apps, Node 26): panels, Illustrator via
  osascript, previews, ffmpeg all fine as written. Two real bugs fixed — the aerender path
  (`Folder.appPackage` is the `.app` itself on macOS) and Media Encoder (nested console bundle,
  the ini must exist in the outer bundle's `Contents/Resources`, the renderer must be tracked
  and SIGKILLed on stop). Details and the reasoning: `docs/spikes/13-macos-live.md`.

## Working routine that saved the most time

- Server change: `npm run build`, kill the running server, then `/mcp` → brainferno →
  reconnect in Claude Code. A plain reconnect reuses the old process.
- **Kill the right server.** With more than one Claude Code window open, each runs its own
  brainferno server, and the `pid` in `~/.brainferno-mcp-bridge/bridge.json` is simply the
  server that started last — it may belong to another window. Find yours by its parent: the
  `node …\packages\server\dist\index.js` process whose parent is this session's `claude.exe`
  (`Get-CimInstance Win32_Process` shows `ParentProcessId` and `CommandLine`). A panel stays on
  the server it already joined until it reconnects, so it may not be on the bridge.json one.
- UXP panel change (Photoshop, Premiere): reload in the UXP Developer Tool. CEP panel change
  (After Effects, Audition): close and reopen the panel.
- When a server shuts down cleanly it tells the panels "bye", and the CEP panel then engages
  its kill switch ("no reconnect until you press Connect"): press **Connect** in the panel. It
  reconnects by itself only after an abnormal drop (socket code 1006), re-reading bridge.json.
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
Expect 131 tools (127 in v0.3.3, before `cc_get_capabilities` and the always-registered
raw-script tools `cc_eval_script`/`ps_batch_play`/`ae_run_script`; 125 as of v0.3.1, before the
`ae_add_shape`/`ae_add_mask` tools; 124 in
v0.3.0, before `ae_set_comp_props`; 113 in v0.2.2, before the mogrt, layer-style, Essential
Graphics, and PSD/AI-import tools) and the right `serverInfo` version. Two false alarms this
catches: without an isolated `HOME`, the test instance reads the real `config.json`, tries to
bind the shared-mode port 7898 that the live server already holds, and dies with `EADDRINUSE`;
and it will clobber `~/.brainferno-mcp-bridge/bridge.json`, pointing the panels at a dead port
on their next reload.

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

## Packaging the panels as installable plugins

`npm run package` (scripts/package-panels.mjs) prepares the panels for install into
`dist-packages/` (git-ignored), stamping the version from the root `package.json` so the
manifests can't drift.

- **CEP → `.zxp`** (After Effects, Audition — one bundle, both hosts). Fully automated. A
  `.zxp` must be code-signed; the script downloads Adobe's **ZXPSignCmd** (CEP-Resources
  4.1.103, Windows only in that build) into `.tools/` on first run, generates a
  **self-signed** certificate (`.tools/brainferno-selfsigned.p12`, git-ignored — regenerate,
  never commit), signs, and verifies. The self-signed cert is fine for side-loading.
  `npm run install-cc` still side-loads the same folder with developer mode as the
  no-signing alternative.
- **UXP → `.ccx`** (Photoshop, Premiere). NOT auto-built. Adobe signs a `.ccx` with its own
  UXP signer, and is explicit that you should not hand-zip one — a plain zip is rejected by
  the installer (UPIA status **-267**, confirmed live). The signer lives in the UXP Developer
  Tool's **Package** command and in `@adobe/uxp-devtools-cli` (`uxp plugin package`), whose
  native module has no prebuilt binary for current Node (fails on Node 24 here), so it can't
  run headless. The script therefore stages a version-stamped folder
  (`dist-packages/uxp-<app>-<ver>/`); build the `.ccx` from it in the UXP Developer Tool
  (Add Plugin → its `manifest.json` → Actions → Package). UDT names it
  `<plugin-id>_<HOST>.ccx`, so Photoshop and Premiere come out as distinct files.

**Installing — Adobe's Unified Plugin Installer Agent (UPIA) installs BOTH formats**, the
`.ccx` and the `.zxp` (verified live: "Installation Successful" for each). It's already on
disk; no separate ZXP installer is needed:

    "…\Adobe Desktop Common\RemoteComponents\UPI\…\UnifiedPluginInstallerAgent.exe" /install <file>

Double-clicking a `.ccx` also works. Two gotchas, both hit live: UPIA refuses a plugin whose
id is still **loaded in developer mode** — in the UXP Developer Tool use **Remove** (not just
Unload) on the entry first; and the UXP host app (Photoshop/Premiere) is best **closed**
during install. The installed plugins land at
`…\Roaming\Adobe\UXP\Plugins\External\<id>_<ver>` (UXP) and
`…\Program Files (x86)\Common Files\Adobe\CEP\extensions\<name>` (CEP). To switch an app off
the developer install and onto the installed package, remove the dev entry — for CEP that is
the junction `…\Roaming\Adobe\CEP\extensions\<id>` that `install-cc` made (delete it with
`rmdir`, which removes only the link, never the source it points at).

macOS: a macOS ZXPSignCmd (from the CEP-Resources repo, dropped into `.tools/` by hand) is
needed; the Windows build auto-downloads.

## Secrets and keys

Never commit keys. The Illustrator MCP key and the remote token live in
`~/.brainferno-mcp-bridge/config.json` (mode 600), written by the installer.
