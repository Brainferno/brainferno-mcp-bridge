# macOS — first live run (2026-08-28, macOS 26 / Darwin 25.5, Adobe 2026 apps, Node 26, Homebrew ffmpeg)

Everything before this was verified on Windows only. This is what differed on a Mac, tool by tool.
Windows behaviour is untouched by the fixes below (the Windows branches are byte-for-byte the same;
CI runs the suite on Windows too).

## What worked as written

- `npm install && npm run build && npm test` — clean; the ffmpeg test runs with `brew install ffmpeg`.
- Installer: CEP symlink at `~/Library/Application Support/Adobe/CEP/extensions/com.brainferno.mcp-bridge.cep`
  and `defaults write com.adobe.CSXS.{11,12,13,14} PlayerDebugMode 1` — both correct.
- All four panels connect: After Effects + Audition (CEP), Photoshop + Premiere (UXP, loaded through the
  UXP Developer Tool). `cc_connected_apps` lists them; create/preview/state calls work.
- Illustrator through `osascript` (`tell application "Adobe Illustrator" to do javascript …`):
  `ai_create_document`, `ai_get_preview` — first run may prompt for Automation permission.
- ffmpeg lane, jobs, previews in `$TMPDIR/brainferno-mcp-bridge/…`.

## aerender — path bug (fixed)

`Folder.appPackage.fsName` is **the `.app` bundle itself** on macOS
(`/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app`), not its parent folder as the
code assumed; `aerender` sits next to the bundle (`/Applications/Adobe After Effects 2026/aerender`).
`ae_render_comp` failed with "aerender not found at …2026.app/aerender". `aerenderExecutable()` now
strips a trailing `.app` (`src/tools/after-effects.ts`), using explicit `path.posix` / `path.win32`
flavours so the value is right whichever OS computes it. A 320×180 comp rendered in 5 s (Lossless → .mov).

## Media Encoder — three macOS differences (fixed)

1. **Where the console lives.** It is a nested bundle:
   `…/Adobe Media Encoder 2026.app/Contents/ame_webservice_console.app/Contents/MacOS/ame_webservice_console`
   (with an `ame_webservice_agent` symlink beside it). `detectConsoleExe()` now tries that first.
2. **Where the ini is read from.** Adobe ships **no** `ame_webservice_config.ini` on macOS, and without
   one the console prints `can not open config file: ame_webservice_config.ini` and never starts its
   HTTP listener (it does launch the renderer, so the failure is silent). It ignores command-line flags
   (`--ip`, `--port`, even `--help` prints nothing), the working directory, and a symlinked launcher.
   `fs_usage` shows the exact path it opens:
   `…/Adobe Media Encoder 2026.app/Contents/Resources/ame_webservice_config.ini` — the **outer** app
   bundle's Resources folder. `iniPathFor()` resolves that on macOS (beside the exe on Windows, as before),
   `portFromIni()` reads it, and `ensureRunning()` fails fast with the fix instead of after a 120 s timeout.
   With `ip = 127.0.0.1` / `port = 8080` in that file the service answers on loopback ~2–9 s after launch;
   WAV → MP3 through the driver: `Queued → Success` in 1.1 s.
3. **Writing that file.** The bundle is root-owned *and* under macOS "App Management" protection:
   `sudo` gets `Operation not permitted` from a terminal. Finder is allowed —
   `osascript -e 'tell application "Finder" to duplicate file … to folder … with replacing'` copies it in
   without a prompt. The installer now seeds the ini on macOS when it is missing (`port = 8080`, plus
   `ip = 127.0.0.1` in local mode) and falls back to Finder when the direct write is refused; the last
   resort message tells the user to allow App Management for their terminal app.
   Not pursued: a "shadow" copy of the console bundle in `~/.brainferno-mcp-bridge` (ini in our own folder,
   Frameworks symlinked) — the copied binary is SIGKILLed at launch with nothing in the logs.

**Stopping the service.** The console spawns the hidden renderer (`Adobe Media Encoder 2026`) re-parented
to launchd in its own process group, so `process.kill(-pid)` on the console's group never reaches it —
every idle stop would have leaked a renderer. SIGTERM to the renderer is worse: Adobe's crash handler
treats it as a crash, pops the crash-report dialog and keeps the process. The driver now snapshots renderer
pids before starting the console, attributes the new one to itself once the service is up (`renderer pid …`
in the log), and SIGKILLs it in `stop()` (the same forcefulness as `taskkill /T /F` on Windows). A GUI
Media Encoder that was already open is never touched. Verified: start → stop leaves no AME process and no
crash reporter.

## Illustrator — which one AppleScript drives (fixed)

`tell application "Adobe Illustrator"` resolves by **name**, and Adobe ships both versions with the
same bundle name: `/Applications/Adobe Illustrator 2026/Adobe Illustrator.app`
(`com.adobe.illustrator`, 30.7.0) and `/Applications/Adobe Illustrator (Beta)/Adobe Illustrator.app`
(`com.adobe.illustratorBeta`, 30.9.0). Whichever one is already running wins, so the lane changed
target mid-session here: a document created through `ai_create_document` landed in the Beta, and a
later call — after something launched the release — found "no document open" while the Beta still
held it. On Windows the COM ProgID picks a version, so this is macOS-only.

The os-script lane now takes a target: `config.illustratorApp` /
`BRAINFERNO_MCP_ILLUSTRATOR_APP`, accepting an AppleScript name, a **bundle id**
(`tell application id "com.adobe.illustratorBeta"`) or an absolute `.app` path. Unset keeps the old
name-based behaviour, so nothing changes for a single-install machine or on Windows. The installer
detects both bundles, asks which one the `ai_*` tools should drive (release first), and writes the
bundle id to `~/.brainferno-mcp-bridge/config.json`; it clears a stale pin when only one is left.

## Tests added

`test/ame-webservice.test.ts` (ini location per platform, nested-bundle detection with a fake tree, port
from the bundle ini, renderer pid attribution), `test/after-effects-tools.test.ts` (aerender path on both
platforms), `test/osscript.test.ts` (AppleScript name vs bundle id vs path), `test/install-lib.test.ts`
(macOS ini candidates, seed + Finder script, Illustrator bundle detection and the pin).
CI now runs the suite on `macos-latest` as well as Ubuntu and Windows, with ffmpeg from Homebrew.

## The handshake file (not macOS-specific, found here)

A second server instance — another editor session, a stray `npm start`, an agent running the
server — overwrites `~/.brainferno-mcp-bridge/bridge.json` with its own port and token, and on
exit the old code deleted the file even though the first server was still listening with panels
attached. A panel reloading then found no handshake at all. `removeHandshake` now only deletes
the file when the pid in it is ours, and a server taking the file over from a live pid logs a
warning naming it. Same on Windows.

## Also verified through the bridge on macOS

`pp_list_export_presets` (finds presets inside the app bundles and in `~/Documents/Adobe/...`),
`audio_probe` / `audio_waveform_image` (Homebrew ffmpeg on PATH), `ae_render_frame`, `ps_export`,
`ps_get_preview`, `ai_get_preview` — all correct, no path fixes needed.

End-to-end through the MCP tools after the fixes, on the restarted server: all four panels
re-attached on their own within the client's 3 s retry; `ai_list_documents` showed the pinned
Beta's document; `ame_server start:true` → Online on `127.0.0.1:8080`; `ame_encode` (WAV → MP3
128k) succeeded in 2 s; `ae_render_comp` (Lossless) wrote a 1 s .mov in 4 s; `ame_stop_server`
left no console and no renderer behind — while correctly leaving an unrelated renderer that was
already running untouched.
