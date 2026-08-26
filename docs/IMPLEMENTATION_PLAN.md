# adobe-cc-mcp: Implementation Plan — Claude-Driven Adobe Creative Cloud Production Pipeline

## Context

The goal is an MCP server that lets Claude drive a real creative production pipeline across five Adobe desktop apps — Photoshop, Illustrator, After Effects, Premiere Pro, and Audition — for video and graphics work. The repo already contains a working scaffold (commit 46b7297): a TypeScript MCP server (`src/server.ts`), a loopback WebSocket bridge with token auth (`src/bridge/`), per-app tool modules (`src/tools/*.ts`), typed bridge errors, and tests that exercise the full path with a fake panel. What does not exist yet: the in-app panels, depth in the per-app tool sets, binary preview return, long-running job support, cross-app pipeline tools, and packaging.

User decisions taken:
- **Platforms:** macOS AND Windows from day one — every validation spike and installer must pass on both before moving on.
- **Depth priority:** After Effects and Photoshop get deep tool sets first; Premiere Pro, Illustrator, and Audition get useful-but-thinner coverage initially.

## Part 1 — API research: what actually works in 2025–2026

Verified by web research (Adobe developer docs, Adobe Tech Blog, Hyper Brew, community threads, prior-art repos). Two findings **contradict the current scaffold** and drive plan changes: Premiere's supported surface is now UXP, and Illustrator has no public UXP at all.

### Per-app automation surface (2025/2026 releases)

| App | Supported panel tech | Scripting engine | External channel | Headless |
|---|---|---|---|---|
| **Photoshop** 2025/2026 (v26/27) | **UXP** (primary, mature since v22); CEP 12 still loads but frozen | Modern JS: UXP DOM + `batchPlay` for gaps; ExtendScript deprecated/frozen | UXP `WebSocket` to localhost, gated by manifest v5 `requiredPermissions.network.domains` | None official; AppleScript/COM still supported for GUI driving |
| **Illustrator** 2025/2026 (v29/30) | **CEP 12 only** — UXP is Adobe-internal, repeatedly confirmed not public through 2026 | ExtendScript (ES3 JSX DOM), still the primary surface, no removal date | CEP panel with Node.js enabled → WebSockets | None; AppleScript/COM dictionaries still ship |
| **After Effects** 25.x/2026 | **CEP 12** fully supported, no announced sunset; no UXP (still "planned") | ExtendScript — primary and actively maintained (full DOM, undo groups, `Socket`) | CEP+Node WebSockets (richer) or ExtendScript `Socket` | **`aerender`** — render-only CLI; no headless script exec |
| **Premiere Pro** 25.6+/2026 (v26) | **UXP is now the standard** (beta 25.6 → GA in Premiere 2026); CEP superseded with a ~1-year sunset | Modern JS via `@adobe/premierepro` UXP API (promise-based, TS typings, stable+beta channels); **ExtendScript supported only through ~Sept 2026** | UXP WebSocket (PPro ≥25.6, manifest v5, localhost domains allowed) | None; exports go through Adobe Media Encoder |
| **Audition** 25.x/26.0 | **CEP only** (its sole extensibility route) | Undocumented mini-DOM reachable only via CEP `evalScript`; no official reference (introspect via Adobe-CEP sample "Script Dictionary" panels) | CEP+Node WebSockets | None; no AppleScript/COM |

### Deprecation landscape (what to build on vs avoid)

- **CEP 12 is the last major CEP release** (ships with PS 25.12, PPro 25.0, AE 25.0; security fixes only). Safe for AE/Illustrator/Audition through the 2026 cycle; already breaking in Premiere 2026.
- **ExtendScript Toolkit is dead**; debugging is via the ExtendScript Debugger for VS Code. ExtendScript itself remains the only scripting engine for AE, Illustrator, and Audition.
- **Do not build Premiere on CEP/ExtendScript** — it has the only hard removal timeline (~Sept 2026 for ExtendScript). Premiere gets a UXP panel using `@adobe/premierepro`.
- **UXP network I/O caveat:** `WebSocket`/`fetch` require manifest v5 network-domain permissions; `ws://127.0.0.1:<port>` entries are allowed (wildcards are not, since UXP 7.4). Port must therefore be fixed or the manifest regenerated at install time.
- **Audition is alive but frozen** (26.0 shipped Jan 2026, Windows-ARM native, no new features; no EOL announcement). Its tool scope must be validated by introspection spike — the API is undocumented.
- **AppleScript/COM**: only Photoshop and Illustrator have rich dictionaries; useful solely as an app-launch/open-project fallback, not as a primary channel. AE has none beyond shelling to `aerender`; Premiere and Audition none meaningful.

### Prior art (validates the architecture)

- **adb-mcp** (Mike Chambers, Adobe — experimental, personal): MCP server → local WebSocket proxy → UXP plugins (PS/PPro/InDesign) + CEP (AE/Illustrator). Confirms the core constraint: *UXP plugins cannot listen; they can only dial out* — exactly the panel-dials-in design this repo already has.
- **loonghao/dcc-mcp-photoshop**, **matrayu/adobe-mcp**, **alisaitteke/photoshop-mcp**: same proxy pattern, larger tool surfaces; useful references for Photoshop tool depth.
- **Adobe has no official local-app MCP** (their official direction is cloud Firefly Services + the "Adobe for creativity" remote MCP). Local desktop control is community territory — this project is not duplicating an official product.

### MCP platform facts the plan targets

- Spec **2025-11-25** is current: structured tool output (`outputSchema`/`structuredContent`), progress notifications via `progressToken`, cancellation surfacing as `AbortSignal` in handlers, image content blocks (`{type:"image", data:<b64>, mimeType}`), tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`), experimental **Tasks** primitive for async jobs (watch, don't depend on yet).
- Build on **TypeScript SDK v1.x** (already a dependency at ^1.30.0); v2 (package split, Zod 4) is beta with stable planned mid-2026 — migrate later, don't wait.
- stdio transport for the MCP side (no HTTP attack surface); the WebSocket listener is the only network surface and needs DNS-rebinding hardening (Origin/Host validation — the SDKs' own advisories show this off by default).
- Distribution: npm + `npx`, `claude mcp add` / project `.mcp.json` for Claude Code, `claude_desktop_config.json` plus an **MCPB bundle** (`npx @anthropic-ai/mcpb init/pack`; successor to `.dxt`) for one-click Claude Desktop install.

## Part 2 — Architecture

### 2.1 One unified server, per-app adapters (confirmed direction)

Keep the existing shape: **one MCP server process** (`adobe-cc-mcp`, stdio transport) that also runs the **bridge** — a WebSocket server on `127.0.0.1` that in-app panels dial into. Do not split into five servers: the MCP host sees one coherent toolset, cross-app pipeline tools need one process that can see all connections, and the bridge/token/config/logging/testing machinery is identical for every app.

```
Claude (Desktop / Code)
   │ stdio (MCP)
   ▼
adobe-cc-mcp  ──ws://127.0.0.1:7777──►  UXP panel in Photoshop
  │  shared core                        UXP panel in Premiere Pro (@adobe/premierepro API)
  │  per-app tool modules               CEP panel in After Effects
  │  job manager                        CEP panel in Illustrator
  │  preview store                      CEP panel in Audition
  ▼
 filesystem workspace (exports, rendered frames, previews)
```

**What is shared (one codebase):**
- MCP server assembly, config, logging (`src/server.ts`, `src/config.ts`, `src/logging.ts` — exist).
- Bridge protocol + WebSocket server (`src/bridge/` — exists; extend, don't rewrite).
- Tool result formatting, error guard (`src/tools/result.ts` — exists), plus new shared helpers: `imageResult()` (base64 image content blocks), job manager, path validation, script-template helpers per engine.
- The **CEP panel** is one codebase serving AE, Illustrator, and Audition — same HTML/JS shell, same WebSocket client, host-specific only in its manifest and in which ExtendScript entry it loads. The **UXP panel** is one codebase serving Photoshop and Premiere Pro, differing in manifest host entry and in which host module scripts touch (`photoshop` vs `premierepro`). **This requires correcting `src/apps.ts`:** the scaffold maps Illustrator to UXP and Premiere to ExtendScript — research shows the reverse is what's supported (Illustrator has no public UXP; Premiere's ExtendScript dies ~Sept 2026). The Premiere tool scripts in `src/tools/premiere.ts` must be rewritten from ExtendScript to the `@adobe/premierepro` UXP API; the Illustrator ones from UXP-style JS to ES3 ExtendScript.
- Panel-side transport module (connect, hello/token, eval dispatch, reconnect with backoff) — written once per plugin technology (once for UXP, once for CEP), not per app.

**What is unavoidably per-app:**
- The scripts themselves. Each app has a different DOM and, worse, two different engines: UXP hosts run modern JS; ExtendScript hosts run ES3 (no `const`, no arrow functions, no `JSON` global — ship a `json2.jsx` polyfill in the CEP panel). Existing `src/tools/<app>.ts` files already respect this split; per-app tool buildout stays in those files.
- The eval mechanism inside the panel: UXP evaluates JS directly in the panel context; CEP panels must pass scripts across to the ExtendScript engine via `CSInterface.evalScript()` (string in, string out — hence JSON-serialize everything at the boundary).
- Host quirks: AE's render queue and undo groups, Premiere's sequence/track model and Media Encoder handoff, Photoshop's `executeAsModal` requirement for anything that mutates state, Illustrator artboards, Audition's thin DOM.

### 2.2 Bridge protocol extensions (v2)

Current protocol (`src/bridge/protocol.ts`) is hello/welcome/eval/result. Extend to:

- **`progress` frame** (panel → server): `{type:"progress", id, percent?, message?}` for long evals (renders, exports). The server forwards these as MCP progress notifications.
- **`file` result convention:** scripts that produce binaries never send bytes over the bridge; they write to a server-designated workspace path and return `{filePath}`. The server reads the file, downsizes if needed, and returns it as an MCP image block. (Keeps frames small; WebSocket stays a control channel.)
- **`ping`/heartbeat** so half-dead panels (app quit without closing socket) are detected and evicted.
- **Capability report in `hello`:** panel announces host version and feature flags (e.g., `{engine:"uxp", hostVersion:"26.0", features:["executeAsModal"]}`) so tools can degrade gracefully across app versions.
- Bump `PROTOCOL_VERSION` to 2; keep the version check strict (already implemented).

### 2.3 Long-running jobs

Renders and exports outlive any sane tool-call timeout. Add a **job manager** in the server core:

- `job_*` tools: kick-off tools (e.g., `ae_render_comp`, `pp_export_sequence`) return immediately with `{jobId, status:"running"}`; `cc_job_status(jobId)` and `cc_job_cancel(jobId)` are shared tools. Completed jobs report output paths + a small preview image.
- Where the host API is synchronous-blocking (AE ExtendScript `renderQueue.render()` blocks the whole app), prefer non-blocking alternatives found in research (aerender subprocess for AE; Media Encoder queue for Premiere) — the job manager can own child processes as well as bridge evals.
- Emit MCP progress notifications when the client passed a `progressToken`, and honor cancellation via the handler's `AbortSignal`. (The spec's new experimental Tasks primitive is the eventual home for this pattern — track it, don't build on it yet.)

### 2.4 Binary previews back to the model

- All renders/exports land in a per-session **workspace directory** (config: `ADOBE_CC_MCP_WORKSPACE`, default `~/adobe-cc-mcp-workspace` or OS temp).
- New shared helper `imageResult(filePath, {maxDim})`: loads PNG/JPEG, downscales to ≤~1024px (`sharp` dependency), returns MCP `image` content block (base64) alongside a text block with the full-res path.
- Preview tools per app: `ps_export_preview` (flattened doc snapshot), `ai_export_preview` (artboard PNG), `ae_render_frame` (single frame at a time via render-queue-still or aerender), `pp_export_frame` (Premiere frame export), `au_waveform_info` (Audition has no visual preview; return peak/RMS stats and, later, a rendered waveform image drawn server-side).
- Video previews: never return video bytes; return the file path + a contact sheet (N frames sampled and tiled into one image) so Claude can "see" the cut.

### 2.5 Tool design and naming

- **Prefix per app:** `ps_`, `ai_`, `ae_`, `pp_`, `au_`, and `cc_` for cross-app/shared. (Rename existing `ppro_` → `pp_` for consistency and brevity — do this before freezing the interface.)
- **Verb-object names:** `ae_create_comp`, `ps_set_layer_props`, `pp_insert_clip`.
- **Annotations honestly set:** `readOnlyHint` on all list/get tools; `destructiveHint` on delete/overwrite/save; `idempotentHint` where true.
- **Structured errors:** keep the `guard()` pattern; every error message states what happened and what the agent can do next ("Open After Effects and load the panel…"). Add error `code` strings (`APP_NOT_CONNECTED`, `SCRIPT_ERROR`, `TIMEOUT`, `JOB_FAILED`, `PATH_DENIED`) in the text so agents can branch.
- **Escape hatch retained:** `cc_eval_script(app, script)` stays, clearly documented per engine, so Claude can cover gaps — this is the single highest-leverage tool for an LLM driver.
- Tools always advertised even when the app is closed (existing decision — keep).
- Add `cc_open_project(app, path)` / `cc_launch_app(app)` using OS-level launch (macOS `open -a` / AppleScript, Windows `start` / COM) so a pipeline can begin from nothing.

### 2.6 Security / local hardening

- Bridge binds `127.0.0.1` only (done). Keep the **per-install token**: generated on first run into a config file (`~/.adobe-cc-mcp/token`, 0600) rather than only via env; panels read it from the same file at install time or via a one-time pairing code shown by `cc_pairing_info`. This removes today's "empty token disables auth" default — token becomes mandatory-by-default.
- **Origin/handshake checking** on the WebSocket upgrade to defeat browser-based DNS-rebinding/localhost attacks: reject upgrades that carry a browser `Origin` header not matching the panels' known origins, and require the token in the first frame within a short deadline or drop.
- Path validation: any tool parameter that is a filesystem path is resolved and must fall inside the workspace or user-approved directories; document that scripts run with full user privileges inside Adobe apps.
- No network egress from the server; everything is loopback + filesystem.

### 2.7 Cross-app pipeline tools

Built last, on top of per-app tools, in `src/tools/pipeline.ts`:
- `cc_pipeline_status` — one call summarizing connected apps, open projects, running jobs.
- `cc_transfer_asset(fromApp, toApp, …)` — e.g., export PSD comp → import as AE footage; AE render → import into Premiere bin; Premiere sequence audio → open in Audition, and re-link back on save.
- Recipe-level tools where a multi-step handoff is common and fiddly: `cc_psd_to_ae_comp` (import PSD as layered comp), `cc_roundtrip_audio_premiere_audition`.
- These are orchestration in the server core (multiple bridge calls + file moves), not new panel code.

## Part 3 — Numbered build plan

Interleaved so risk dies early. Every step lists its exit criteria; a step is done only when its exit criteria pass **on both macOS and Windows** where the step touches an app or installer.

**Phase A — Foundation & bridge hardening (server-side only, no Adobe apps needed)**
1. Correct the engine map in `src/apps.ts` (Premiere → UXP, Illustrator → ExtendScript) and rewrite `src/tools/premiere.ts` scripts to the `@adobe/premierepro` UXP API and `src/tools/illustrator.ts` to ES3 ExtendScript. Rename `ppro_` → `pp_`; freeze naming conventions and the tool-interface style guide in `CONTRIBUTING.md` (this document is what the parallel agents later build against).
2. Bridge protocol v2: progress frames, heartbeat, capability hello, file-result convention (`src/bridge/protocol.ts`, `socket.ts`, `types.ts`). Update fake-panel tests.
3. Job manager (`src/jobs.ts`) + `cc_job_status`/`cc_job_cancel` + MCP progress notification forwarding. Test with a fake long eval.
4. Workspace + preview core: config'd workspace dir, path validation helper, `imageResult()` with `sharp`, contact-sheet helper. Unit-tested with fixture images.
5. Security hardening: mandatory token file + pairing flow, Origin check on upgrade, hello deadline. Tests for each rejection path.
   *Exit criteria for Phase A: `npm test` green; a scripted fake panel demonstrates progress + job + image round-trip end-to-end.*

**Phase B — Validation spikes (one per automation surface; timeboxed, throwaway code allowed)**
6. **UXP spike (Photoshop):** minimal UXP panel that connects to the bridge, evals a script, runs `executeAsModal`, writes an exported PNG to the workspace. Proves: WebSocket-from-UXP with manifest v5 `network.domains` for `ws://127.0.0.1:<port>` (fixed port or manifest generated at install), token flow, file write permissions. Both OSes.
7. **CEP spike (After Effects):** minimal CEP panel connecting to the bridge, `evalScript` into ExtendScript with `json2.jsx`, render one frame to the workspace. Proves: CEP 12 loads in current AE (`PlayerDebugMode` for dev + ZXP signing story), Node-enabled CEP vs plain browser WebSocket, ES3 JSON round-trip. Both OSes.
8. **Premiere UXP spike:** UXP panel in PPro ≥25.6 using `@adobe/premierepro`; list sequences, export one frame. Proves the new API's real coverage (it is young — verify timeline *editing*, not just reading, before committing tool scope) and whether stable vs `@beta` channel is needed per tool.
9. **Illustrator CEP spike:** the CEP shell in Illustrator; list documents, create a shape, export an artboard PNG via ExtendScript. Confirms the JSX DOM depth needed for the planned tool set.
10. **Audition spike:** CEP shell in Audition; introspect the undocumented `evalScript` API using the Adobe-CEP "Script Dictionary"/"Application Commands" sample technique; define realistic tool scope from what is actually reachable. This spike gates Audition's Phase D scope.
11. **Headless-render spike:** drive `aerender` and Adobe Media Encoder watch-folder/queue from the server as child processes; this de-risks the job manager's non-blocking render path.
    *Exit criteria per spike: a one-page findings note (what works, what doesn't, chosen mechanism) committed to `docs/spikes/`; go/no-go per app surface. The interface freeze for Phase C happens only after all spikes land.*

**Phase C — Panels productionized**
12. UXP panel (`panel-uxp/`): shared transport module, manifests per host (Photoshop, Premiere Pro), reconnect/backoff, token from pairing, status UI (connection state, last command, log).
13. CEP panel (`panel-cep/`): shared shell + per-host manifests (After Effects, Illustrator, Audition), ExtendScript loader + `json2.jsx`, same status UI.
14. Panel dev-install docs + scripts: UXP Developer Tool workflow, CEP debug-mode flags (`PlayerDebugMode`), per-OS install paths.
    *Exit criteria: all five apps connect and pass a smoke script on both OSes; `cc_connected_apps` shows them.*

**Phase D — Per-app tool buildout (parallelizable across agents once interface is frozen)**
15. **After Effects (deep):** project/comp/layer CRUD, footage import, keyframes and expressions, effects add/set, markers, render-queue + aerender jobs, `ae_render_frame` preview.
16. **Photoshop (deep):** document/layer CRUD, text layers, smart objects, selections + fills, adjustment layers, batchPlay escape hatch (`ps_batchplay`), export (PNG/JPEG/PSD), `ps_export_preview`.
17. **Premiere Pro (useful):** project/bin/sequence read, import footage, insert/overwrite clips on the timeline, markers, audio levels, frame export, Media Encoder export job.
18. **Illustrator (useful):** document/artboard read, create shapes/text, fills/strokes, export artboards (PNG/SVG/PDF), preview.
19. **Audition (useful):** open/import audio, basic edits per what spike 10 proved (amplitude, effects rack if reachable), export/render, loudness stats.
    *Exit criteria per app: tool list reviewed against the style guide; integration smoke test against the live app on both OSes; every tool documented in README.*

**Phase E — Cross-app pipeline tools**
20. `src/tools/pipeline.ts`: `cc_pipeline_status`, `cc_transfer_asset`, `cc_psd_to_ae_comp`, Premiere↔Audition audio round-trip, `cc_launch_app`/`cc_open_project`.
21. One scripted end-to-end demo: Photoshop title card → AE animation → render → Premiere timeline → Audition-treated audio → final export, driven purely through MCP tools. This is the acceptance test for the whole project.

**Phase F — Packaging & distribution**
22. Panel installers: CEP ZXP (signed with `ZXPSignCmd`) + UXP `.ccx`/UXP Developer Tool story; an `adobe-cc-mcp install-panels` CLI subcommand that copies panels to the right per-OS locations and writes the pairing token.
23. Server distribution: publish to npm (`npx adobe-cc-mcp`); Claude Code via `claude mcp add` + committed `.mcp.json` example; Claude Desktop via a `claude_desktop_config.json` snippet and an **MCPB bundle** (`npx @anthropic-ai/mcpb init/pack`) for one-click install — the bundle's first-run hook points users at the panel installer.
24. Docs: quickstart per OS, per-app panel enablement, security notes, troubleshooting matrix (app closed / panel stale / modal dialog blocking).
    *Exit criteria: a fresh machine (each OS) goes from `npx` + installer to the Phase E demo working, following only the README.*

## Part 4 — Multi-agent development workflow (Claude Code subagents)

Principles: parallelism only after the interface freeze (end of Phase B); every code-writing agent is paired with an independent reviewer; verification against live Adobe apps is human-in-the-loop (agents can't see the GUI apps) and is scripted to make that cheap.

**Phase A–B (foundation & spikes) — serial, one builder + one reviewer**
- *Builder agent* (general-purpose) implements Phase A steps in order; the bridge protocol and job manager are the load-bearing interfaces everything else consumes, so they are built by a single agent for coherence.
- *Review agent* (code-review) reviews each step's diff for correctness and for interface-freeze quality — its explicit brief: "would five parallel teams building against this interface get stuck or diverge?"
- Spikes are run by one agent each but sequentially per OS with the human operator loading panels into the real apps; each spike agent's deliverable is the `docs/spikes/` findings note, reviewed by the architect (main session) before freeze.

**Interface freeze gate** — the main session (architect) consolidates spikes, finalizes `src/bridge/protocol.ts`, `src/tools/result.ts` helpers, the style guide, and stubs each `src/tools/<app>.ts` with typed signatures + TODO bodies. From here, files are territorially owned: one app = one agent = one file (plus its panel host code), eliminating merge conflicts by construction.

**Phase C–D (panels + per-app tools) — parallel fan-out**
- 5 *app-builder agents* in parallel (worktree isolation), one per app: `ae-builder`, `ps-builder`, `pp-builder`, `ai-builder`, `au-builder`. Each owns `src/tools/<app>.ts`, its panel host glue, and its tests against the fake panel. They build against the frozen bridge interface only — no edits to shared core; a needed core change is raised to the architect, who serializes it.
- 2 *panel-shell agents*: one for the UXP shell, one for the CEP shell (shared transport, reconnect, status UI skeleton).
- Each builder's output goes to a *code-review agent* with a per-app checklist: style-guide conformance (naming, annotations, error codes), engine correctness (ES3 rules for ExtendScript files — reviewer explicitly greps for `const`/arrow functions/`JSON.` in ExtendScript strings), timeout choices, path validation on every filesystem parameter.
- A *test-verifier agent* runs the full vitest suite + typecheck after each merge and bisects breakage to the offending merge.

**Debugging loop (live-app verification)**
- Agents cannot drive the GUI apps, so verification is a tight human-in-the-loop cycle: a *debug agent* generates a per-app smoke script (`scripts/smoke-<app>.ts`) that calls every tool via the MCP SDK client and prints a pass/fail table; the human runs it with the app open, pastes the output back; the debug agent diagnoses failures (it has the panel logs and server stderr), patches, and re-issues the script. Iterate until the table is green on both OSes.
- Recurring failures get distilled into the troubleshooting matrix doc by the same agent.

**UI-design pass (in-app panels)**
- After panels are functional: a *UI-design agent* (using the frontend/design skills) restyles the panel: connection status, per-host theming (match Adobe's dark UI, respect CEP `CSInterface` theme sync / UXP theme tokens), activity log, pairing-code entry, "copy diagnostics" button. Deliverable is HTML/CSS only — no transport changes — reviewed by the panel-shell reviewer, then human-verified visually in each host.

**Phase E–F — reconvergence**
- Pipeline tools and packaging are built by a single *integration agent* (they span all apps), reviewed by a code-review agent, verified via the Phase E end-to-end demo run by the human with the debug agent watching logs.
- Final pass: a *docs agent* rewrites README/quickstart from the real, working state; a *security-review agent* (security-review skill) audits the bridge, token handling, and path validation before the first npm publish.

**Who does what, summarized**

| Phase | Builds | Reviews | Verifies |
|---|---|---|---|
| A foundation | 1 core builder | code-review agent (interface-quality brief) | vitest via test-verifier |
| B spikes | 1 agent per spike, serial | architect (main session) | human loads panels in real apps |
| C panels | 2 shell agents (UXP, CEP) | code-review agent | human + debug-agent smoke loop |
| D app tools | 5 parallel app-builders (worktrees) | per-app code-review agents (engine checklist) | test-verifier + human smoke loop per app/OS |
| UI pass | 1 UI-design agent | panel reviewer | human visual check in each host |
| E pipeline | 1 integration agent | code-review agent | end-to-end demo, human + debug agent |
| F packaging | integration agent + docs agent | security-review agent | fresh-machine install test per OS |

## Verification

- Unit/integration: `npm run typecheck && npm test` (fake-panel tests already exercise tool→bridge→result; extend for progress, jobs, images).
- Live: per-app smoke scripts (`scripts/smoke-<app>.ts`) run with the app open on each OS; the Phase E end-to-end demo is the final acceptance test.
- Packaging: fresh-machine install from README only, both OSes.

