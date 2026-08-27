# Spike 3: Illustrator os-script lane — Windows leg GREEN (2026-08-26)

**Goal:** drive Illustrator with no panel, from outside the process, for the two things
Adobe's built-in MCP cannot do: draw new art and save `.ai`.

**How:** `src/drivers/osscript.ts`. PowerShell → COM `Illustrator.Application` →
`DoJavaScript('$.evalFile("<temp>.jsx")')`. The `.jsx` is the tool script wrapped in an ES3
prelude (JSON stringifier + try/catch with line) that writes `{ok, value|error}` to a result
file. No shell quoting of the real script; no lossy return strings.

**Machine:** Windows 11, Illustrator (Beta) 30.9.0. Registry ProgIDs `Illustrator.Application`
and `Illustrator.Application.30` both point at the Beta. COM attaches to the running instance.

**Result:** create document → 5 shapes/text (rect, ellipse, star, rounded rect, point text with
`ArialMT`) → PNG preview at 74% (800 px) → `saveAs` a real `.ai` (PDF-based). The preview
matched the intent pixel-for-pixel: artboard-relative, y-down coordinates convert correctly.

**Latency:** 1–5 s per call (PowerShell start-up + COM). Fine for v1. Later: keep one
PowerShell host alive per session to get this under ~300 ms.

**Gotchas found:**
- Helper functions must live *inside* the script's IIFE. Put before it, they become a named
  function expression after `var __acmValue =` and are not in scope (`__doc is not a function`).
- Every tool script is one expression (an IIFE). The wrapper relies on that.
- Illustrator's ExtendScript has no `JSON`; the prelude ships a stringifier. No file-write
  preference is needed (unlike After Effects).
- `doc.fullName` throws on a never-saved document — guard it.

**Not yet verified:** macOS leg (`osascript` `do javascript` + the one-time TCC Automation prompt).
