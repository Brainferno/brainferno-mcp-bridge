# Changelog

## v0.2.1 — 2026-08-30

Housekeeping on top of 0.2.0: no new tools, nothing changed for an existing Windows or macOS
install.

- The installer now checks the platform before it does anything and exits saying that the
  Adobe applications this bridge drives run on Windows and macOS only. Previously it worked
  partway through and invented a `cep-extensions-unsupported` folder under the user's home;
  `pp_list_export_presets` likewise stopped offering a `~/Documents/Adobe` root on platforms
  where Adobe cannot be installed.
- `npm publish` no longer warns that the `bin` entries were "invalid and removed" — the paths
  lost their `./` prefix, which is the rewrite npm was doing silently. Both commands worked
  before and still do; the warning was noise on every release.
- Documentation names Windows and macOS as the supported platforms throughout, and the README
  status line and hand-off notes catch up with the 0.2 release.

## v0.2.0 — 2026-08-30

macOS brought up and verified live (Adobe 2026 apps), so both platforms Adobe ships Creative
Cloud for are now covered. Windows behaviour is unchanged, and CI runs the suite on Windows and
macOS. Details: `docs/spikes/13-macos-live.md`.

- **After Effects**: fixed the `aerender` path on macOS — `Folder.appPackage` is the `.app`
  bundle itself there, and `aerender` sits beside it. `ae_render_comp` and the render pipelines
  failed with "aerender not found" before.
- **Media Encoder** on macOS: find the console inside its nested bundle; read (and create)
  `ame_webservice_config.ini` in the app bundle's `Contents/Resources`, which is the only place
  the console looks — Adobe ships none, so the service used to start and never listen. The
  installer writes the file through Finder, since macOS "App Management" refuses bundle writes
  even under `sudo`, and `ame_server` now fails fast naming the path instead of timing out.
- **Media Encoder** on macOS: stop the hidden renderer the service starts. It runs in its own
  process group, so the previous group kill missed it and every idle stop leaked one; the driver
  now tracks only the renderer it caused and never touches an instance that was already running.
- **Illustrator** on macOS: pick which Illustrator the `ai_*` tools drive. The release and the
  Beta both ship a bundle named `Adobe Illustrator.app`, so an AppleScript name followed whichever
  was running. New `illustratorApp` config / `BRAINFERNO_MCP_ILLUSTRATOR_APP` accepts a name,
  bundle id or `.app` path; the installer detects both and asks.
- **Bridge**: the handshake file is no longer deleted by a second server instance that does not
  own it, and a server taking it over from a live one says so in the log. Panels reloading after
  an unrelated instance exited used to find no handshake at all.

## v0.1.0 — 2026-08-28

First public release.

- MCP server (stdio; optional token-protected Streamable HTTP for other computers) with a
  hardened loopback hub for the in-app panels.
- Panels: Photoshop and Premiere Pro (UXP), After Effects and Audition (CEP), each with a
  live log and a kill switch.
- Tools: Photoshop 18 · After Effects 24 · Premiere Pro 28 · Illustrator 7 (+ pass-through to
  Adobe's 46 Illustrator MCP tools) · Audition 12 · Media Encoder 6 (headless web service) ·
  audio/ffmpeg 9 · pipelines 4 · jobs 4.
- Job registry with progress, cancel, per-job work folders, and failure reports naming the
  step and its recovery tool.
- Installer: choose apps, local vs shared-on-network, Illustrator key, panel setup, Claude
  Code registration.
- Verified live on Windows 11 with the Adobe 2026 applications; macOS paths written but not yet
  run (done in the next release — see Unreleased).
