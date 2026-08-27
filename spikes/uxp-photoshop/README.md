# Spike 1 — Photoshop UXP panel ↔ adobe-cc-mcp hub

Throwaway panel that answers the plan's riskiest question: **can a UXP panel dial out to our
hub over a localhost WebSocket (on Windows), authenticate, and answer commands?**

## Load it (one time)

1. Start `adobe-cc-mcp` (Claude Code does this; it writes `~/.adobe-cc-mcp/bridge.json` with
   the port and token the panel reads).
2. Open **Photoshop 2026**. Turn on developer mode: **Edit ▸ Preferences ▸ Plugins ▸
   Enable Developer Mode** (restart Photoshop if it asks).
3. Open **Adobe UXP Developer Tool**. Click **Add Plugin** and pick
   `spikes/uxp-photoshop/manifest.json`. Click **Load** (or **Load & Watch**).
4. In Photoshop the panel appears under **Plugins ▸ adobe-cc-mcp bridge (spike)**.
   It reads the handshake file and connects on load; press **Connect** if it did not.

Watch the panel log. It reports, in order:

- `new Function works` / `BLOCKED` — whether UXP can evaluate script strings (finding #4).
- `handshake read OK` / `FAILED` — whether `fs` can read the file with `localFileSystem: fullAccess`.
- `socket open` → `welcome` — the WebSocket + protocol v2 round trip (findings #2, #3).
- `cmd ps.list_documents → ok` when Claude calls `ps_list_documents`.

## What "done" looks like

In Claude Code, `ps_list_documents` returns the open documents. The panel's badge is green.
The **Kill switch** button closes the socket and the tool then reports "not connected".

## Notes

- The manifest lists `ws://127.0.0.1:7897` and `ws://localhost:7897` explicitly: UXP needs the
  exact endpoint in `requiredPermissions.network.domains` (no wildcards since UXP 7.4). If you
  change `ADOBE_CC_MCP_BRIDGE_PORT`, change the manifest too and re-load.
- Dev-loaded plugins unload when Photoshop restarts; re-Load in UDT. Installed `.ccx` plugins
  persist (Phase 6).
- Record results in `docs/spikes/03-photoshop-uxp.md`.
