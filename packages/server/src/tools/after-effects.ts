import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge } from "../bridge/types.js";
import { jsStringLiteral } from "../bridge/script-escape.js";
import { guard, jsonResult } from "./result.js";

/**
 * After Effects is ExtendScript-only (ES3): the scripts below deliberately use
 * `var`, avoid arrow functions, and build plain objects for the panel to
 * serialize. Do not modernize them.
 */

const LIST_COMPOSITIONS = `(function () {
  var comps = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem) {
      comps.push({
        id: item.id,
        name: item.name,
        width: item.width,
        height: item.height,
        duration: item.duration,
        frameRate: item.frameRate,
        numLayers: item.numLayers
      });
    }
  }
  return comps;
})()`;

const PROJECT_INFO = `(function () {
  var proj = app.project;
  return {
    path: proj.file ? proj.file.fsName : null,
    numItems: proj.numItems,
    bitsPerChannel: proj.bitsPerChannel,
    dirty: proj.dirty === true,
    version: app.version
  };
})()`;

function renderQueueScript(compName: string, outputPath: string, templateName: string | undefined): string {
  // jsStringLiteral, not JSON.stringify: the latter leaves U+2028/U+2029 raw,
  // which are line terminators to ExtendScript's ES3 parser (a comp name or
  // path containing one would break the script — or inject into it).
  const comp = jsStringLiteral(compName);
  const out = jsStringLiteral(outputPath);
  const template = templateName === undefined ? "null" : jsStringLiteral(templateName);
  return `(function () {
  var target = null;
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === ${comp}) { target = item; break; }
  }
  if (target === null) { throw new Error("No composition named " + ${comp}); }

  var rqItem = app.project.renderQueue.items.add(target);
  var output = rqItem.outputModule(1);
  var template = ${template};
  if (template !== null) { output.applyTemplate(template); }
  output.file = new File(${out});

  return {
    queueIndex: app.project.renderQueue.numItems,
    compName: target.name,
    outputPath: output.file.fsName,
    status: "queued"
  };
})()`;
}

export function registerAfterEffectsTools(server: McpServer, bridge: AppBridge): void {
  server.registerTool(
    "ae_project_info",
    {
      title: "After Effects: project info",
      description:
        "Read the open After Effects project's file path, item count, bit depth, and unsaved-changes flag.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(PROJECT_INFO))),
  );

  server.registerTool(
    "ae_list_compositions",
    {
      title: "After Effects: list compositions",
      description:
        "List every composition in the open project with its dimensions, duration, frame rate, and layer count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(async () => jsonResult(await bridge.evaluate(LIST_COMPOSITIONS))),
  );

  server.registerTool(
    "ae_queue_render",
    {
      title: "After Effects: add a composition to the render queue",
      description:
        "Add a composition to the render queue and set its output path. This queues the render but does not start it — " +
        "rendering is left to the operator, or to aerender for headless work.",
      inputSchema: {
        compName: z.string().min(1).describe("Exact name of the composition to queue."),
        outputPath: z.string().min(1).describe("Absolute output file path."),
        templateName: z
          .string()
          .min(1)
          .optional()
          .describe("Output module template to apply, e.g. 'H.264 - Match Render Settings'."),
      },
    },
    async ({ compName, outputPath, templateName }) =>
      guard(async () => jsonResult(await bridge.evaluate(renderQueueScript(compName, outputPath, templateName)))),
  );
}
