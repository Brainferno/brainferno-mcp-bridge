# Brainferno MCP Bridge — Premiere Pro panel (UXP)

Loads into Premiere Pro 25.6+ through the UXP Developer Tool (UDT).

1. Premiere Pro: **Settings → Plugins → Enable developer mode**, then restart Premiere.
2. UDT: **Add Plugin** → pick this folder's `manifest.json` → **Load**.
3. The panel opens from **Window → Extensions (UXP) → Brainferno MCP Bridge** and dials the hub on its own.

Commands are implemented in `commands.js` against `require("premierepro")` (typed by
`@adobe/premierepro` 26.3). Every mutation runs inside `project.lockedAccess` +
`project.executeTransaction`, so each tool call is one undo step.
