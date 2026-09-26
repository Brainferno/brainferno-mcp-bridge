# Spike 15 — Codex CLI and Gemini CLI lanes, live

Status: **not yet run.** The code landed unit-tested (see the `Unreleased` CHANGELOG
section); this doc is the checklist for verifying it against the real CLIs, on Windows and
macOS, the way every other lane was verified. Record findings inline, keep the reasoning,
and move anything load-bearing into the README or HANDOFF.

## Why these checks exist

- Codex CLI kills tool calls at `tool_timeout_sec` (default 60 s) and does not feed MCP
  image blocks to the model (openai/codex#4819, #10334). The Codex registration therefore
  sets `BRAINFERNO_MCP_DEFAULT_WAIT=false`, `BRAINFERNO_MCP_PREVIEW=path`,
  `BRAINFERNO_MCP_JOB_WAIT_SECONDS=50`.
- Gemini CLI renders images, so its registration sets only `BRAINFERNO_MCP_DEFAULT_WAIT`.
- Each CLI's `mcp add` syntax drifts between releases; the installer shells out to the
  installed CLI rather than writing its config file, so the checks below pin down which
  versions accept which flags.

## The checklist

### Codex CLI

1. `codex mcp add … --env …` accepted by the installed Codex version (older builds lack
   `--env`: fall back to writing the block by hand; note the minimum version). The Windows
   `.cmd` shim probe (`codex --version` through the shell) exits 0.
2. `codex` session: every tool listed — the count matches what `/mcp` shows in Claude Code
   for the same config — and the schemas are accepted (no tool-conversion warnings); the
   `wait` descriptions read "Default false".
3. `ae_render_comp` (or `ame_encode`) returns a jobId immediately; `cc_job_wait` polls
   return inside 60 s with the "still running" hint until done. No tool-timeout kills.
4. `ps_get_preview` with `BRAINFERNO_MCP_PREVIEW=path`: the agent gets the path and
   can `view_image` it.
5. Shared mode from a second machine: `url` + `bearer_token_env_var` in
   `~/.codex/config.toml` connects through the Streamable HTTP listener.

### Gemini CLI

6. `gemini mcp add -s user -e …` syntax accepted; tools listed; schema warnings noted if
   any (Gemini sanitizes some JSON Schema keywords — check the unions in
   `pp_set_effect_param` and `ae_set_keyframes` survive).
7. Inline previews render (Gemini keeps `BRAINFERNO_MCP_PREVIEW` unset).
8. Shared mode via `httpUrl` + `headers` in `~/.gemini/settings.json`.

### Regression

9. Claude Code untouched: registration still lands in user scope, long tools still block
   by default, previews still show inline, `/mcp` shows the right version.
10. `--clients claude` registers with Claude Code only, even when Codex and Gemini are
    installed.
