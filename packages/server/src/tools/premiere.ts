import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/**
 * Premiere Pro is driven through its UXP API (`require("premierepro")`,
 * available in PPro 25.6 and later) — modern, promise-based JavaScript.
 * Scripts here may return a Promise; the panel awaits it before serializing
 * the result.
 *
 * The API is young and its exact coverage is confirmed by the Phase B spike
 * (docs/IMPLEMENTATION_PLAN.md, step 8). Anything beyond the documented
 * surface is wrapped defensively so a missing method reads as a script error
 * with a name in it, not a silent wrong answer.
 */

const PROJECT_INFO = `(async () => {
  const ppro = require("premierepro");
  const project = await ppro.Project.getActiveProject();
  if (!project) { throw new Error("No project is open"); }
  const sequences = await project.getSequences();
  return {
    name: project.name,
    path: project.path ?? null,
    numSequences: sequences.length,
  };
})()`;

const LIST_SEQUENCES = `(async () => {
  const ppro = require("premierepro");
  const project = await ppro.Project.getActiveProject();
  if (!project) { throw new Error("No project is open"); }
  const sequences = await project.getSequences();
  return Promise.all(sequences.map(async (seq) => ({
    id: String(seq.guid),
    name: seq.name,
    videoTracks: await seq.getVideoTrackCount(),
    audioTracks: await seq.getAudioTrackCount(),
  })));
})()`;

export function registerPremiereTools(server: McpServer, bridge: AppBridge): void {
  server.registerTool(
    "pp_project_info",
    {
      title: "Premiere Pro: project info",
      description: "Read the open Premiere Pro project's name, path, and sequence count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(PROJECT_INFO))),
  );

  server.registerTool(
    "pp_list_sequences",
    {
      title: "Premiere Pro: list sequences",
      description: "List every sequence in the open project with its id and video/audio track counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(LIST_SEQUENCES))),
  );
}
