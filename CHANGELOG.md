# Changelog

## Unreleased

One run-script contract and a gate clients can see (X-01).

**Breaking**

- `cc_eval_script` and `ps_batch_play` now return the raw-script envelope
  `{ ok, error?: { message, line, bodyLine }, durationMs, value, logs, logsDropped? }`, keys in
  that order. `ps_batch_play`'s results array moved under `value`.
- A raw-script tool error is now either plain text (nothing was sent: raw scripts disabled, app
  not enabled, app not connected) or a JSON envelope (the script or batch was sent and may have
  partly run). A script that throws in the host, a timeout, or a panel that disconnects
  mid-call now gives the JSON form, where a script error used to come back as plain text.
- `ps_batch_play`: a batch whose results contain an in-band `{ _obj: "error" }` entry now
  returns `ok: false` (an `isError` result) naming the failing descriptor, instead of reporting
  success.
- `cc_eval_script` runs the script through an ES3 wrapper. The value of its last statement is
  still the result (an IIFE still works; a top-level `return` is a syntax error).
  - The new `__log(msg)` collects log lines: up to 200 lines / 20000 characters, each line cut
    at 2000. `logsDropped` counts the rest, and once a line is dropped every later one is too,
    so `logs` is always a prefix of what was logged. `__log` never throws into the script: a
    value that cannot be turned into text is logged as `[unprintable]`.
  - A result that is not plain data — a host object such as a layer, a comp or a `Date` — is
    now refused with its path instead of being serialized best-effort. The check covers exactly
    what the hosts' serializer writes, inherited keys included: an instance of the ES3
    `Ctor.prototype = { … }` pattern holding a host object is refused, and a cycle fails fast
    instead of overflowing the serializer. Plain data with its own `constructor` key is
    accepted.
  - `error.bodyLine` is the failing line in the caller's script. It is set only when the host's
    line numbers can be calibrated and the error was raised in the caller's own text, not in a
    `$.evalFile`'d library or a helper an earlier call left behind; otherwise it is `null`.
  - A script that adds data (non-function) properties to `Object.prototype`, or changes ones
    already there, fails, naming them: every object would inherit them, which breaks the
    host's serializer for every later call to that app, typed tools included. Added ones are
    removed and changed ones set back to their value from before the call; the error says
    which, and names any it could not remove or restore. Members other code (another
    extension, a startup script) put there before the call are left alone. A script that had
    already failed keeps its own error first.

**Changed**

- `cc_eval_script` and `ps_batch_play` are always registered and refuse — touching no app —
  while their gate is closed. The default tool list grows from 127 to 130 (these two plus
  `cc_get_capabilities`).
- `BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS` takes `1` (now also `true` in any case, `all` or `*`) for
  every raw-capable app, or a comma list of app ids (`after_effects`, `photoshop`,
  `illustrator`, `audition`; the short names `ae`, `ps`, `ai`, `au` work too). Premiere Pro,
  Media Encoder and unknown names are ignored with a warning, never enabled.
- `=1` / `all` now actually reaches Illustrator: its raw scripts go through the OS scripting
  lane, which launches Illustrator if it is closed. A runner failure after the script may have
  reached Illustrator — AppleScript giving up on the reply, Illustrator crashing or quitting
  mid-script — gives the JSON envelope "the script was sent; it may have partly run — check
  Illustrator before re-running". Only failures that provably happen before dispatch are plain
  text (the runner cannot start; COM cannot create the object, e.g. class not registered;
  AppleScript -600, -1728, -1743, -10814: app not running, not found, Automation not allowed),
  and a failure the lane cannot classify counts as sent. A call that leaves no result file says
  so and names the likely causes (a modal dialog, a temp file that could not be read or
  written); the script's own syntax errors come back as `ok: false`. The typed `ai_*` tools
  show the same messages as before.
- Remote (shared HTTP) sessions refuse raw scripts unless the new
  `BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1` is set.
- `cc_eval_script` refuses an app whose tools are not enabled (`BRAINFERNO_MCP_APPS`): the
  refusal says to rerun the installer and pick the app, or to set `BRAINFERNO_MCP_APPS` to the
  full list of apps, since it replaces the installer's choice rather than adding to it.
  `timeoutMs` is capped at 30 minutes.
- New audit line for every raw call, run or refused, on both tools (`ps_batch_play` had none):
  `AUDIT raw-script tool=… app=… sha256=<12 hex> len=… [count=…] via=stdio|http:<8 chars> outcome=run|refused`.
  It is written at every log level and carries no script text; the first 200 characters of a
  script that runs moved to the `debug` log (`cc_eval_script` used to put them in a `warn`
  line; see Fixed). When the gate is open the server writes one
  `AUDIT raw scripts ENABLED for …` line at startup; the "raw-script tool is disabled" info
  lines are gone.

**Added**

- `cc_get_capabilities` (read-only, contacts no app): server and protocol versions, whether the
  session is local or remote, the raw-script gate, one row per gated tool (enabled, how to
  enable it, app connected, panel supports the command), and each panel's version and host
  version.
- The hub now keeps each panel's `panelVersion`, `hostVersion` and `capabilities` from its
  hello (`BridgeServer.panelInfo`).

**Fixed**

- `cc_eval_script` for Illustrator always failed with "not connected": it was routed to the
  panel hub, where Illustrator has no panel. It now uses the same OS scripting lane as the
  `ai_*` tools.
- `ps_batch_play` reported failed descriptors as success (see Breaking).
- The OS scripting lane left the temporary script and result files on disk when the runner
  failed or timed out. Both are now removed when the call ends, whatever the outcome. A result
  written by a script that outlives its timeout, or the files of a server killed mid-call, are
  swept on a later call (and at the next start) once they are older than twice the longest
  deadline a call can get (the 30-minute `timeoutMs` cap, or `BRAINFERNO_MCP_EVAL_TIMEOUT_MS`
  when that is longer) plus 5 minutes: 65 minutes with the default settings.
- macOS: typed `ai_*` calls with a deadline above about two minutes
  (`BRAINFERNO_MCP_EVAL_TIMEOUT_MS`) failed at AppleScript's default 120 s Apple-event timeout
  (-1712) while Illustrator kept running the script. `do javascript` now runs inside
  `with timeout of <deadline + 5> seconds`, so the server's own deadline is the one that fires
  (for `cc_eval_script`, as the timeout envelope).
- `cc_eval_script` wrote the first 200 characters of every script, unescaped, into a `warn`
  log line, so a script containing line breaks could add lines of its own to the server log.
  The excerpt (now at `debug`) is escaped onto one line, so a script cannot forge a log line
  such as an `AUDIT` record.

**Docs**

- `CONTRIBUTING.md` (architect review): raw-script tools are always registered and refuse when
  gated; a new "Raw-script tools — one contract" section (envelope, error-shape rule, gate,
  audit); corrected two stale claims — UXP panels run named commands and never evaluate script
  strings, and the CEP panel defines its own `__acmJson` rather than loading `json2.jsx`.
- `docs/spikes/07-premiere-tools-live.md`: the Premiere Pro raw-script investigation — no eval
  path today, the `allowCodeGenerationFromStrings` lead, an operator probe, and why no
  `pp_run_action` was built.
- README (raw scripts section, configuration, security), `.env.example`, `docs/HANDOFF.md`,
  `docs/feature-requests/00_PREAMBLE.md` and spikes 05 and 14 updated to match.
- `CONTRIBUTING.md`: failed or cancelled jobs carry JSON errors too (the job view), so JSON is
  the dispatch signal only for the raw-script tools; the error-shape rule names the os-script
  lane's `RunnerExitedError`. `docs/HANDOFF.md` no longer counts `ps_batch_play` as verified
  live and no longer names a release by hand. `AE-01` is rebased on X-01 (reuse
  `raw-script.ts`, the shared refusal text, an undo group for `ae_run_script`), and
  `00_PREAMBLE.md` describes the After Effects test pattern as it is since X-03 (every exported
  script builder classified as `MUST_UNDO`, `NO_UNDO_OK` or `READ_ONLY_BUILDERS`;
  `es3Violations` in the new `test/es3.ts`) and drops its stale notes (CONTRIBUTING's
  `jsStringLiteral` text, tool counts and the `ae_queue_render` gap before X-03).

## v0.3.3 — 2026-10-01

- Doc-drift guard (X-03): `tool-counts.test.ts` counts the live tool registry under the
  default config and fails, printing the right number, when a tool count in `README.md` or
  `docs/HANDOFF.md` disagrees. Fixed the stale counts it caught (After Effects 33 → 34, total
  124 → 127, and the per-prefix table), plus a stale env-var name and handshake path in the
  spike docs and a done item in `BUILD_PLAN.md`.
- After Effects test coverage (X-03): every exported script builder is now classified
  (read-only / undo-wrapped / app-level), so a new mutating tool can't silently skip the
  `__undo` and ES3 checks; `ae_queue_render` moved from an inline script to the exported
  `queueRenderScript` builder so it joins those checks.
- Repo guide (G1): added `CLAUDE.md` — a short front-door note (commands, non-negotiables,
  where the spikes/quirks/feature-requests live) that imports `CONTRIBUTING.md` and
  `docs/HANDOFF.md`. Added the `docs/feature-requests/` pack (one prompt file per feature,
  starting from `00_PREAMBLE.md`).
- `CONTRIBUTING.md` brought in line with the code (G2): script values go through
  `jsStringLiteral` (with the U+2028/U+2029 note), the actual-message error contract (no
  planned code prefix), `timeoutClass` + `runOrQueue`/`cc_job_wait` for long work, the two
  deliberate tool gates (raw-script escape hatches, Illustrator delegate), and a note that
  `tool-counts.test.ts` enforces the counts.
- Durable quirks moved into the repo (G4): five notes under `docs/quirks/` — AE layer styles,
  AE mogrt export, AE PSD/AI import, AE shapes/masks, and panel packaging — so every clone
  carries the hard-won gotchas instead of them living only in one machine's memory.
- `CLAUDE.md` accuracy (G8): the workspace list was missing the `bridge-client` package; added
  it (found via the `claude-md-improver` audit).

## v0.3.2 — 2026-09-30

- After Effects `ae_add_shape`: create a shape layer with a parametric rectangle, ellipse,
  star, or polygon plus an optional fill and stroke (hex colors, stroke width, corner
  roundness, star/polygon points and radii). Verified live.
- After Effects `ae_add_mask`: add a rectangle or ellipse mask to a layer in the layer's
  coordinates, with mode (add/subtract/intersect/lighten/darken/difference/none), feather,
  opacity, and expansion; ellipse masks use proper bezier handles. Verified live. (Solids
  and text layers were already available via `ae_add_layer`.)

## v0.3.1 — 2026-09-27

- **Codex CLI and Gemini CLI are first-class clients.** The installer registers the
  server with every MCP client CLI it finds (Claude Code, Codex CLI, Gemini CLI; filter
  with `--clients`), each with the env defaults that suit it. Three new env vars carry
  the differences: `BRAINFERNO_MCP_DEFAULT_WAIT` (false = long tools return a jobId at
  once, for Codex's 60-second tool timeout — the advertised `wait` parameter now states
  the live default), `BRAINFERNO_MCP_PREVIEW` (`path` returns previews as file paths for
  clients that cannot show the model images; `inline`, `both`), and
  `BRAINFERNO_MCP_JOB_WAIT_SECONDS` (the default `cc_job_wait` timeout, set to 50 for
  Codex so each poll returns inside its limit). Claude Code keeps exactly the old
  behavior. In shared mode the installer prints per-client connection snippets — Codex
  reads the bearer token from an env var, Gemini from a headers block.
- **Panel versions can no longer drift.** `npm run panels:stamp` writes the package
  version into the three panel manifests and each panel's `PANEL_VERSION`, and a test
  fails when a bump forgets it. v0.3.0 shipped with its panels still reporting 0.2.0
  (Photoshop, After Effects/Audition) and 0.1.0 (Premiere); from this release on they
  carry the package version.

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
