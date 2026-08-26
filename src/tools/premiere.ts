import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/** Premiere Pro is ExtendScript-only (ES3) — see the note in after-effects.ts. */

const PROJECT_INFO = `(function () {
  var proj = app.project;
  return {
    name: proj.name,
    path: proj.path,
    numSequences: proj.sequences.numSequences,
    version: app.version
  };
})()`;

const LIST_SEQUENCES = `(function () {
  var out = [];
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    var seq = app.project.sequences[i];
    out.push({
      id: seq.sequenceID,
      name: seq.name,
      videoTracks: seq.videoTracks.numTracks,
      audioTracks: seq.audioTracks.numTracks,
      timebase: seq.timebase,
      zeroPoint: seq.zeroPoint
    });
  }
  return out;
})()`;

export function registerPremiereTools(server: McpServer, bridge: AppBridge): void {
  server.registerTool(
    "ppro_project_info",
    {
      title: "Premiere Pro: project info",
      description: "Read the open Premiere Pro project's name, path, and sequence count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(PROJECT_INFO))),
  );

  server.registerTool(
    "ppro_list_sequences",
    {
      title: "Premiere Pro: list sequences",
      description: "List every sequence in the open project with its track counts and timebase.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(LIST_SEQUENCES))),
  );
}
