import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsStringLiteral } from "../bridge/script-escape.js";
import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/**
 * Audition is driven through the CEP panel's `eval` command (ExtendScript,
 * ES3). Its DOM is the thinnest of the five and mostly undocumented, so this
 * file leans on ExtendScript reflection: `Application.reflect.properties`
 * lists every `COMMAND_*` menu command (invoked with `app.invokeCommand`),
 * `$.dictionary` dumps the whole API, and document state is read generically
 * from `doc.reflect.properties`. Deterministic audio work (loudness, convert,
 * trim, denoise, mix) lives in the ffmpeg lane (`audio_*`), not here.
 *
 * Rules: var only, no arrow functions, one IIFE per script.
 */

const HELPERS = `
  function __doc() { var d = app.activeDocument; if (!d) { throw new Error("No document is open in Audition. Open one (au_open_document) or create one in the app."); } return d; }
  function __kind(o) { try { return o.reflect.name; } catch (e) { return typeof o; } }
  function __props(o) {
    var out = {};
    try {
      var ps = o.reflect.properties;
      for (var i = 0; i < ps.length; i++) {
        var n = ps[i].name;
        if (n === "reflect" || n === "__proto__" || n === "prototype") { continue; }
        try {
          var v = o[n]; var t = typeof v;
          if (v === null || v === undefined) { out[n] = null; }
          else if (t === "number" || t === "string" || t === "boolean") { out[n] = v; }
          else if (v instanceof File || v instanceof Folder) { out[n] = v.fsName; }
          else if (t === "object") { out[n] = "<" + __kind(v) + ">"; }
        } catch (e) { out[n] = "<unreadable>"; }
      }
    } catch (e) {}
    return out;
  }
  function __docInfo(d) {
    var p = __props(d);
    var sr = typeof p.sampleRate === "number" ? p.sampleRate : 0;
    return {
      kind: __kind(d),
      name: p.displayName !== undefined ? p.displayName : null,
      sampleRate: sr || null,
      durationSeconds: sr && typeof p.duration === "number" ? p.duration / sr : null,
      playheadSeconds: sr && typeof p.playheadPosition === "number" ? p.playheadPosition / sr : null,
      props: p
    };
  }
  function __docs() {
    var out = [];
    try { var ds = app.documents; for (var i = 0; i < ds.length; i++) { out.push({ index: i, kind: __kind(ds[i]), name: ds[i].displayName }); } } catch (e) {}
    return out;
  }
`;

const wrap = (body: string) => `(function () {${HELPERS}${body}\n})()`;

export const APP_STATE = wrap(`
  var d = app.activeDocument;
  return {
    version: app.version,
    build: app.buildNumber || null,
    documents: __docs(),
    activeDocument: d ? __docInfo(d) : null
  };`);

export const DOCUMENT_INFO = wrap(`return __docInfo(__doc());`);

export function listCommandsScript(filter: string | undefined, checkEnabled: boolean): string {
  return wrap(`
  var f = ${filter === undefined ? "null" : jsStringLiteral(filter.toLowerCase())};
  var check = ${checkEnabled ? "true" : "false"};
  var out = [];
  var ps = Application.reflect.properties;
  for (var i = 0; i < ps.length; i++) {
    var n = ps[i].name;
    if (n.indexOf("COMMAND_") !== 0) { continue; }
    var id = Application[n];
    var help = ps[i].help || "";
    if (f !== null && String(id).toLowerCase().indexOf(f) < 0 && n.toLowerCase().indexOf(f) < 0 && String(help).toLowerCase().indexOf(f) < 0) { continue; }
    var row = { id: id, constant: n, help: help };
    if (check) { try { row.enabled = app.isCommandEnabled(id); } catch (e) { row.enabled = null; } }
    out.push(row);
  }
  return out;`);
}

export function invokeCommandScript(id: string, force: boolean): string {
  return wrap(`
  var id = ${jsStringLiteral(id)};
  var enabled = null;
  try { enabled = app.isCommandEnabled(id); } catch (e) {}
  if (enabled === false && !${force ? "true" : "false"}) { throw new Error("Command " + id + " is not enabled in the current view/selection (au_list_commands with checkEnabled shows what is)."); }
  app.invokeCommand(id);
  return { invoked: id, wasEnabled: enabled };`);
}

export function setPlayheadScript(seconds: number): string {
  return wrap(`
  var d = __doc();
  var sr = d.sampleRate;
  if (!sr) { throw new Error("The active document has no sample rate (is it a multitrack session?)."); }
  d.playheadPosition = Math.round(${seconds} * sr);
  return __docInfo(d);`);
}

export function openDocumentScript(path: string): string {
  return wrap(`
  var f = new File(${jsStringLiteral(path)});
  if (!f.exists) { throw new Error("File not found: " + f.fsName); }
  var d = null, errs = [];
  if (typeof app.openDocument === "function") { try { d = app.openDocument(f); } catch (e) { errs.push("openDocument(File): " + e.message); } }
  if (!d && typeof app.openDocument === "function") { try { d = app.openDocument(f.fsName); } catch (e) { errs.push("openDocument(path): " + e.message); } }
  if (!d && typeof app.open === "function") { try { d = app.open(f); } catch (e) { errs.push("open(File): " + e.message); } }
  if (!d) { d = app.activeDocument; }
  if (!d) { throw new Error("Audition did not open the file" + (errs.length ? " (" + errs.join("; ") + ")" : " (no open method on app; run au_api_dump)")); }
  return __docInfo(d);`);
}

export function saveDocumentScript(path: string | undefined): string {
  return wrap(`
  var d = __doc();
  var path = ${path === undefined ? "null" : jsStringLiteral(path)};
  var ok = null, errs = [];
  if (path === null) {
    if (typeof d.save === "function") { try { ok = d.save(); } catch (e) { errs.push("save(): " + e.message); } }
    else { errs.push("no save() on " + __kind(d)); }
  } else {
    var f = new File(path);
    if (typeof d.saveAs === "function") {
      try { ok = d.saveAs(f); } catch (e) { errs.push("saveAs(File): " + e.message); }
      if (ok === null || ok === false) { try { ok = d.saveAs(f.fsName); } catch (e) { errs.push("saveAs(path): " + e.message); } }
    } else { errs.push("no saveAs() on " + __kind(d)); }
  }
  if (ok === false || (ok === null && errs.length)) { throw new Error("Save failed: " + errs.join("; ")); }
  return { saved: true, result: ok, path: path, document: __docInfo(__doc()) };`);
}

export const API_DUMP = wrap(`
  var out = { version: app.version, classes: [], errors: [] };
  function propDef(p) { return { name: p.name, type: p.type, dataType: p.dataType || "", help: p.help || "", description: p.description || "" }; }
  function methodDef(m) {
    var args = [];
    try { if (m.arguments) { for (var a = 0; a < m.arguments.length; a++) { args.push({ name: m.arguments[a].name, dataType: m.arguments[a].dataType || "" }); } } } catch (e) {}
    return { name: m.name, dataType: m.dataType || "", help: m.help || "", description: m.description || "", args: args };
  }
  try {
    var groups = $.dictionary.getGroups();
    var classes = $.dictionary.getClasses(groups[0] && groups[0].length ? groups[0] : "");
    for (var c = 0; c < classes.length; c++) {
      var name = String(classes[c]).split("\\t")[0];
      try {
        var ref = $.dictionary.getClass(name);
        if (!ref) { continue; }
        var def = { name: name, help: ref.help || "", description: ref.description || "", staticProperties: [], staticMethods: [], properties: [], methods: [] };
        var i;
        for (i = 0; i < ref.staticProperties.length; i++) { def.staticProperties.push(propDef(ref.staticProperties[i])); }
        for (i = 0; i < ref.staticMethods.length; i++) { def.staticMethods.push(methodDef(ref.staticMethods[i])); }
        for (i = 0; i < ref.properties.length; i++) { def.properties.push(propDef(ref.properties[i])); }
        for (i = 0; i < ref.methods.length; i++) { def.methods.push(methodDef(ref.methods[i])); }
        out.classes.push(def);
      } catch (e) { out.errors.push(name + ": " + e.message); }
    }
  } catch (e) { out.errors.push("dictionary: " + e.message); }
  return out;`);

export function registerAuditionTools(server: McpServer, bridge: AppBridge): void {
  const run = (script: string, opts?: { timeoutClass?: "fast" | "slow" | "render"; timeoutMs?: number }) =>
    guard(async () => jsonResult(await bridge.evaluate(script, opts)));

  server.registerTool(
    "au_app_state",
    {
      title: "Audition: application state",
      description: "Audition version, the open documents, and the active document (kind, sample rate, duration, playhead, every readable property).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(APP_STATE, { timeoutClass: "fast" }),
  );

  server.registerTool(
    "au_document_info",
    {
      title: "Audition: active document info",
      description: "Read the active Audition document: kind (WaveDocument / MultitrackDocument), name, sample rate, duration and playhead in seconds, plus every readable property.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(DOCUMENT_INFO, { timeoutClass: "fast" }),
  );

  server.registerTool(
    "au_list_commands",
    {
      title: "Audition: list menu commands",
      description:
        "List Audition's scriptable menu commands (every Application.COMMAND_* constant) with id and help text, optionally filtered " +
        "by a substring and annotated with whether each is enabled right now. Feed an id to au_invoke_command.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring of the id, constant name, or help text, e.g. 'normalize', 'Effects', 'Favorite'."),
        checkEnabled: z.boolean().optional().describe("Also report enabled/disabled for each (slower on the full list). Defaults to false."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filter, checkEnabled }) => run(listCommandsScript(filter, checkEnabled ?? false)),
  );

  server.registerTool(
    "au_invoke_command",
    {
      title: "Audition: run a menu command",
      description:
        "Run a menu command by id from au_list_commands (e.g. an Effects or Favorites command). Refuses commands that are disabled in the " +
        "current view unless force is set. Some commands open a dialog in Audition that the user must close.",
      inputSchema: {
        id: z.string().min(1).describe("Command id from au_list_commands."),
        force: z.boolean().optional().describe("Run even if Audition reports it disabled."),
      },
    },
    async ({ id, force }) => run(invokeCommandScript(id, force ?? false)),
  );

  server.registerTool(
    "au_set_playhead",
    {
      title: "Audition: move the playhead",
      description: "Move the active waveform document's playhead to a time in seconds.",
      inputSchema: { seconds: z.number().min(0) },
    },
    async ({ seconds }) => run(setPlayheadScript(seconds), { timeoutClass: "fast" }),
  );

  server.registerTool(
    "au_open_document",
    {
      title: "Audition: open an audio file or session",
      description: "Open an audio file (.wav, .mp3, …) or a .sesx multitrack session in Audition. It becomes the active document.",
      inputSchema: { path: z.string().min(1).describe("Absolute path.") },
    },
    async ({ path }) => run(openDocumentScript(path)),
  );

  server.registerTool(
    "au_save_document",
    {
      title: "Audition: save the active document",
      description: "Save the active document in place, or Save As to a path (format from the extension).",
      inputSchema: { path: z.string().min(1).optional().describe("Absolute path for Save As. Omit to save in place.") },
    },
    async ({ path }) => run(saveDocumentScript(path)),
  );

  server.registerTool(
    "au_api_dump",
    {
      title: "Audition: dump the scripting API",
      description:
        "Dump Audition's ExtendScript class dictionary (every class, property, method, and help text) to a JSON file and return a summary. " +
        "Use it to discover what this Audition build can do before scripting it.",
      inputSchema: { outputPath: z.string().min(1).describe("Absolute .json path to write.") },
      annotations: { readOnlyHint: true },
    },
    async ({ outputPath }) =>
      guard(async () => {
        const dump = (await bridge.evaluate(API_DUMP, { timeoutClass: "slow" })) as { version: string; classes: { name: string; properties: unknown[]; methods: unknown[]; staticProperties: unknown[]; staticMethods: unknown[] }[]; errors: string[] };
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, JSON.stringify(dump, null, 2));
        return jsonResult({
          outputPath,
          version: dump.version,
          classes: dump.classes.map((c) => ({ name: c.name, properties: c.properties.length, methods: c.methods.length, staticProperties: c.staticProperties.length, staticMethods: c.staticMethods.length })),
          errors: dump.errors,
        });
      }),
  );
}
