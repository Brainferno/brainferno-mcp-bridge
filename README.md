# adobe-cc-mcp

MCP server plug-in for creative cloud for video production to control Photoshop, After Effects, illustrator, Premiere, and Audition

## How it works

Creative Cloud applications cannot be driven from outside their own process, so this
is two halves:

1. **This server** — an [MCP](https://modelcontextprotocol.io) server speaking stdio to
   an AI client (Claude Code, Claude Desktop, any MCP host). It exposes typed tools like
   `ae_list_compositions` and `ps_list_layers`.
2. **A companion panel** — a small extension loaded inside each Adobe application, which
   dials back to this server on a loopback port and evaluates the scripts it is sent.

```
MCP client  <--stdio-->  adobe-cc-mcp  <--ws://127.0.0.1:7777-->  panel inside Photoshop
                                       <--                    -->  panel inside After Effects
```

The panel connects outward so nothing has to open a listening socket inside Adobe's
process. The panel is not written yet — see [Status](#status).

### Two scripting engines, not one

The five applications do not share an automation surface, and this shapes everything:

| Application | Engine | Language |
| --- | --- | --- |
| Photoshop | UXP | Modern JavaScript |
| Illustrator | UXP | Modern JavaScript |
| After Effects | ExtendScript | ES3 — `var` only, no arrow functions, no `JSON` |
| Premiere Pro | ExtendScript | ES3 |
| Audition | ExtendScript | ES3 |

Scripts in `src/tools/` are written for their host's engine and are **not**
interchangeable. The ExtendScript ones look dated on purpose; modernizing them breaks
them.

## Tools

| Tool | Application | Purpose |
| --- | --- | --- |
| `cc_connected_apps` | all | Which applications currently have a panel connected |
| `cc_eval_script` | all | Raw script escape hatch for uncovered work |
| `ae_project_info` | After Effects | Project path, item count, bit depth, dirty flag |
| `ae_list_compositions` | After Effects | Every comp with size, duration, frame rate, layer count |
| `ae_queue_render` | After Effects | Add a comp to the render queue with an output path |
| `ppro_project_info` | Premiere Pro | Project name, path, sequence count |
| `ppro_list_sequences` | Premiere Pro | Sequences with track counts and timebase |
| `ps_list_documents` | Photoshop | Open documents with size, resolution, color mode |
| `ps_list_layers` | Photoshop | Layers of a document, flattened with nesting depth |
| `ai_list_documents` | Illustrator | Open documents with artboard count and color space |
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
  -- node /absolute/path/to/adobe-cc-mcp/dist/index.js
```

### Configuration

Copy `.env.example` and adjust. All settings are environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADOBE_CC_MCP_BRIDGE_PORT` | `7777` | Port the panels dial back to |
| `ADOBE_CC_MCP_BRIDGE_TOKEN` | *(empty)* | Shared secret panels must present; empty disables the check |
| `ADOBE_CC_MCP_EVAL_TIMEOUT_MS` | `30000` | How long to wait for a script result |
| `ADOBE_CC_MCP_LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |

The bridge binds to `127.0.0.1` only. It evaluates arbitrary script inside your Adobe
applications, so do not expose it to a network interface, and set a token.

## Development

```bash
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

Tests use the MCP SDK's in-memory transport and a fake panel over a real WebSocket, so
they exercise the full path — tool call, bridge dispatch, result parsing — with no Adobe
application involved.

**stdout is the MCP wire.** Never `console.log` in this server; use the `log` helper in
`src/logging.ts`, which writes to stderr. A stray stdout write corrupts the protocol
stream and the client silently disconnects.

### Layout

```
src/
  index.ts           entry point, stdio transport, signal handling
  server.ts          builds the McpServer and registers every tool
  config.ts          environment configuration
  logging.ts         stderr logger
  apps.ts            the five hosts and which engine each uses
  bridge/
    protocol.ts      wire format between server and panel
    socket.ts        WebSocket server the panels connect to
    types.ts         AppBridge interface and typed errors
  tools/
    result.ts        result formatting and error guarding
    <app>.ts         per-application tool registration
```

## Status

Early, and honest about it:

- **Working** — MCP server, tool registration, the bridge protocol and its server side,
  error handling, tests.
- **Not written yet** — the in-app panels. Without one, every tool correctly reports
  that its application is not connected. The UXP panel (Photoshop, Illustrator) and the
  CEP panel (After Effects, Premiere, Audition) are the next pieces of work.
- **Thin** — Audition and Illustrator have one tool each; Premiere has no export tool.
  The surface grows as the panels land.

## License

TBD
