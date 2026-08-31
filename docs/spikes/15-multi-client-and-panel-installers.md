# Spike 15 — Codex/Gemini lanes and the panel installers, live

Status: **not yet run.** The code landed unit-tested (see the `Unreleased` CHANGELOG
section); this doc is the checklist for verifying it against the real apps and CLIs, on
Windows and macOS, the way every other lane was verified. Record findings inline, keep the
reasoning, and move anything load-bearing into the README or HANDOFF.

## Why these checks exist

- Codex CLI kills tool calls at `tool_timeout_sec` (default 60 s) and does not feed MCP
  image blocks to the model (openai/codex#4819, #10334). The Codex registration therefore
  sets `BRAINFERNO_MCP_DEFAULT_WAIT=false`, `BRAINFERNO_MCP_PREVIEW=path`,
  `BRAINFERNO_MCP_JOB_WAIT_SECONDS=50`.
- Adobe's Unified Plugin Installer Agent (UPIA, ships with the Creative Cloud desktop app)
  installs `.ccx`/`.zxp` without developer mode. Adobe documents `.ccx` installs for both
  Photoshop and Premiere Pro UXP plug-ins; ZXPSignCmd exists for Windows and macOS only
  (publish.yml signs on a macOS runner for that reason).

## The checklist

### Panel installers (both OSes)

1. `node scripts/package-panels.mjs` on a machine with ZXPSignCmd — all three artifacts.
2. `UnifiedPluginInstallerAgent --install photoshop.ccx` (installer does this): exit code
   and output on success and on "already installed" — capture the exact strings; does a
   newer version replace in place, or need `--remove` first? While Photoshop is running?
3. Same for `premiere.ccx` (Premiere 25.6+): confirm a UPIA-installed UXP panel loads with
   developer mode OFF, on both OSes.
4. Does Photoshop require developer mode for a UPIA-installed (unsigned, non-marketplace)
   `.ccx`, or does it load clean? Any "unverified developer" prompt?
5. `cep.zxp` self-signed: installs via UPIA, panel loads with `PlayerDebugMode=0`, and the
   installer's junction removal leaves exactly one panel entry in AE and Audition.
6. Double-click fallback: `.ccx` with the app closed → Creative Cloud installs it.
7. Re-run the installer after an upgrade: panels reinstalled at the new version, panels log
   `welcome: server X.Y.Z` matching.
8. The ZXPSignCmd download used by publish.yml
   (`CEP-Resources/raw/master/ZXPSignCMD/4.1.3/macOS/ZXPSignCmd`) still resolves, runs on
   the macos-latest runner, and `-selfSignedCert`/`-sign -tsa` succeed from CI.

### Codex CLI

9. `codex mcp add … --env …` accepted by the installed Codex version (older builds lack
   `--env`: fall back to writing the block by hand; note the minimum version). The Windows
   `.cmd` shim probe (`codex --version` through the shell) exits 0.
10. `codex` session: 113 tools listed, schemas accepted (no tool-conversion warnings) —
    the `wait` descriptions read "Default false".
11. `ae_render_comp` (or `ame_encode`) returns a jobId immediately; `cc_job_wait` polls
    return inside 60 s with the "still running" hint until done. No tool-timeout kills.
12. `ps_preview_document` with `BRAINFERNO_MCP_PREVIEW=path`: the agent gets the path and
    can `view_image` it.
13. Shared mode from a second machine: `url` + `bearer_token_env_var` in
    `~/.codex/config.toml` connects through the Streamable HTTP listener.

### Gemini CLI

14. `gemini mcp add -s user -e …` syntax accepted; tools listed; schema warnings noted if
    any (Gemini sanitizes some JSON Schema keywords — check the unions in
    `pp_set_effect_param` and `ae_set_keyframes` survive).
15. Inline previews render (Gemini keeps `BRAINFERNO_MCP_PREVIEW` unset).
16. Shared mode via `httpUrl` + `headers` in `~/.gemini/settings.json`.

### Regression

17. Claude Code untouched: registration still lands in user scope, long tools still block
    by default, previews still show inline, `/mcp` shows the right version.
