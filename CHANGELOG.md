# Changelog

## v0.1.0 — 2026-08-28

First public release.

- MCP server (stdio; optional token-protected Streamable HTTP for other computers) with a
  hardened loopback hub for the in-app panels.
- Panels: Photoshop and Premiere Pro (UXP), After Effects and Audition (CEP), each with a
  live log and a kill switch.
- Tools: Photoshop 18 · After Effects 24 · Premiere Pro 28 · Illustrator 7 (+ pass-through to
  Adobe's 46 Illustrator MCP tools) · Audition 12 · Media Encoder 6 (headless web service) ·
  audio/ffmpeg 9 · pipelines 4 · jobs 4.
- Job registry with progress, cancel, per-job work folders, and failure reports naming the
  step and its recovery tool.
- Installer: choose apps, local vs shared-on-network, Illustrator key, panel setup, Claude
  Code registration.
- Verified live on Windows 11 with the Adobe 2026 applications; macOS paths written but not yet
  run.
