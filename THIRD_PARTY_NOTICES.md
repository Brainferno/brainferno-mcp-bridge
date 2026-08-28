# Third-party notices

Brainferno MCP Bridge is licensed under the Apache License 2.0 (see `LICENSE`). It depends
on, talks to, or was informed by the following third-party software and materials. None of
the Adobe materials below are copied into this repository.

## Runtime dependencies (bundled by `npm install`)

| Package | License | Copyright |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | MIT | Anthropic, PBC |
| `ws` | MIT | Einar Otto Stangvik and contributors |
| `zod` | MIT | Colin McDonnell |

Development-only dependencies (`typescript`, `vitest`, `tsx`, `@types/*`) are MIT or
Apache-2.0 licensed and are not distributed with the product.

## Adobe interfaces this software talks to (not distributed here)

- **Adobe UXP** (Photoshop, Premiere Pro panels) and **Adobe CEP** (After Effects,
  Audition panel), **ExtendScript**, the **Illustrator MCP server** built into Adobe
  Illustrator, the **Adobe Media Encoder web service** (`ame_webservice_console`), and
  **aerender**. These ship with the Adobe applications under Adobe's own terms; users need
  their own licensed copies. Use of the Adobe developer platforms is governed by the Adobe
  Developer Terms of Use (https://www.adobe.com/legal/terms/developer.html).
- `@adobe/premierepro` (TypeScript type definitions, Apache-2.0, Adobe) was used as a
  reference while writing the Premiere Pro panel. It is not bundled.
- Adobe sample code was read for API behavior but not copied: `Adobe-CEP/Samples` (MIT,
  Adobe), `AdobeDocs/uxp-premiere-pro-samples` (Apache-2.0, Adobe), and the Remote AME web
  console assets shipped with Adobe Media Encoder.
- `docs/api-dumps/audition-26.3.json` is a list of class, property and method names and
  types obtained by ExtendScript reflection from Adobe Audition, recorded for
  interoperability. Adobe-authored help text was removed before publishing.

## Documentation consulted

- Adobe Developer documentation for UXP, Premiere Pro, and Photoshop
  (https://developer.adobe.com), Adobe's CEP resources (https://github.com/Adobe-CEP), and
  the community-maintained *Adobe Media Encoder Scripting Guide*
  (https://ame-scripting.docsforadobe.dev, © Adobe).

## Optional external programs (not distributed here)

- **ffmpeg / ffprobe** (https://ffmpeg.org; LGPL-2.1+ or GPL depending on the build) power
  the `audio_*` tools. The user installs ffmpeg separately; this software only runs it.
- **Node.js** (MIT-style license, https://github.com/nodejs/node/blob/main/LICENSE).

## Trademarks

Adobe, After Effects, Audition, Creative Cloud, Illustrator, Media Encoder, Photoshop, and
Premiere Pro are either registered trademarks or trademarks of Adobe in the United States
and/or other countries. Other names may be trademarks of their respective owners.
