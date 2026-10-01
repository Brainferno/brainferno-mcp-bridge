---
id: X-02
app: cross-app
title: Panel-version mismatch warning, cc_launch_app, and blocked-app detection
priority: P1
status: open
evidence: verified
depends_on: []
---

# X-02 — Panel version, launching apps, and blocked apps

## Problem
1. **A stale panel is invisible.** On the test machine the only installed After Effects panel was `PANEL_VERSION = "0.2.0"` (`C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\Brainferno MCP Bridge\main.js`) while the server was **0.3.2**. Nothing warned. New tools kept working only because the `eval` command is generic. A future protocol or helper change could break silently.
2. **Stale servers.** An old `node dist/index.js` can hold port 7897 while panels talk to it; the symptom is changes that "do nothing". The repo's own notes say to kill every stale instance and delete a dead-owner `bridge.json`. Nothing detects this.
3. **No way to start an app.** `docs/BUILD_PLAN.md:121` lists `ai_launch_app` as remaining. A client cannot start an Adobe app, and starting After Effects from a command line (`AfterFX.exe -r <script>`) from a sandboxed shell exited with code 0 and did nothing.
4. **Blocked apps look like timeouts.** When an Adobe app shows a modal dialog (for example a missing-font or missing-footage prompt on project open), every eval hangs until the timeout. The client sees `TIMEOUT` with no hint.
5. `cc_connected_apps` reports connection state only (`connected: true/false`, lane, panel, engine).

## Add
- **Version handshake.** Include the panel's `PANEL_VERSION` and the protocol version in the hello frame (see `docs/protocol.md`; keep backward compatibility with old panels, which will report none). `cc_connected_apps` returns `{ ..., panelVersion, serverVersion, compatible, hint }` where `hint` says e.g. `Panel 0.2.0 is older than server 0.3.2. Reinstall with "npm run install-cc".` Log a warning once per connection.
- **Stale-server detection.** On startup, if port `7897` is already owned, report the owning pid (from `bridge.json`) and whether it is alive; if the owner is dead, take over and say so in the log.
- **`cc_launch_app`** — `appId` (`after_effects | photoshop | premiere | illustrator | audition | media_encoder`), `waitForPanelSeconds` (default 60). Starts the app via the platform launcher (Windows: the installed executable path from the registry or `Program Files\Adobe`; macOS: `open -a`). Returns when the panel connects, or a clear message if the panel is not open (CEP: Window > Extensions; UXP: reload in the developer tool). `destructiveHint: false`, `timeoutClass: "slow"`.
- **Blocked-app detection.** When an eval hits its timeout, send a trivial probe (`1+1`) with a 2 s timeout; if the probe also times out, return `APP_BLOCKED` ("<App> is not responding to scripts. A dialog may be open — look at the app window.") instead of a bare `TIMEOUT`. Add `suppressDialogs` guidance for scripts that open projects (see `AE-01`).

## API hints
- The hello frame is built in `packages/panel-cep/main.js` and `packages/panel-uxp*/`; the server reads it in `packages/server/src/bridge/socket.ts`. `npm run panels:stamp` already writes the server version into panel manifests and `PANEL_VERSION` literals; compare against that.
- Heartbeats already exist (`BRAINFERNO_MCP_HEARTBEAT_MS`, default 15 s); reuse them for the probe.
- Keep shared-core changes small and call them out for the architect.

## Acceptance tests
1. A fake panel reporting `0.2.0` against a `0.3.2` server → `cc_connected_apps` shows `compatible: false` and the hint; a fake panel reporting no version is treated as "unknown, may be old".
2. A matching panel → `compatible: true`, no warning.
3. Dead-owner `bridge.json` → startup logs the takeover.
4. A fake panel that never answers evals → `APP_BLOCKED` with the dialog hint.
5. `cc_launch_app` returns a clear message when the app is not installed.
6. Update protocol tests for the new fields; old panels still connect.

## Definition of done
See `00_PREAMBLE.md`. Document the new fields in `docs/protocol.md`.
