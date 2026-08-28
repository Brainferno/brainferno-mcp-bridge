# Media Encoder lane — live run (2026-08-28, Windows, Adobe Media Encoder 26.3.2)

Question: can MCP drive Media Encoder too? Three doors were probed on this machine.

## Door 1 — the built-in "Remote AME" web service (shipped; chosen)

`ame_webservice_console.exe` beside the AME executable starts a hidden AME renderer and
serves XML over HTTP: `GET /server`, `GET|POST|DELETE /job`, `GET /history`. Adobe's own
web console (`ame_webconsole_assets/`) documents the request manifest:
`SourcePresetPath`, `SourceFilePath`, `DestinationPath`, `OverwriteDestinationIfPresent`,
`SequenceGUID` (for `.prproj`), `NotificationTarget`, `NotificationRateInMilliseconds`.

Live:
- Listener up ~5 s after launch. WAV → MP3 (128 kbps preset): `Queued` → `Success` in < 5 s.
- Through the MCP tools: `ame_encode` on the Premiere project `ClaudeBod.prproj`, sequence
  "Brainferno Cut" by GUID, preset "H264 Match Source - High bitrate" → 15 s 1920×1080 H.264
  with audio, **17 s wall clock including the service start**. The job ran as a registry
  job (steps: start service → submit → encode with progress).

Gotchas (all handled in `src/drivers/ame-webservice.ts`):
- **Binds a sniffed LAN adapter, not loopback** (`192.168.1.51:8080` here), no auth. The
  console ignores every command-line flag and only reads `ame_webservice_config.ini` next to
  the exe (not the working directory). The driver probes loopback first, then every local
  IPv4. To pin it to loopback, edit that ini once as admin: `ip = 127.0.0.1`. The server
  starts the service on demand and stops it after 10 idle minutes (`ADOBE_CC_MCP_AME_IDLE_MS`)
  and on shutdown, so the exposure window is short.
- **Header names are matched case-sensitively.** A POST with lowercase `content-length`
  (what Node's `fetch`/undici sends) never gets an answer; `Content-Length` works. The driver
  uses raw `node:http` with canonical names.
- **One job at a time.** A second POST answers `<SubmitResult>Busy</SubmitResult>`; the
  driver serializes its own submissions and waits on Busy.
- Killing the console leaves the renderer alive → `taskkill /T` (process-group kill on mac).
- **The output extension comes from the preset, not the request.** `…\brainferno-cut-ame.mp4`
  was written as `brainferno-cut-ame.mov` (that "H264 Match Source" preset is in the QuickTime
  family). `ame_encode` looks for the sibling file AME actually wrote and reports it.
- `.prproj` sources load through Dynamic Link; allow minutes on a cold renderer (10-min submit
  timeout). Having the project open in Premiere at the same time was fine.

## Door 2 — ExtendScript API through a CEP panel (documented, not built)

Official reference: https://ame-scripting.docsforadobe.dev/ — `app.getFrontend()`
(`addFileToBatch`, `addCompToBatch(.aep)`, `addDLToBatch(.prproj, guid)`, `stitchFiles`),
`app.getEncoderHost()` (`runBatch/pauseBatch/stopBatch`, `getFormatList`, `createEncoderForFormat`,
`getCurrentBatchPreview`), `app.getExporter()` (`exportItem`, `exportSequence`, events),
`EncoderWrapper` (`loadPreset`, `setOutputFrameSize`, `setWorkArea`, crop/rotate/frame rate),
watch folders. AME is a CEP host (`<Host Name="AME">` in Adobe's own shipped extension), so the
existing `panel-cep` can be extended with one manifest line when queue control is wanted.

## Door 3 — command line (`--console es.processFile script.jsx`)

Runs a script in a (new or already running) AME instance, but writing results back to a
file did not work in two probes; the app also stays open. Not pursued.

## Tool inventory (`ame_*`, 6)
server (start on demand) · encode (job: media / .prproj + sequence GUID / FCP XML with
presetPath or presetName) · job_status · history · cancel · stop_server
