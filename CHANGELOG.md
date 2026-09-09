# Changelog

## Unreleased

Found while building a lower-third .mogrt skill end to end (Illustrator → Photoshop →
After Effects → Premiere):

- After Effects `ae_apply_effect` takes an optional `name` and renames the effect once
  applied. Essential Graphics labels a control with its effect name, so a Slider Control
  named `Speed` now shows as "Speed" in Premiere instead of "Slider Control".
- After Effects `ae_import_as_comp` takes optional `duration` and `frameRate`. Without them
  the imported comp came in at the project default (241 s) and every layer with it.
  Giving a duration also trims the layers to it, so outPoint-anchored outros land at the end.
- New After Effects tool `ae_set_comp_props`: name, duration, frameRate, width, height on an
  existing comp; a shorter duration trims layers the same way.
- After Effects `ae_add_layer` (text) and `ae_set_text` take `anchor: "center" | "origin"`.
  The default keeps the anchor at the text's visual centre; `origin` leaves it at [0, 0] so
  position is the left baseline — what a left-justified lower third wants. (Before, text
  placed by its left edge rendered half its width too far left.)
- After Effects `ae_add_layer_style` retries the Layer Styles menu command up to three times
  with a short pause, reselecting the layer each time. Seen live: the command did not take
  when other scripts were queued behind it and the tool failed with "menu command did not
  take".
- Known limit, not fixed: Premiere `pp_set_effect_param` cannot set a .mogrt text field
  (`Graphic Parameters` → text control); the UXP API rejects strings ("Illegal Parameter
  type") and reads the value back as null. Numbers (sliders) work.

## v0.3.0 — 2026-09-05

- After Effects `ae_import_as_comp`: import a layered Photoshop (.psd) or Illustrator (.ai)
  file as a composition — each source layer becomes its own AE layer, keeping blend modes,
  positions, and (for PSD) editable layer styles. `cropped` chooses Composition - Cropped
  Layers. Verified live: a PSD came in as three layers with its drop shadow editable in AE.
  (Illustrator maps top-level layers to AE layers, so put objects on separate layers to keep
  them separate; the file must be RGB and saved PDF-compatible.)
- After Effects Essential Graphics: `ae_add_to_essential_graphics` exposes a layer property
  (transform channel, a text layer's source text, or any property via propertyPath) as a
  control, and `ae_export_mogrt` exports the composition as a Motion Graphics template
  (.mogrt). Verified live against AE 26.3.
- Photoshop gradient overlay: `ps_set_layer_style` now takes `style: "gradientOverlay"` with
  `colors` (two or more hex stops), `gradientStyle` (linear/radial/angle/reflected/diamond),
  `angle`, `scale`, `reverse`, `alignWithLayer`, and `dither`.
- After Effects `ae_set_expression` now rolls the property back to its previous expression
  when the new one fails to compile (it used to leave the broken source assigned).
- Layer styles for Photoshop and After Effects. Photoshop: `ps_set_layer_style` (add or edit
  a drop shadow, inner shadow, glow, bevel & emboss, satin, color overlay, or stroke — other
  styles on the layer are kept), `ps_get_layer_styles`, `ps_remove_layer_style`. After
  Effects: `ae_add_layer_style`, `ae_set_layer_style_param`, `ae_get_layer_styles`,
  `ae_remove_layer_style` — friendly names map to AE's match names (satin → `chromeFX`,
  colorOverlay → `solidFill`, stroke → `frameFX`).
- New Premiere Pro tool `pp_insert_mogrt`: drop a Motion Graphics template (.mogrt) on the
  timeline at a time, like dragging it from the Essential Graphics panel. Without
  `videoTrackIndex` it lands on the first track above every video clip playing at that time,
  so the graphic sits over the picture.

## v0.2.2 — 2026-08-30

- The server reported itself as **0.1.0** to every MCP client and every panel, whatever
  version was actually installed — the string was typed out in four files and never bumped,
  so a 0.2.1 install still announced `serverInfo: 0.1.0` and the panels logged
  `welcome: server 0.1.0`. It now comes from `package.json` at runtime, in one place, and a
  test fails the build if a literal version reappears in the source. Found by installing
  0.2.1 from npm and speaking MCP to it.
- The Photoshop and After Effects/Audition panel manifests claimed 0.1.0 while the panels
  themselves reported 0.2.0; each manifest now matches the panel it describes.

## v0.2.1 — 2026-08-30

Housekeeping on top of 0.2.0: no new tools, nothing changed for an existing Windows or macOS
install.

- The installer now checks the platform before it does anything and exits saying that the
  Adobe applications this bridge drives run on Windows and macOS only. Previously it worked
  partway through and invented a `cep-extensions-unsupported` folder under the user's home;
  `pp_list_export_presets` likewise stopped offering a `~/Documents/Adobe` root on platforms
  where Adobe cannot be installed.
- `npm publish` no longer warns that the `bin` entries were "invalid and removed" — the paths
  lost their `./` prefix, which is the rewrite npm was doing silently. Both commands worked
  before and still do; the warning was noise on every release.
- Documentation names Windows and macOS as the supported platforms throughout, and the README
  status line and hand-off notes catch up with the 0.2 release.

## v0.2.0 — 2026-08-30

macOS brought up and verified live (Adobe 2026 apps), so both platforms Adobe ships Creative
Cloud for are now covered. Windows behaviour is unchanged, and CI runs the suite on Windows and
macOS. Details: `docs/spikes/13-macos-live.md`.

- **After Effects**: fixed the `aerender` path on macOS — `Folder.appPackage` is the `.app`
  bundle itself there, and `aerender` sits beside it. `ae_render_comp` and the render pipelines
  failed with "aerender not found" before.
- **Media Encoder** on macOS: find the console inside its nested bundle; read (and create)
  `ame_webservice_config.ini` in the app bundle's `Contents/Resources`, which is the only place
  the console looks — Adobe ships none, so the service used to start and never listen. The
  installer writes the file through Finder, since macOS "App Management" refuses bundle writes
  even under `sudo`, and `ame_server` now fails fast naming the path instead of timing out.
- **Media Encoder** on macOS: stop the hidden renderer the service starts. It runs in its own
  process group, so the previous group kill missed it and every idle stop leaked one; the driver
  now tracks only the renderer it caused and never touches an instance that was already running.
- **Illustrator** on macOS: pick which Illustrator the `ai_*` tools drive. The release and the
  Beta both ship a bundle named `Adobe Illustrator.app`, so an AppleScript name followed whichever
  was running. New `illustratorApp` config / `BRAINFERNO_MCP_ILLUSTRATOR_APP` accepts a name,
  bundle id or `.app` path; the installer detects both and asks.
- **Bridge**: the handshake file is no longer deleted by a second server instance that does not
  own it, and a server taking it over from a live one says so in the log. Panels reloading after
  an unrelated instance exited used to find no handshake at all.

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
  run (done in the next release — see Unreleased).
