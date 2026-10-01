# Brainferno MCP handoff pack

Work for the `brainferno-mcp-bridge` repo (the Brainferno MCP server for Adobe apps). It has two parts:
1. **`00_GLOBAL_PLAN.md`** — how the repo should use MD files, and eight global fixes (docs drift, a missing `CLAUDE.md`, stale notes, a stale panel, a disabled tool gate).
2. **One prompt file per feature**, grouped by Adobe app. After Effects prompts come from real use and are verified. Photoshop, Premiere, Illustrator, and Audition prompts come from the tool inventory and docs and are **unverified** (each says so at the top).

## How to use it in the repo session
1. Read this file, then `00_PREAMBLE.md` (the repo rules every prompt assumes).
2. Ask the owner which of the global fixes G1–G8 in `00_GLOBAL_PLAN.md` to run. Each edits something outside the code (the repo's docs, `~/.claude.json`, Claude memory, or the installed panel), so each needs the owner's OK.
3. Build prompts one at a time, in the order below. One prompt file = one branch = one PR.

Suggested one-line instruction for the new session:
> Read `README.md` and `00_PREAMBLE.md` in `C:\Users\Vince Parker\Documents\brainferno-mcp-handoff\`, then follow `00_GLOBAL_PLAN.md` (ask me which fixes to run), then start with `cross-app\X-03`.

To bring the pack into the repo (do this only if the owner agrees):
```powershell
Copy-Item -Recurse "C:\Users\Vince Parker\Documents\brainferno-mcp-handoff" "C:\Users\Vince Parker\Documents\GitHub\brainferno-mcp-bridge\docs\feature-requests"
```

## Build order
`X-03` → `X-01` → `AE-16` → `AE-01` → `AE-03` → `AE-02` → `AE-04` → `AE-05` → `AE-06` → `AE-07` → `X-02` → P2 After Effects → P3 → the other apps.

## Contents (39 files)
```
README.md                       this file
00_GLOBAL_PLAN.md               MD-file system + global fixes
00_PREAMBLE.md                  paste-first prompt: repo rules, test pattern, definition of done
after-effects/   AE-01 … AE-16   (verified)
photoshop/       PS-01 … PS-04   (unverified)
premiere/        PP-01 … PP-05   (unverified)
illustrator/     AI-01 … AI-04   (unverified)
audition/        AU-01 … AU-04   (unverified)
cross-app/       X-01 … X-03
```

| ID | Title | Priority | Evidence |
|---|---|---|---|
| X-03 | Registry-driven test coverage and a doc-drift guard | P1 | verified |
| X-01 | One run-script contract and a visible gate | P1 | verified |
| X-02 | Panel-version warning, `cc_launch_app`, blocked-app detection | P1 | verified |
| AE-01 | Raw script access that clients can discover, plus `ae_run_script` | P1 | verified |
| AE-02 | Project items: delete, folders, move, rename, duplicate comp | P1 | verified |
| AE-03 | Name addressing, `ae_batch`, undo / redo | P1 | verified |
| AE-04 | Fonts and text: font list, resolve feedback, missing fonts, style fields, centering | P1 | verified |
| AE-05 | Property tree, value at a time, generic setter; Source Text read bug | P1 | verified |
| AE-06 | Keyframe interpolation: hold, linear, bezier, ease, tangents | P1 | verified |
| AE-07 | Expression diagnostics: runtime errors, eval, find errors | P1 | verified |
| AE-08 | Shapes and masks: custom paths, groups, operators, gradients | P2 | verified |
| AE-09 | Layer operations, comp settings | P2 | verified |
| AE-10 | Render and preview: transparent background, alpha check, batch frames | P2 | verified |
| AE-11 | Project audit: tree, unused, missing, settings | P2 | verified |
| AE-12 | App and UI state: active comp, selection, time | P2 | verified |
| AE-16 | Error quality: corrected line numbers, context, "did you mean" | P2 | verified |
| AE-13 | Text animators | P3 | verified |
| AE-14 | Effects management | P3 | verified |
| AE-15 | Markers: list, update, remove | P3 | verified |
| PS-01 | Selections and masks | P1 | unverified |
| PS-02 | Adjustment, fill, and shape layers | P2 | unverified |
| PS-03 | Arrange, transform, group, merge, smart objects | P2 | unverified |
| PS-04 | Text editing, fonts, documents, export | P2 | unverified |
| PP-01 | Razor / split, lift / extract, in / out | P1 | unverified |
| PP-02 | Clip speed, duration, reverse; track management | P2 | unverified |
| PP-03 | Bins and project items | P2 | unverified |
| PP-04 | Marker edit and delete | P3 | unverified |
| PP-05 | Captions, transcription, interchange export | P3 | unverified |
| AI-01 | Paths, pathfinder, outline text | P1 | unverified |
| AI-02 | Open / close documents, layers, artboards, items | P1 | unverified |
| AI-03 | Swatches, CMYK / spot, gradients | P2 | unverified |
| AI-04 | Text style, place images, export options | P2 | unverified |
| AU-01 | Multitrack session authoring | P1 | unverified |
| AU-02 | Effects with parameters, favorites | P2 | unverified |
| AU-03 | Selection and markers | P2 | unverified |
| AU-04 | Export parameters, AME queueing | P3 | unverified |

## Evidence legend
- **verified** — the gap was hit against After Effects 26.5 with server v0.3.2, and the claims were checked against `packages/server/src/tools/after-effects.ts` (or the named source files for cross-app prompts).
- **unverified** — derived from the tool list and docs only. Verify against current behavior before building.

## Rules for the pack
- Nothing here should add project-specific code. Every prompt is a general capability.
- Do not copy Adobe-authored documentation into the repo. Use full Adobe product names in user-facing text.
- Each prompt names the tests to add; the repo's test pattern is in `00_PREAMBLE.md`.
