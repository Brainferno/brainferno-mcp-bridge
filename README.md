# adobe-cc-mcp

MCP server plug-in for creative cloud for video production to control Photoshop, After Effects, illustrator, Premiere, and Audition

## How it works

Creative Cloud applications do not share one automation surface, so this server reaches
each app down one of two lanes:

1. **This server** — an [MCP](https://modelcontextprotocol.io) server speaking stdio to
   an AI client (Claude Code, Claude Desktop, any MCP host). It exposes typed tools like
   `ae_list_compositions` and `ps_list_layers`, and hosts a hardened WebSocket bridge on
   loopback.
2. **The lanes** — most apps run a **companion panel** (UXP for Photoshop/Premiere, CEP
   for After Effects/Audition) that dials back to the bridge and runs the *named commands*
   it is sent. Illustrator has no public UXP, so it is driven **panel-less** via OS
   scripting (`osascript`/COM) directly from the server.

```
MCP client  <--stdio-->  adobe-cc-mcp  <--ws://127.0.0.1:PORT-->  UXP panel (Photoshop, Premiere)
                                       <--                    -->  CEP panel (After Effects, Audition)
                                       --- osascript / COM ----->  Illustrator (no panel)
```

The panel connects outward because UXP plugins cannot listen on a socket; keeping the one
listener on the server side is also where it gets hardened (token auth, Origin/Host
checks, heartbeat, per-socket result matching). The panels are not written yet — see
[Status](#status). The full design is in [`docs/protocol.md`](docs/protocol.md).

### Two scripting engines, not one

The five applications do not share an automation surface, and this shapes everything:

| Application | Engine | Language |
| --- | --- | --- |
| Photoshop | UXP | Modern JavaScript |
| Premiere Pro (≥ 25.6) | UXP | Modern JavaScript (`require("premierepro")`, promise-based) |
| After Effects | ExtendScript | ES3 — `var` only, no arrow functions, no `JSON` |
| Illustrator | ExtendScript | ES3 (no public UXP exists) |
| Audition | ExtendScript | ES3, via an undocumented CEP-only API |

Scripts in `src/tools/` are written for their host's engine and are **not**
interchangeable. The ExtendScript ones look dated on purpose; modernizing them breaks
them.

## Tools

| Tool | Application | Purpose |
| --- | --- | --- |
| `cc_connected_apps` | all | Each app's lane, panel, engine, and connection state |
| `cc_eval_script` | AE, Illustrator, Audition | Raw ExtendScript escape hatch — **opt-in** (`ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS=1`) |
| `ai_beta_status` / `ai_beta_list_tools` / `ai_beta_call` | Illustrator (Beta) | Delegate to Adobe's official Illustrator MCP for analyze/batch/export — **opt-in** via a key ([docs](docs/illustrator-beta.md)) |
| `ps_*` (18) | Photoshop | Documents (list/create/open/save/export/preview), layers (create/text/props/move/duplicate/delete), place image, fill, filters, resize, crop — [live run](docs/spikes/05-photoshop-tools-live.md) |
| `ae_*` (24) | After Effects | Project/comps/footage, layers of every kind, keyframes + easing, expressions, effects + params, text, markers, frame preview, render queue, headless aerender — [live run](docs/spikes/06-aftereffects-tools-live.md) |
| `pp_*` (28) | Premiere Pro | Project/sequences/items, get_sequence (tracks + clips), import, create sequence from media, insert/overwrite, ripple remove, move/trim/props, transitions, effects + keyframes, markers, frame preview, export presets, H.264/any-preset export (in-app or to Media Encoder) — [live run](docs/spikes/07-premiere-tools-live.md) |
| `ai_*` (7) | Illustrator | Documents, shapes, text, save, export artboard, preview (panel-less OS-script lane) |
| `au_*` (12) | Audition | App/document state, 600+ menu commands (list/invoke), Favorites (hands-off effect chains), markers, transport, open/save/export, API dump — [live run](docs/spikes/08-audition-tools-live.md) |
| `audio_*` (9) | ffmpeg (no Adobe app needed) | Probe, EBU R128 measure + two-pass normalize, convert/extract, trim, trim silence, denoise, mix, waveform image |
| `ame_*` (6) | Media Encoder (headless) | Encode any media, a `.prproj` sequence, or FCP XML with an `.epr` preset through AME's built-in web service — started on demand, no window; status, history, cancel — [live run](docs/spikes/10-media-encoder-live.md) |
| `pipeline_*` (4) | cross-app | `ps_to_ae`, `render_and_import` (AE → aerender → Premiere), `audio_roundtrip` (Premiere → ffmpeg → Premiere), `ai_to_ps` — one call, one job, per-step progress, failure names the step + recovery tool — [live run](docs/spikes/09-pipelines-live.md) |
| `cc_job_*` (4) | jobs | `status`, `list`, `wait` (streams progress), `cancel`; long renders/exports take `wait:false` and return a jobId |

Tools are always advertised, even when the application is closed — a closed app returns
an actionable error rather than disappearing from the tool list mid-session.

## Setup

Requires Node.js 20 or newer.

```bash
npm install
npm run build
```

Register with an MCP client — for Claude Code:

```bash
claude mcp add adobe-cc --env ADOBE_CC_MCP_BRIDGE_TOKEN=$(openssl rand -hex 24) \
  -- node /absolute/path/to/adobe-cc-mcp/packages/server/dist/index.js
```

### Configuration

Copy `.env.example` and adjust. All settings are environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADOBE_CC_MCP_BRIDGE_PORT` | `7897` | Port the panels dial back to (`0` = OS-assigned) |
| `ADOBE_CC_MCP_BRIDGE_TOKEN` | *(empty → generated)* | Shared secret; empty generates a random per-run token |
| `ADOBE_CC_MCP_BRIDGE_INSECURE` | *(off)* | `1` disables auth and the handshake file (debug only) |
| `ADOBE_CC_MCP_HANDSHAKE_FILE` | `~/.adobe-cc-mcp/bridge.json` | Where the `{port, token}` file panels read is written |
| `ADOBE_CC_MCP_EVAL_TIMEOUT_MS` | `30000` | How long to wait for a "slow" script result |
| `ADOBE_CC_MCP_HEARTBEAT_MS` | `15000` | Ping cadence for detecting a dead panel |
| `ADOBE_CC_MCP_ALLOW_RAW_SCRIPTS` | *(off)* | `1` registers the `cc_eval_script` escape hatch |
| `ADOBE_CC_MCP_ILLUSTRATOR_KEY` | *(empty → delegate off)* | Bearer key for Adobe's Illustrator (Beta) MCP; enables the `ai_beta_*` delegate tools ([docs](docs/illustrator-beta.md)) |
| `ADOBE_CC_MCP_ILLUSTRATOR_URL` | `http://localhost:18412/v1/mcp` | Adobe's Illustrator (Beta) MCP endpoint |
| `ADOBE_CC_MCP_LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |

The bridge binds to `127.0.0.1` only and evaluates arbitrary script inside your Adobe
applications. It requires a token by default (auto-generated and published, mode-600, to
the handshake file the panels read), rejects web `Origin`s and non-loopback `Host`s on the
upgrade, and matches each result to the socket that issued the command. Do not expose it
to a network interface or run it with `ADOBE_CC_MCP_BRIDGE_INSECURE=1` on a shared machine.

## Development

```bash
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

Tests live in `packages/server/test` and use the MCP SDK's in-memory transport and a fake panel over a real WebSocket, so
they exercise the full path — tool call, bridge dispatch, result parsing — with no Adobe
application involved.

**stdout is the MCP wire.** Never `console.log` in this server; use the `log` helper in
`src/logging.ts`, which writes to stderr. A stray stdout write corrupts the protocol
stream and the client silently disconnects.

### Layout (npm workspaces)

```
packages/
  protocol/          @adobe-cc-mcp/protocol — shared by server and panels
    src/apps.ts      the five hosts: lane, panel, and scripting engine each uses
    src/protocol.ts  wire format (v2, zod-validated) between server and panel
  server/            adobe-cc-mcp — the MCP server (bin: dist/index.js)
    src/index.ts     entry point, stdio transport, signal handling
    src/server.ts    builds the McpServer and registers every tool
    src/config.ts    environment configuration
    src/bridge/      hub (socket.ts), handshake file, script escaping, errors
    src/drivers/     os-script lane (Illustrator), Illustrator-beta delegate
    src/tools/       per-application tool registration + result helpers
    test/            vitest (fake panels over real WebSockets)
  bridge-client/     shared panel dial-out client (vendored into each panel by npm run panels:sync)
  panel-uxp/         Photoshop UXP panel
  panel-uxp-ppro/    Premiere Pro UXP panel (needs Settings → Plugins → developer mode)
  panel-cep/         After Effects (and later Audition) CEP panel
docs/                plan, protocol, spike findings
```

Root scripts fan out to the packages: `npm run build` (protocol, then server), `npm run typecheck`, `npm test`.

The wire protocol is frozen at v2 and documented in [`docs/protocol.md`](docs/protocol.md);
changes there ripple into every panel, so treat it as a stable contract.

## Status

Early, and honest about it:

- **Working (Windows-verified live)** — the hardened bridge hub (token auth by default,
  Origin/Host upgrade checks, per-socket result matching, heartbeat), the frozen v2
  protocol, the Photoshop and Premiere Pro UXP panels, the After Effects CEP panel, the
  Illustrator OS-script lane and beta-MCP delegate, the ffmpeg audio lane, and the v1 tool
  sets for all five applications — each proven end to end with previews you can see
  (`docs/spikes/05`–`08`).
- **Working too** — the job registry and the four cross-app pipelines; the flagship chain
  (Photoshop → After Effects → aerender → Premiere → ffmpeg audio → back to the timeline)
  ran from one conversation (`docs/spikes/09`).
- **Next** — macOS verification, packaging/installers, work-folder cleanup.
- **Thin** — Audition multitrack sessions are read-only so far; Illustrator's own lane covers
  create/save/export only (Adobe's beta MCP adds analysis/batch/export).

## License

TBD
