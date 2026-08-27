# Spike 2: After Effects CEP panel ↔ hub — GREEN on Windows (2026-08-26)

Panel: `spikes/cep-aftereffects/`, linked into `%APPDATA%\Adobe\CEP\extensions` with a directory
junction (no admin needed). Machine: Windows 11, After Effects 2026 (26.3x87), CEP 12
(Chromium 99.0.4844.84, Node via `cep_node`).

## What the panel proved (its own log, read over the CEP debug port)

| # | Question | Answer |
|---|---|---|
| 1 | Node inside the panel with `--enable-nodejs --mixed-context`? | **Yes.** `cep_node` object, global `require` works, `fs` reads and appends. |
| 2 | Read `~/.adobe-cc-mcp/bridge.json` for port + token? | **Yes.** No pasted token needed. |
| 3 | Browser `WebSocket` to `ws://127.0.0.1:7897`? | **Yes.** `socket open` → `welcome`. Chromium sends a `file://`-class Origin; the hub's `file://` allowance covers it (no 403). |
| 4 | `evalScript` → ExtendScript → JSON back, with error + line? | **Yes.** `{"two":2,"comps":0}` round-tripped; a thrown error came back as `deliberate (line 1)`. ExtendScript allows `eval`, so the generic `eval` command works for AE (unlike UXP). |
| — | End to end through Claude Code | `cc_connected_apps` → After Effects `connected: true`; `ae_project_info` → `{path:null, numItems:0, bitsPerChannel:8, version:"26.3x87"}`; `ae_list_compositions` → `[]`. |

## Setup that was needed (for the installer phase)

- `HKCU\Software\Adobe\CSXS.12\PlayerDebugMode = "1"` (also set 11 and 13). The folder
  `%APPDATA%\Adobe\CEP\extensions` did not exist and had to be created.
- A **directory junction** into the extensions folder is a fine dev loop: edits are live on the
  next panel open. Reload from outside with `location.reload()` over the debug port.
- No "Allow Scripts to Write Files and Access Network" pref was needed: results come back
  through `evalScript`'s return string, and the panel's Node side does the file I/O.

## Gotchas

- **CEP injects a global named `cep`** (`window.cep`, its own fs/process/util API). Declaring
  `const cep` in panel code is a SyntaxError that kills the whole script silently. Use another
  name.
- `.debug` next to the manifest maps a DevTools port (8093 here). `http://localhost:8093/json`
  lists the page; the DevTools protocol can evaluate JS in the panel and read
  `Runtime.exceptionThrown` / `Log.entryAdded` — the fastest way to debug a CEP panel from a
  terminal.
- Manifest `Version="7.0"` with `RequiredRuntime CSXS 9.0` loads fine in CEP 12.

## Still open

- `aerender` leg (save project → spawn `aerender -mfr`, parse progress). Needs a saved project.
- macOS leg (same panel; `~/Library/Application Support/Adobe/CEP/extensions`, `defaults write com.adobe.CSXS.12 PlayerDebugMode 1`).
- Audition host (`AUDT`) is already in the manifest; untested.
