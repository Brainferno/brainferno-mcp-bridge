# Remote mode + installer — live run (2026-08-28, Windows)

## Remote mode (Streamable HTTP + bearer token)

`src/http.ts` serves the same tools over MCP's Streamable HTTP transport when
`httpPort` is set (env `ADOBE_CC_MCP_HTTP_PORT` or `~/.adobe-cc-mcp/config.json`).
One `McpServer` per session on top of the shared runtime (`buildRuntime` → hub, jobs,
drivers; `createMcpServer` per session). Every request must carry
`Authorization: Bearer <token>` (≥16 chars, constant-time compare); the token is required to
start at all. No TLS: trusted LAN, VPN, or Tailscale.

Live: installer in shared mode → config `{httpPort: 7898, httpHost: "0.0.0.0", httpToken}`
→ full runtime started → from the LAN address `http://192.168.1.51:7898/mcp`:
- no token → **401**
- with token → **116 tools**, `cc_connected_apps` answered.

Another computer registers it with
`claude mcp add --scope user --transport http --header "Authorization: Bearer <token>" adobe-cc http://<host>:7898/mcp`.
The Adobe panels keep dialing the loopback hub (7897, its own token) — never exposed.

## Installer (`npm run install-cc` / `adobe-cc-mcp-install`)

First question — **which applications** (numbers or names; pre-checked from the app folders
found on disk; `--apps ps,ae,ppro,ai,au,ame|all`). Saved as `enabledApps` (omitted when all
six are chosen). The server registers only those apps' tools, `cc_connected_apps` lists only
them, and a pipeline appears only when every app it needs is on (e.g. `pipeline_ps_to_ae`
needs Photoshop + After Effects). The audio (ffmpeg) and job tools are always on. Each setup
step below runs only when a chosen app needs it (CEP link for AE/AU, UXP steps for PS/PPro,
Illustrator key, Media Encoder ini). Verified: `--apps ps,ae` → 2 panel lines printed,
Illustrator/AME steps skipped, server test shows PS/AE tools + `pipeline_ps_to_ae` only.

Second question — *Only this computer* or *Shared on my network* — drives every switch:

| Step | local | shared |
| --- | --- | --- |
| `~/.adobe-cc-mcp/config.json` | remote keys removed | `httpPort`, `httpHost=0.0.0.0`, `httpToken` (kept or generated) |
| CEP panel | junction `com.brainferno.mcp-bridge.cep` → `packages/panel-cep`, PlayerDebugMode=1 (CSXS 11–14); the old spike link is removed | same |
| Media Encoder `ame_webservice_config.ini` | `ip = 127.0.0.1` (admin: one UAC prompt) | `#ip = …` (LAN) |
| Windows firewall | remote rule deleted | inbound TCP 7898, private profile |
| Printed | `claude mcp add … -- node dist/index.js` | that, plus the `--transport http` line per LAN address |

Flags for scripts: `--mode local|shared --token T --port N --host H --yes --register --no-panels --no-ame --no-firewall`.
Re-running switches modes. UXP panels (Photoshop, Premiere) still load through the UXP
Developer Tool — the installer prints the exact manifest paths.

Verified: local run (config kept the Illustrator key, spike junction replaced, reg keys set),
shared run (token generated, remote lines printed), back to local.

## Gotchas

- Windows `path.join` in tests: assert macOS paths with separators normalized.
- `claude` on Windows is a shell shim: spawn it as one shell string; everything else as a real exe.
- Elevation: admin-only steps run once through `Start-Process -Verb RunAs` (UAC); if declined,
  the exact manual command is printed.
