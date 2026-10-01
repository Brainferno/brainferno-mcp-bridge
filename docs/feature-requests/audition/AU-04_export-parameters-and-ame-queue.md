---
id: AU-04
app: audition
title: Export parameters, multitrack mixdown, and Media Encoder queueing
priority: P3
status: open
evidence: unverified
depends_on: [AU-01]
---

# AU-04 — Export parameters and Media Encoder queueing

> **UNVERIFIED — verify against current behavior before building.** Derived from `packages/server/src/tools/audition.ts` (`au_save_document` uses only the file extension) and `docs/BUILD_PLAN.md:143` ("AMEServer queueing, job-backed batches"). Probe with `au_api_dump` first.

## Problem
- `au_save_document` (`path?`, `export?`) picks the format from the **file extension** only. No sample rate, bit depth, channel layout, MP3 bitrate, or other format options.
- No multitrack **mixdown** export with settings.
- A long export blocks, and there is no way to hand a session to Media Encoder from Audition (`AMEServer` queueing is listed as remaining work). The repo already has `ame_*` tools and a job registry (`cc_job_*`) for this pattern.

## Add
- **`au_export`** — `path`, `format` (`wav | mp3 | flac | aiff | ogg`), `sampleRate`, `bitDepth` (`16|24|32float`), `channels` (`mono|stereo|source`), `mp3BitrateKbps`, `scope` (`selection | wholeFile | multitrackMixdown`), `overwrite` (default `false`). Long exports run through `runOrQueue` and return a `jobId`.
- **`au_queue_in_ame`** — `path` (a session or file), `presetName|presetPath`, `output`. Uses the existing Media Encoder driver (`ame_encode`) instead of a new transport; returns an AME job id so `ame_job_status` and `cc_job_wait` work.
- Keep `au_save_document` behavior unchanged for existing callers.

## API hints
- Find export-with-options calls in `au_api_dump`; if only dialog routes exist, document them and let `X-02` surface a clear error.
- For AME, reuse `packages/server/src/tools/media-encoder.ts` and the job helpers in `tools/jobs.ts`; do not add a second queue implementation.

## Acceptance tests
1. `au_export({ format: "wav", sampleRate: 44100, bitDepth: "16" })` yields a file that `audio_probe` reports as 44.1 kHz / 16-bit.
2. `au_export({ format: "mp3", mp3BitrateKbps: 192 })` reports about 192 kbps.
3. A multitrack mixdown matches the session length.
4. `au_queue_in_ame` returns a job id; `cc_job_wait` completes it.
5. Overwriting an existing file without `overwrite: true` fails with an actionable message.
6. ES3 check; not-connected-path test.

## Definition of done
See `00_PREAMBLE.md`.
