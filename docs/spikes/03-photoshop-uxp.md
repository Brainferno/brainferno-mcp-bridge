# Spike 1: Photoshop UXP panel ↔ hub — findings (Windows, Photoshop 2026 v27.9.1)

Panel: `spikes/uxp-photoshop/`. Loaded via UXP Developer Tool with Developer Mode on.

## Findings so far (2026-08-26)

| # | Question | Answer |
|---|---|---|
| 4 | Can UXP evaluate a script string? | **No.** `new Function` → "Code generation from strings disallowed for this context". Every Photoshop command must be a named panel-side function. Protocol v2's named-command design is required, not optional. |
| 1 | Can the panel read `~/.adobe-cc-mcp/bridge.json`? | **Yes**, via `require("fs").readFileSync` with `localFileSystem: "fullAccess"`. Port + token discovery works. |
| 2 | Does `new WebSocket("ws://127.0.0.1:7897")` connect? | **Blocked at first try:** "Permission denied to the url ws://127.0.0.1:7897. Manifest entry not found." — with `ws://127.0.0.1:7897` and `ws://localhost:7897` listed explicitly in `requiredPermissions.network.domains`. This is the known UXP localhost-permission bug (AdobeDocs/uxp-photoshop #321). Trying the documented workaround `"domains": "all"` next. |
| — | UDT gotchas | Manifest must have ≥1 icon (plugin-level `icons`). Manifest changes need Unload + Load. `console.log` is readable in UDT ▸ Debug ▸ Console. UXP `fs` has no `appendFileSync`. |

## Design consequences

- Photoshop tools = named commands (`ps.list_documents`, `ps.list_layers`, …) implemented in the panel against the `photoshop` module. No `eval` lane for Photoshop, ever.
- The handshake-file mechanism is validated for UXP; the panel needs no pasted token.

## Update (same day): the socket works — our own gate was the last blocker

- With `"network": { "domains": "all" }` the WebSocket left Photoshop and reached the hub (TCP
  connections seen on 7897). The explicit `ws://127.0.0.1:7897` entry is **rejected** by UXP on
  this build ("Manifest entry not found") — bug #321 confirmed on Photoshop 27.9.1 / Windows.
  Narrowing the permission is a later task; `"all"` is what works today.
- The hub then answered **403**: Photoshop's UXP WebSocket sends `Origin: file://`, which the
  Origin allowlist did not include. A browser sends the literal `null` for local documents, never
  `file://`, so `file://` is now accepted by default (token auth stays the real gate). Captured
  with a throwaway listener on port 7898 (`Host: 127.0.0.1:7898`, `Origin: file://`).
- `writeFileSync` to `~/.adobe-cc-mcp/panel-photoshop.log` works with `fullAccess`;
  `appendFileSync` is not available. Clipboard `setContent` works with `clipboard: readAndWrite`.

## RESULT: Spike 1 is GREEN on Windows (2026-08-26, ~19:08)

After a real server restart (the server only loads code at start — pid 66064 → 51492), the
panel reconnected on its own: `socket open — sending hello` → `welcome: server 0.1.0,
heartbeat 15000ms`. `netstat` shows the socket `ESTABLISHED`. `cc_connected_apps` reports
Photoshop `connected: true`. `ps_list_documents` returned the live document
(`Untitled-1`, 1920×1080, RGB, 1 layer) — a named command (`ps.list_documents`) executed inside
Photoshop's UXP panel, result back through the hub to Claude Code.

| Question | Answer (Windows, PS 27.9.1) |
|---|---|
| UXP → localhost WebSocket | **Works** with `network.domains: "all"`. Explicit `ws://127.0.0.1:PORT` entries are rejected by this UXP build (bug #321). |
| Handshake file for port + token | **Works** (`fs.readFileSync`, `localFileSystem: fullAccess`). No pasted token needed. |
| Protocol v2 hello/welcome/cmd/result + heartbeat | **Works.** Token auth passed; per-socket result matching fine. |
| Script strings in UXP | **Impossible** (`new Function` blocked). Named commands only — protocol v2's design is mandatory. |
| Hub Origin policy | Must accept `Origin: file://` (what UXP sends). Done; browsers send `null`, not `file://`. |
| Panel logging | `writeFileSync` to `~/.adobe-cc-mcp/panel-photoshop.log` works; `appendFileSync` missing. |

**Decisions unlocked:** the hub topology stands; `bridge-client` needs no Windows long-poll
fallback (at least for Photoshop 27.9 on this machine); the production `panel-uxp` is a
straight-line build from this spike (named command registry + `executeAsModal` + batchPlay).

**Still open:** macOS leg; Premiere UXP leg (same panel stack); whether a narrower
`network.domains` entry form exists that this UXP accepts.
