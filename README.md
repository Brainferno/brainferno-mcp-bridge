# Brainferno MCP Bridge (`brainferno-mcp-bridge`)

[![CI](https://github.com/Brainferno/brainferno-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Brainferno/brainferno-mcp-bridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/brainferno-mcp-bridge)](https://www.npmjs.com/package/brainferno-mcp-bridge)
[![Release](https://img.shields.io/github/v/release/Brainferno/brainferno-mcp-bridge)](https://github.com/Brainferno/brainferno-mcp-bridge/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Let an AI assistant run your Adobe video and graphics pipeline.**

Brainferno MCP Bridge is an [MCP](https://modelcontextprotocol.io) server that gives Claude
(Claude Code today; any MCP client) hands inside **Adobe Photoshop, Adobe After Effects,
Adobe Premiere Pro, Adobe Illustrator, Adobe Audition, and Adobe Media Encoder software** —
the apps you already have open, on the projects you already have loaded. It is independent
software for use with those Adobe products; it is not made or endorsed by Adobe (see
[Trademarks](#trademarks)). You describe the work in plain language; the assistant builds the
comp, cuts the sequence, normalizes the audio, renders the file, and shows you previews along
the way. Every action is one undo step in the app, so you can always step back.

- **124 tools** across six applications, plus an ffmpeg audio lane that works with every
  Adobe app closed.
- **Cross-app pipelines**: one request runs Photoshop → After Effects → aerender → Premiere
  → ffmpeg → back onto the timeline, with progress and a clear report if a step fails.
- **You can see what it did**: frame previews from After Effects and Premiere, document
  previews from Photoshop and Illustrator, waveforms from audio files.
- **Runs on your machine.** Nothing leaves your computer unless you turn on *shared* mode
  for other computers on your network (token-protected).

> Status: every tool verified live on Windows and macOS, the two platforms Adobe ships
> Creative Cloud for (Adobe 2026 apps). The npm badge above is the current version.
> See [Status](#status).

The companion panel inside each app — here in Adobe After Effects and Adobe Photoshop —
shows the connection, a live log, and a kill switch:

| After Effects (CEP panel) | Photoshop (UXP panel) |
| :---: | :---: |
| <img src="https://raw.githubusercontent.com/Brainferno/brainferno-mcp-bridge/main/docs/images/panel-after-effects.png" alt="Brainferno MCP Bridge panel in After Effects" width="380"> | <img src="https://raw.githubusercontent.com/Brainferno/brainferno-mcp-bridge/main/docs/images/panel-photoshop.png" alt="Brainferno MCP Bridge panel in Photoshop" width="380"> |

---

## What you can ask for

Examples that work today, in one conversation:

- *"Take my open Photoshop document, export it, and drop it into the 'Title' comp in
  After Effects as a new layer."*
- *"Make a 1920×1080 comp, add a dark background and the text 'Brainferno' in orange,
  animate it sliding in from the left with easy ease, add a glow, and show me frame 2."*
- *"Render the comp with aerender and put it on the Premiere timeline at 10 seconds."*
- *"Import these three clips, build a sequence from the first one, put the others after it,
  add a one-second cross dissolve between each, and add a marker where the music should hit."*
- *"Scale the still to 60 % and animate it up to 100 % over its length."*
- *"Export the sequence audio, denoise it, normalize it to −16 LUFS, and lay it on A2."*
- *"Open this WAV in Audition, apply my 'Podcast Voice' favorite, export it as MP3."*
- *"Measure the loudness of every file in this folder and tell me which ones are too hot."*
- *"Export the Premiere project to H.264 through Media Encoder, in the background, and tell
  me when it is done."*
- *"In Illustrator, draw a six-point star and a headline, export the artboard as PNG at 2×,
  and place it in Photoshop as a smart object."*
- *"Which Illustrator objects overlap artboard 2? Align them to its left edge."*
- *"What is open right now in each app?"*

Ideas people build with it:

- **Template factories** — a PSD or AI design becomes an animated title, then a rendered
  file, then a timeline element, by prompt.
- **Batch conforming** — normalize, denoise and convert a folder of interview audio while
  Audition stays closed.
- **Review loops** — "show me the frame at 3 s", change one thing, "show me again".
- **Hand-offs between people** — a producer on a laptop drives the studio PC that has the
  apps and the media (shared mode).
- **A render box** — Media Encoder jobs submitted headlessly, with status and history.

---

## What it controls

Counts are the tools registered per app. Each family has a live-run write-up in
`docs/spikes/` with the quirks found on real installs.

### Photoshop — 18 tools
Documents (list, create, open, save, export PNG/JPEG, preview image), layers (create,
text layers with font/size/color, properties, move, duplicate, delete), place an image as a
smart object, fill, filters (Gaussian/motion/unsharp…), resize, crop.

### After Effects — 24 tools
Project info and file, compositions and footage (list, create, import), layers of every
kind (footage, solid, text, null, adjustment), keyframes with easing, expressions, effects
and their parameters, text content/font/color/justification, markers, single-frame preview,
render queue, and headless rendering through `aerender` (the UI stays free).

### Premiere Pro — 28 tools
Project, sequences and items, a full sequence read (every track and clip with times),
import, create a sequence from media, insert/overwrite, ripple remove, move, trim, rename,
transitions, effects and keyframes (Motion, Opacity, any applied effect), markers, frame
preview, export preset search, and export (in Premiere or handed to Media Encoder).

### Illustrator — 7 tools + Adobe's own 46
Create documents, draw shapes (rect, ellipse, line, polygon, star) and text, save `.ai`,
export artboards (PNG/JPG/SVG), preview. Plus a pass-through to Adobe's built-in
Illustrator MCP server (artboards, alignment, appearance, structure, export, preflight… —
all 46 verified) when you give it your Illustrator key.

### Audition — 12 tools
App and document state, 600+ menu commands (list and run), Favorites (apply a saved
effect chain hands-off), markers, transport (play/stop/record), playhead, open, save,
export, close, and a dump of the scripting API for this build.

### Media Encoder — 6 tools
Headless encoding of any media file, a Premiere project (by sequence), or FCP XML with any
`.epr` preset through Media Encoder's built-in service — started on demand, stopped when
idle; status, history, cancel.

### Audio (ffmpeg) — 9 tools, no Adobe app needed
Probe, loudness measurement (EBU R128), two-pass loudness normalization, convert/extract,
trim, trim silence, denoise, mix, waveform image. These run your own installed ffmpeg as a
separate process — nothing is bundled ([licensing](#ffmpeg)).

### Pipelines and jobs — 8 tools
`pipeline_ps_to_ae`, `pipeline_render_and_import` (After Effects → aerender → Premiere Pro),
`pipeline_audio_roundtrip` (Premiere → ffmpeg → Premiere), `pipeline_ai_to_ps`. Long
renders and exports run as **jobs**: `cc_job_status`, `cc_list_jobs`, `cc_job_wait`,
`cc_job_cancel`, and every pipeline reports which step failed and which single-app tool
fixes it.

The full tool table is in [Tool reference](#tool-reference).

---

## Install

### Requirements

- Windows 10/11 or macOS 14+ — the only platforms Adobe ships Creative Cloud for, so the
  only ones this software runs on. Two macOS specifics the installer handles: Media Encoder needs a
  one-time config file inside its app bundle, and — when both Illustrator and Illustrator (Beta)
  are installed — which one the `ai_*` tools drive has to be pinned, since the two bundles share
  a name. See `docs/spikes/13-macos-live.md`.
- The Adobe apps you want to control (2024 or newer; Premiere Pro 25.6+ for its panel).
- [Node.js](https://nodejs.org) 20 or newer.
- [Claude Code](https://claude.com/claude-code) (or another MCP client).
- Optional: [ffmpeg](https://ffmpeg.org) on your PATH for the audio tools
  (`winget install ffmpeg` / `brew install ffmpeg`). It is never bundled — the server runs the
  copy you install; see [FFmpeg licensing](#ffmpeg).

### 1. Install the package

From npm (recommended):

```bash
npm install -g brainferno-mcp-bridge
```

Or from source, if you want to change it:

```bash
git clone https://github.com/Brainferno/brainferno-mcp-bridge.git
cd brainferno-mcp-bridge
npm install
npm run build
```

### 2. Run the installer

```bash
brainferno-mcp-bridge-install      # npm install
npm run install-cc                 # source checkout
```

It asks two questions and does the rest:

1. **Which applications?** — a numbered list, pre-checked from what is installed
   (Photoshop, After Effects, Premiere Pro, Illustrator, Audition, Media Encoder — any mix).
   Only those apps' tools and setup steps are used.
2. **Who may use it?** — *Only this computer* (default) or *Shared on my network*
   (other computers connect with a token).

Then it: writes `~/.brainferno-mcp-bridge/config.json`, asks for your Illustrator MCP key if you
chose Illustrator (paste the line Illustrator shows; it is checked on the spot), links the
After Effects/Audition panel, sets Media Encoder's service address, opens or closes the
firewall port, prints the Photoshop/Premiere panel steps, and offers to register the server
with Claude Code. On macOS it asks one more question when both Illustrator and Illustrator
(Beta) are installed — see below.

Non-interactive examples (from a source checkout, replace `brainferno-mcp-bridge-install`
with `node packages/server/dist/install/cli.js`):

```bash
brainferno-mcp-bridge-install --apps all --mode local --yes --register
brainferno-mcp-bridge-install --apps ps,ae --mode local --yes          # Photoshop + After Effects only
brainferno-mcp-bridge-install --apps ppro,ame --mode shared --yes      # Premiere + Media Encoder, shared
```

App names: `ps ae ppro ai au ame` or `all`. Re-run the installer any time to change apps
or mode. Other flags: `--token`, `--port`, `--host`, `--illustrator-key`, `--illustrator-url`,
`--illustrator-app`, `--no-panels`, `--no-ame`, `--no-firewall`, `--no-illustrator`, `--register`.

#### On macOS

Two things differ from Windows, and the installer handles both:

- **Media Encoder** needs `ame_webservice_config.ini` inside
  `/Applications/Adobe Media Encoder <year>/Adobe Media Encoder <year>.app/Contents/Resources/`.
  Adobe ships none, and without it the headless service starts but never listens. The installer
  creates it — and because macOS "App Management" blocks writes into app bundles even under
  `sudo`, it asks Finder to copy the file in. If that is refused, allow *App Management* for your
  terminal in **System Settings → Privacy & Security** and re-run, or create the file by hand with
  the two lines `ip = 127.0.0.1` and `port = 8080`. `ame_server` tells you the exact path if it is
  missing.
- **Illustrator and Illustrator (Beta)** both ship a bundle named `Adobe Illustrator.app`, so an
  AppleScript name resolves to whichever one happens to be running — the `ai_*` tools would follow
  it mid-session. The installer asks which one to drive and pins its bundle id
  (`illustratorApp` in `config.json`; `BRAINFERNO_MCP_ILLUSTRATOR_APP` overrides,
  `--illustrator-app com.adobe.illustratorBeta` sets it non-interactively).

### 3. Open the panels

The Adobe apps talk to the server through a small panel called **Brainferno MCP Bridge**.
Open it once per app; it connects on its own and shows a log and a kill switch.

- **After Effects / Audition**: Window → Extensions → Brainferno MCP Bridge.
- **Photoshop / Premiere Pro**: these are UXP panels; today they load through Adobe's
  free **UXP Developer Tool**: *Add Plugin* → pick the `manifest.json` the installer
  printed (`packages/panel-uxp` or `packages/panel-uxp-ppro`) → *Load*. Then Window →
  Extensions (UXP) → Brainferno MCP Bridge. Premiere needs *Settings → Plugins → Enable
  developer mode* first (restart Premiere). A double-click `.ccx` install is on the roadmap.
- **Illustrator** needs no panel: the `ai_*` tools drive it from outside (AppleScript on macOS,
  COM on Windows). For Adobe's own Illustrator tools, turn on MCP in Illustrator's preferences and
  give the installer the key it shows. On macOS with both the release and the Beta installed, the
  installer asks which one the tools should drive.
- **Media Encoder** needs no panel; the server starts its service when a job comes.

### 4. Talk to it

In Claude Code: `/mcp` shows **brainferno** connected. Try: *"Which Adobe apps are
connected?"* (`cc_connected_apps`), then anything from the examples above.

### Using it from another computer

In *shared* mode the server also speaks MCP over HTTP on port 7898 and refuses every
request without the bearer token (`~/.brainferno-mcp-bridge/config.json` → `httpToken`; the
installer prints the exact line). On the other computer:

```bash
claude mcp add --scope user --transport http \
  --header "Authorization: Bearer <token>" brainferno http://<studio-pc>:7898/mcp
```

The Adobe apps, panels, media and previews all stay on the studio PC; only commands and
results travel. The wire is plain HTTP — use a trusted LAN, a VPN, or Tailscale. The panels'
own hub never leaves loopback. An SSH alternative needs no server setting at all:
`claude mcp add brainferno -- ssh user@studio-pc node <path>/packages/server/dist/index.js`.

### Updating

npm: `npm install -g brainferno-mcp-bridge@latest`. Source: `git pull && npm install && npm run build`.
Then re-run the installer (your choices are
kept) and reconnect in Claude Code (`/mcp` → brainferno → reconnect). Panels pick up changes
on reload (UXP Developer Tool → Reload; CEP on reopen).

---

## How it works

Creative Cloud applications do not share one automation surface, so the server reaches
each app down the lane it has:

```
MCP client  <--stdio / HTTP+token-->  brainferno-mcp-bridge  <--ws://127.0.0.1:7897-->  UXP panel   (Photoshop, Premiere Pro)
                                                     <--                     -->  CEP panel   (After Effects, Audition)
                                                     --- osascript / COM ------->  Illustrator (no panel)
                                                     --- HTTP :8080 ----------->  Media Encoder web service (headless)
                                                     --- process -------------->  aerender, ffmpeg
```

- **Panels dial out** to a hardened WebSocket hub on loopback (token auth, Origin/Host
  checks, heartbeat, per-socket result matching) and run the *named commands* they are
  sent. UXP has no script engine, so Photoshop and Premiere commands are real functions in
  the panel; After Effects and Audition run ExtendScript templates.
- **Illustrator** is driven panel-less over OS scripting, and optionally through Adobe's own
  MCP server inside Illustrator.
- **Long work is a job**: aerender, Media Encoder, exports and pipelines run in a registry
  with steps, progress notifications, cancel, and a per-job work folder under
  `~/.brainferno-mcp-bridge/work/`.

Two scripting engines, on purpose:

| Application | Engine | Language |
| --- | --- | --- |
| Photoshop | UXP | Modern JavaScript (`photoshop` module, batchPlay) |
| Premiere Pro (≥ 25.6) | UXP | Modern JavaScript (`require("premierepro")`, action model) |
| After Effects | ExtendScript | ES3 — `var` only, no arrow functions, no `JSON` |
| Illustrator | ExtendScript | ES3 (no public UXP exists) |
| Audition | ExtendScript | ES3, via a CEP-only API learned by reflection |

Scripts in `src/tools/` are written for their host's engine and are **not**
interchangeable. The ExtendScript ones look dated on purpose; modernizing them breaks them.
The wire protocol is documented in [`docs/protocol.md`](docs/protocol.md).

---

## Tool reference

| Tools | Application | Purpose |
| --- | --- | --- |
| `cc_connected_apps` | all | Each app's lane, panel, engine, and connection state |
| `cc_job_status` · `cc_list_jobs` · `cc_job_wait` · `cc_job_cancel` | jobs | Background jobs; `wait` streams progress; long renders/exports take `wait:false` and return a jobId |
| `ps_*` (18) | Photoshop | Documents (list/create/open/save/export/preview), layers (create/text/props/move/duplicate/delete), place image, fill, filters, resize, crop — [live run](docs/spikes/05-photoshop-tools-live.md) |
| `ae_*` (24) | After Effects | Project/comps/footage, layers of every kind, keyframes + easing, expressions, effects + params, text, markers, frame preview, render queue, headless aerender — [live run](docs/spikes/06-aftereffects-tools-live.md) |
| `pp_*` (28) | Premiere Pro | Project/sequences/items, get_sequence (tracks + clips), import, create sequence from media, insert/overwrite, ripple remove, move/trim/props, transitions, effects + keyframes, markers, frame preview, export presets, export in-app or to Media Encoder — [live run](docs/spikes/07-premiere-tools-live.md) |
| `ai_*` (7) | Illustrator | Documents, shapes, text, save, export artboard, preview (panel-less) |
| `ai_beta_status` · `ai_beta_list_tools` · `ai_beta_call` | Illustrator (Adobe's MCP) | Pass-through to Adobe's 46 Illustrator tools — needs a key ([docs](docs/illustrator-beta.md), [sweep](docs/spikes/12-illustrator-beta-sweep.md)) |
| `au_*` (12) | Audition | App/document state, 600+ menu commands, Favorites, markers, transport, open/save/export, API dump — [live run](docs/spikes/08-audition-tools-live.md) |
| `ame_*` (6) | Media Encoder (headless) | Encode media / `.prproj` sequence / FCP XML with an `.epr` preset; status, history, cancel, service start/stop — [live run](docs/spikes/10-media-encoder-live.md), [macOS](docs/spikes/13-macos-live.md) |
| `audio_*` (9) | ffmpeg | Probe, R128 measure + two-pass normalize, convert/extract, trim, trim silence, denoise, mix, waveform image |
| `pipeline_*` (4) | cross-app | `ps_to_ae`, `render_and_import`, `audio_roundtrip`, `ai_to_ps` — one call, one job, failure names the step + recovery tool — [live run](docs/spikes/09-pipelines-live.md) |
| `cc_eval_script` | After Effects, Illustrator, Audition | Raw ExtendScript escape hatch — **opt-in** (`BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1`) |

Tools are always advertised for the apps you chose, even when an app is closed — a closed
app returns an actionable "not connected" error rather than vanishing mid-session.

---

## Configuration

The installer writes `~/.brainferno-mcp-bridge/config.json` (`enabledApps`, `illustratorKey`,
`illustratorUrl`, `illustratorApp`, `httpPort`, `httpHost`, `httpToken`). Environment variables
override it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRAINFERNO_MCP_APPS` | *(all)* | Apps to register, e.g. `ps,ae` |
| `BRAINFERNO_MCP_BRIDGE_PORT` | `7897` | Port the panels dial back to (`0` = OS-assigned) |
| `BRAINFERNO_MCP_BRIDGE_TOKEN` | *(empty → generated)* | Panel hub secret; empty generates a random per-run token |
| `BRAINFERNO_MCP_BRIDGE_INSECURE` | *(off)* | `1` disables hub auth and the handshake file (debug only) |
| `BRAINFERNO_MCP_HANDSHAKE_FILE` | `~/.brainferno-mcp-bridge/bridge.json` | Where the `{port, token}` file panels read is written |
| `BRAINFERNO_MCP_EVAL_TIMEOUT_MS` | `30000` | How long to wait for a "slow" script result |
| `BRAINFERNO_MCP_HEARTBEAT_MS` | `15000` | Ping cadence for detecting a dead panel |
| `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` | *(off)* | `1` registers the `cc_eval_script` escape hatch |
| `BRAINFERNO_MCP_ILLUSTRATOR_KEY` / `_URL` | *(config.json)* / `http://localhost:18412/v1/mcp` | Adobe's Illustrator MCP key and endpoint |
| `BRAINFERNO_MCP_ILLUSTRATOR_APP` | *(config.json, else the app's name)* | Which Illustrator the `ai_*` tools drive — AppleScript name, bundle id (`com.adobe.illustrator`, `com.adobe.illustratorBeta`) or `.app` path on macOS; COM ProgID on Windows |
| `BRAINFERNO_MCP_FFMPEG` / `_FFPROBE` | `ffmpeg` / `ffprobe` | Executables for the `audio_*` lane |
| `BRAINFERNO_MCP_AME_WEBSERVICE` | *(auto-detect)* | Path to Media Encoder's `ame_webservice_console` |
| `BRAINFERNO_MCP_AME_PORT` / `_AME_IDLE_MS` | *(from its ini)* / `600000` | Media Encoder service port; idle time before it is stopped |
| `BRAINFERNO_MCP_HTTP_PORT` / `_HTTP_HOST` / `_HTTP_TOKEN` | *(off)* / `127.0.0.1` / *(none)* | Remote mode (set by the installer's *shared* choice) |
| `BRAINFERNO_MCP_LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |

## Security

- The panel hub binds to `127.0.0.1` only and evaluates script inside your Adobe
  applications. It requires a token by default (auto-generated, written mode-600 to the
  handshake file the panels read), rejects web `Origin`s and non-loopback `Host`s, and
  matches each result to the socket that issued the command. Never run it with
  `BRAINFERNO_MCP_BRIDGE_INSECURE=1` on a shared machine.
- Remote mode (*shared*) is off by default. When on, every request needs the bearer token;
  there is no anonymous path. The wire is plain HTTP — keep it to a trusted network, VPN or
  tunnel.
- Media Encoder's built-in service has no password of its own and listens on a LAN address
  unless pinned to loopback; the installer's *local* choice pins it (one admin prompt on
  Windows; on macOS it writes the config file the service needs, via Finder), and the server
  only runs it while a job is active plus a short idle window. On macOS the server also ends
  the hidden renderer it started — never one that was already running.
- Keys and tokens are stored in `~/.brainferno-mcp-bridge/config.json`, never logged, never put in
  error messages.
- `cc_eval_script` (raw script) is opt-in and off by default.

---

## Development

```bash
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
npm test           # vitest (172 tests; the audio lane test runs a real ffmpeg if present)
npm run panels:sync  # copy the shared bridge client into each panel folder
```

Tests live in `packages/server/test` and use the MCP SDK's in-memory transport, a fake panel
over a real WebSocket, a fake Remote AME, and a real ffmpeg when available — the full path
from tool call to result with no Adobe application involved.

**stdout is the MCP wire.** Never `console.log` in this server; use the `log` helper in
`src/logging.ts`, which writes to stderr.

### Layout (npm workspaces)

```
packages/
  protocol/          @brainferno/mcp-bridge-protocol — shared by server and panels
    src/apps.ts      the five hosts: lane, panel, and scripting engine each uses
    src/protocol.ts  wire format (v2, zod-validated) between server and panel
  server/            brainferno-mcp-bridge — the MCP server (bin: dist/index.js) and installer (dist/install/cli.js)
    src/index.ts     entry point: stdio transport, optional HTTP listener, signal handling
    src/server.ts    runtime (hub, drivers, jobs) + per-session McpServer with every tool
    src/http.ts      remote mode: Streamable HTTP + bearer token
    src/jobs.ts      job registry (steps, progress, cancel, work folders)
    src/config.ts    environment + ~/.brainferno-mcp-bridge/config.json
    src/bridge/      hub (socket.ts), handshake file, script escaping, errors
    src/drivers/     os-script lane (Illustrator), Illustrator MCP delegate, Media Encoder web service
    src/tools/       per-application tools, audio lane, pipelines, jobs
    src/install/     the installer (lib.ts is pure and tested; cli.ts is interactive)
    test/            vitest
  bridge-client/     shared panel dial-out client (vendored into each panel by npm run panels:sync)
  panel-uxp/         Photoshop UXP panel
  panel-uxp-ppro/    Premiere Pro UXP panel
  panel-cep/         After Effects + Audition CEP panel
docs/                build plan, protocol, live-run notes (spikes/), Audition API dump
```

---

## Status

- **Working, verified live on Windows and macOS (Adobe 2026 apps)**: all six application
  lanes and their v1 tool sets, the ffmpeg lane, the job registry, the four pipelines, remote
  mode, and the installer. Write-ups with the quirks found: `docs/spikes/05`–`13` (`13` is the
  macOS run: aerender path, Media Encoder's config file and renderer).
- **Not yet**: double-click panel installs (`.ccx`/`.zxp`) so the UXP Developer
  Tool is not needed; a single signed installer; TLS for shared mode; Audition multitrack
  writes; Media Encoder queue control.
- Roadmap: `docs/BUILD_PLAN.md` (Phase 6).

## License

Copyright 2026 Brainferno. Licensed under the **Apache License, Version 2.0** — see
[`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). You may use, modify, and redistribute this
software, including commercially, as long as you keep the license and notices; the license
also gives you an express patent grant from contributors. Third-party components and the
Adobe materials this project relies on are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Contributions are accepted under the
same license.

### FFmpeg

The `audio_*` tools shell out to **FFmpeg**. No FFmpeg binary or source is included in this
repository or in the published npm packages, and there is no FFmpeg npm dependency: the server
runs the `ffmpeg` and `ffprobe` already installed on your machine (found on `PATH`, or at
`BRAINFERNO_MCP_FFMPEG` / `_FFPROBE`) as separate processes, passing command-line arguments and
file paths. Nothing from FFmpeg is linked into this software, so this project stays Apache-2.0 —
and if you simply install FFmpeg alongside it, so does yours.

**Each FFmpeg build carries its own license, and builds differ.** FFmpeg is LGPL-2.1-or-later by
default; a build configured with `--enable-gpl` — most packaged builds, since they include x264
and x265 — is GPL-2.0-or-later, and `--enable-version3` moves either to v3. A build configured
`--enable-nonfree` (e.g. with libfdk_aac) may not be redistributed at all. Check the one you
have rather than assuming:

```bash
ffmpeg -hide_banner -L   # the license this build is under
ffmpeg -version          # the configure flags it was built with
```

Homebrew's ffmpeg 9.0.1, used to verify the audio tools on macOS, reports GPL-3.0-or-later
(`--enable-gpl --enable-version3`).

If you **redistribute** FFmpeg — bundling it into your own installer, application or container
image alongside this bridge — that build's obligations become yours: shipping its license text
and corresponding source (or a written offer for it), and, under the LGPL, keeping relinking
possible. Pointing users at `brew install ffmpeg` or `winget install ffmpeg`, as this project
does, carries no such obligation.

Codec **patents** are separate from copyright: encoding or decoding H.264, HEVC or AAC can
require a patent license from the relevant pool for some commercial uses in some countries, and
no software license grants those rights. See FFmpeg's own [legal page](https://ffmpeg.org/legal.html).

None of the above is legal advice.

## Trademarks

Adobe, After Effects, Audition, Creative Cloud, Illustrator, Media Encoder, Photoshop, and
Premiere Pro are either registered trademarks or trademarks of Adobe in the United States
and/or other countries. FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg
project; this project is not affiliated with or endorsed by the FFmpeg project.

Brainferno MCP Bridge is an independent project. **It is not authorized, endorsed, or
sponsored by Adobe.** Adobe product names are used only to say which products this software
works with ("for use with Adobe Photoshop software"), as Adobe's
[trademark guidelines for plug-in and extension developers](https://www.adobe.com/legal/permissions/trademarks.html)
allow. No Adobe logos or product icons are included. "Brainferno" and the Brainferno MCP
Bridge name and panel icon belong to Brainferno; the Apache License grants no right to use
them in the names of derived products.
