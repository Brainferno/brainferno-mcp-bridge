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
| `ae_project_info` | After Effects | Project path, item count, bit depth, dirty flag |
| `ae_list_compositions` | After Effects | Every comp with size, duration, frame rate, layer count |
| `ae_queue_render` | After Effects | Add a comp to the render queue with an output path |
| `pp_project_info` | Premiere Pro | Project name, path, sequence count |
| `pp_list_sequences` | Premiere Pro | Sequences with track counts |
| `ps_list_documents` | Photoshop | Open documents with size, resolution, color mode |
| `ps_list_layers` | Photoshop | Layers of a document, flattened with nesting depth |
| `ai_list_documents` | Illustrator | Open documents with artboard count and color space |
| `ai_create_document` | Illustrator | New document with one artboard (rgb/cmyk) |
| `ai_create_shape` | Illustrator | Draw a rect, ellipse, line, polygon, or star with fill/stroke |
| `ai_create_text` | Illustrator | Add point or area text with font, size, color |
| `ai_save_document` | Illustrator | Save / Save As a native `.ai` |
| `ai_export_artboard` | Illustrator | Export the active artboard to PNG/JPG (or the doc to SVG) |
| `ai_get_preview` | Illustrator | Render the active artboard as an image you can see |
| `au_document_info` | Audition | Active document's sample rate, duration, multitrack flag |

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
spikes/              throwaway validation panels (uxp-photoshop, cep-aftereffects)
docs/                plan, protocol, spike findings
```

Root scripts fan out to the packages: `npm run build` (protocol, then server), `npm run typecheck`, `npm test`.

The wire protocol is frozen at v2 and documented in [`docs/protocol.md`](docs/protocol.md);
changes there ripple into every panel, so treat it as a stable contract.

## Status

Early, and honest about it:

- **Working** — MCP server, tool registration, the frozen v2 protocol, and the **hardened
  bridge hub** (token auth by default, Origin/Host upgrade checks, per-socket result
  matching, heartbeat, in-flight rejection on disconnect), error handling, tests.
- **Not written yet** — the in-app panels and the Illustrator OS-script driver. Without
  them, every tool correctly reports that its application is not connected. The UXP panel
  (Photoshop, Premiere Pro), the CEP panel (After Effects, Audition), and the panel-less
  Illustrator lane are the next pieces of work (see the phased build plan).
- **Thin** — Audition and Illustrator have one tool each; Premiere has no export tool.
  The surface grows as the panels and drivers land.

## License

TBD
