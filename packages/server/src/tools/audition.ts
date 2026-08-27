import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsStringLiteral } from "../bridge/script-escape.js";
import type { AppBridge } from "../bridge/types.js";
import { guard, jsonResult } from "./result.js";

/**
 * Audition is driven through the CEP panel's `eval` command (ExtendScript,
 * ES3). Its DOM is small and undocumented; the surface used here comes from a
 * live dump of Audition 26.3 (`docs/api-dumps/audition-26.3.json`, made by
 * `au_api_dump`):
 *
 *   app.openDocument(new DocumentOpenParameter(path)) → Document
 *   app.invokeCommand(id) / isCommandEnabled(id) — 612 Application.COMMAND_* ids
 *   app.transport.play() / stop() / pause() / record(), .isPlaying, .loop
 *   WaveDocument: sampleRate, duration (samples), playheadPosition (samples),
 *     audioFormat {sampleRate, bitDepth, channelLayout}, markers[],
 *     saveAs(path, export), saveDocument(null), closeDocument(),
 *     applyFavorite(name), addMarker(start, duration, name, type, description)
 *   MultitrackDocument: audioTracks (audioClipTracks[i].audioClips[j].startTime…),
 *     saveAsDocument / exportDocument, addMarker
 *
 * Deterministic audio work (loudness, convert, trim, denoise, mix) lives in
 * the ffmpeg lane (`audio_*`), not here.
 *
 * Rules: var only, no arrow functions, one IIFE per script.
 */

const HELPERS = `
  function __doc() { var d = app.activeDocument; if (!d) { throw new Error("No document is open in Audition. Open one (au_open_document) or create one in the app."); } return d; }
  function __kind(o) { try { return o.reflect.name; } catch (e) { return typeof o; } }
  function __isWave(d) { return __kind(d) === "WaveDocument"; }
  function __isMulti(d) { return __kind(d) === "MultitrackDocument"; }
  function __sec(d, samples) { var sr = d.sampleRate; return sr && typeof samples === "number" ? samples / sr : null; }
  function __fmt(f) {
    if (!f) { return null; }
    var out = {};
    try { out.sampleRate = f.sampleRate; } catch (e) {}
    try { out.bitDepth = f.bitDepth; } catch (e) {}
    try { var cl = f.channelLayout; out.channels = cl ? cl.length : null; out.channelLayout = cl ? cl.description : null; } catch (e) {}
    return out;
  }
  function __marker(d, m) {
    var o = {};
    try { o.name = m.name; } catch (e) {}
    try { o.type = m.type; } catch (e) {}
    try { o.description = m.description; } catch (e) {}
    try { o.startSeconds = __sec(d, m.start); } catch (e) {}
    try { o.durationSeconds = __sec(d, m.duration); } catch (e) {}
    return o;
  }
  function __markers(d) {
    var out = [];
    try { var ms = d.markers; for (var i = 0; i < ms.length; i++) { out.push(__marker(d, ms[i])); } } catch (e) {}
    return out;
  }
  function __tracks(d) {
    var out = [];
    try {
      var ts = d.audioTracks.audioClipTracks;
      for (var i = 0; i < ts.length; i++) {
        var t = ts[i];
        var clips = [];
        try {
          var cs = t.audioClips;
          for (var j = 0; j < cs.length; j++) {
            var c = cs[j];
            clips.push({ index: j, name: c.name, startSeconds: __sec(d, c.startTime), durationSeconds: __sec(d, c.duration), endSeconds: __sec(d, c.startTime + c.duration), selected: c.selected });
          }
        } catch (e) {}
        out.push({ index: i, name: t.name, mute: t.mute, solo: t.solo, armed: t.armed, clips: clips });
      }
    } catch (e) {}
    return out;
  }
  function __docInfo(d) {
    var wave = __isWave(d), multi = __isMulti(d);
    var info = { kind: __kind(d), name: d.displayName, path: null, dirty: null, sampleRate: null, durationSeconds: null, playheadSeconds: null };
    try { info.path = d.path || null; } catch (e) {}
    try { info.dirty = d.dirty; } catch (e) {}
    try { info.sampleRate = d.sampleRate || null; } catch (e) {}
    try { info.durationSeconds = __sec(d, d.duration); } catch (e) {}
    try { info.playheadSeconds = __sec(d, d.playheadPosition); } catch (e) {}
    if (wave) {
      try { info.audioFormat = __fmt(d.audioFormat); } catch (e) {}
      try { info.fileFormat = d.fileFormat ? { id: d.fileFormat.id, title: d.fileFormat.title } : null; } catch (e) {}
      try { info.exists = d.exists; } catch (e) {}
    }
    if (multi) { info.tracks = __tracks(d); }
    info.markers = __markers(d);
    return info;
  }
  function __docs() {
    var out = [];
    try { var ds = app.documents; for (var i = 0; i < ds.length; i++) { out.push({ index: i, kind: __kind(ds[i]), name: ds[i].displayName, path: ds[i].path || null }); } } catch (e) {}
    return out;
  }
  function __transport() {
    var t = app.transport, o = {};
    try { o.isPlaying = t.isPlaying; o.isPaused = t.isPaused; o.isRecording = t.isRecording; o.loop = t.loop; o.isPlayEnabled = t.isPlayEnabled; } catch (e) {}
    return o;
  }
`;

const wrap = (body: string) => `(function () {${HELPERS}${body}\n})()`;

export const APP_STATE = wrap(`
  var d = app.activeDocument;
  return { version: app.version, build: app.buildNumber || null, documents: __docs(), activeDocument: d ? __docInfo(d) : null, transport: __transport() };`);

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
  var ok = app.invokeCommand(id);
  return { invoked: id, result: ok, wasEnabled: enabled };`);
}

export function setPlayheadScript(seconds: number): string {
  return wrap(`
  var d = __doc();
  if (!d.sampleRate) { throw new Error("The active document has no sample rate."); }
  d.playheadPosition = Math.round(${seconds} * d.sampleRate);
  return { playheadSeconds: __sec(d, d.playheadPosition) };`);
}

export function openDocumentScript(path: string): string {
  return wrap(`
  var f = new File(${jsStringLiteral(path)});
  if (!f.exists) { throw new Error("File not found: " + f.fsName); }
  var d = app.openDocument(new DocumentOpenParameter(f.fsName));
  if (!d) { d = app.activeDocument; }
  if (!d) { throw new Error("Audition did not open " + f.fsName); }
  return __docInfo(d);`);
}

export function saveDocumentScript(path: string | undefined, asExport: boolean): string {
  return wrap(`
  var d = __doc();
  var path = ${path === undefined ? "null" : jsStringLiteral(path)};
  var ok;
  if (path === null) {
    if (__isWave(d)) { ok = d.saveDocument(null); }
    else if (__isMulti(d)) { ok = d.saveDocument(new MultitrackSaveParameter()); }
    else { throw new Error("Cannot save a " + __kind(d)); }
  } else {
    var f = new File(path);
    if (__isWave(d)) { ok = d.saveAs(f.fsName, ${asExport ? "true" : "false"}); }
    else if (__isMulti(d)) { ok = ${asExport ? "d.exportDocument(f.fsName, new MultitrackExportParameter(false, false, null))" : "d.saveAsDocument(f.fsName, new MultitrackSaveAsParameter(false, true))"}; }
    else { throw new Error("Cannot save a " + __kind(d)); }
  }
  if (ok === false) { throw new Error("Audition refused to save" + (path !== null ? " to " + path : "") + " (check the folder exists and the extension is a supported format)."); }
  return { saved: true, exported: ${asExport ? "true" : "false"}, path: path, document: __docInfo(app.activeDocument || d) };`);
}

export function closeDocumentScript(): string {
  return wrap(`
  var d = __doc();
  var name = d.displayName;
  var ok = d.closeDocument();
  return { closed: name, result: ok, documents: __docs() };`);
}

export function applyFavoriteScript(name: string): string {
  return wrap(`
  var d = __doc();
  if (!__isWave(d)) { throw new Error("Favorites apply to waveform documents; the active document is a " + __kind(d) + "."); }
  var ok = d.applyFavorite(${jsStringLiteral(name)});
  if (ok === false) { throw new Error("Audition could not apply the favorite " + ${jsStringLiteral(name)} + " (check the exact name in the Favorites panel)."); }
  return { applied: ${jsStringLiteral(name)}, result: ok, document: __docInfo(d) };`);
}

export function addMarkerScript(seconds: number, durationSeconds: number, name: string, type: string, description: string): string {
  return wrap(`
  var d = __doc();
  if (!d.sampleRate) { throw new Error("The active document has no sample rate."); }
  var ok = d.addMarker(Math.round(${seconds} * d.sampleRate), Math.round(${durationSeconds} * d.sampleRate), ${jsStringLiteral(name)}, ${jsStringLiteral(type)}, ${jsStringLiteral(description)});
  if (ok === false) { throw new Error("Audition refused the marker."); }
  return { markers: __markers(d) };`);
}

export function transportScript(action: "play" | "stop" | "pause" | "record" | "state", loop: boolean | undefined): string {
  return wrap(`
  var t = app.transport;
  ${loop === undefined ? "" : `t.loop = ${loop ? "true" : "false"};`}
  var ok = null;
  ${action === "state" ? "" : `ok = t.${action}();`}
  var s = __transport(); s.action = ${jsStringLiteral(action)}; s.result = ok;
  try { s.playheadSeconds = __sec(app.activeDocument, app.activeDocument.playheadPosition); } catch (e) {}
  return s;`);
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
      description: "Audition version, every open document, the active document in full (see au_document_info), and the transport state.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(APP_STATE, { timeoutClass: "fast" }),
  );

  server.registerTool(
    "au_document_info",
    {
      title: "Audition: active document info",
      description:
        "Read the active document: kind (WaveDocument / MultitrackDocument), name, path, sample rate, duration and playhead in seconds, " +
        "audio format, markers, and for a multitrack session every track with its clips.",
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
        "List Audition's scriptable menu commands (every Application.COMMAND_* constant, 600+) with id and help text, optionally filtered " +
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
        "Run a menu command by id from au_list_commands (Effects, Edit, View, Multitrack…). Refuses commands that are disabled in the " +
        "current view unless force is set. Many Effects commands open their dialog in Audition; for hands-off processing use au_apply_favorite or the audio_* tools.",
      inputSchema: {
        id: z.string().min(1).describe("Command id from au_list_commands, e.g. 'Effects.Normalize'."),
        force: z.boolean().optional().describe("Run even if Audition reports it disabled."),
      },
    },
    async ({ id, force }) => run(invokeCommandScript(id, force ?? false)),
  );

  server.registerTool(
    "au_apply_favorite",
    {
      title: "Audition: apply a Favorite",
      description:
        "Apply a saved Favorite (a recorded effect chain from Audition's Favorites panel) to the active waveform document, without dialogs. " +
        "Built-in examples: 'Normalize to -0.1 dB', 'Fade In', 'Fade Out', 'Remove 60 Hz Hum', 'Vocal Enhancer'.",
      inputSchema: { name: z.string().min(1).describe("Exact Favorite name as shown in the Favorites panel.") },
    },
    async ({ name }) => run(applyFavoriteScript(name), { timeoutClass: "render", timeoutMs: 10 * 60_000 }),
  );

  server.registerTool(
    "au_set_playhead",
    {
      title: "Audition: move the playhead",
      description: "Move the active document's playhead to a time in seconds.",
      inputSchema: { seconds: z.number().min(0) },
    },
    async ({ seconds }) => run(setPlayheadScript(seconds), { timeoutClass: "fast" }),
  );

  server.registerTool(
    "au_transport",
    {
      title: "Audition: transport",
      description: "Play, stop, pause, or record the active document, or just read the transport state. Optionally set loop playback.",
      inputSchema: {
        action: z.enum(["play", "stop", "pause", "record", "state"]).optional().describe("Defaults to state."),
        loop: z.boolean().optional(),
      },
    },
    async ({ action, loop }) => run(transportScript(action ?? "state", loop), { timeoutClass: "fast" }),
  );

  server.registerTool(
    "au_add_marker",
    {
      title: "Audition: add a marker",
      description: "Add a marker (cue or range) to the active document at a time in seconds.",
      inputSchema: {
        seconds: z.number().min(0),
        durationSeconds: z.number().min(0).optional().describe("0 (default) makes a cue point; more makes a range."),
        name: z.string(),
        type: z.string().optional().describe("Marker type as Audition names it. Defaults to 'Cue'."),
        description: z.string().optional(),
      },
    },
    async (a) => run(addMarkerScript(a.seconds, a.durationSeconds ?? 0, a.name, a.type ?? "Cue", a.description ?? "")),
  );

  server.registerTool(
    "au_open_document",
    {
      title: "Audition: open an audio file or session",
      description: "Open an audio file (.wav, .mp3, .flac, …) or a .sesx multitrack session in Audition. It becomes the active document.",
      inputSchema: { path: z.string().min(1).describe("Absolute path.") },
    },
    async ({ path }) => run(openDocumentScript(path)),
  );

  server.registerTool(
    "au_save_document",
    {
      title: "Audition: save / export the active document",
      description:
        "Save the active document in place, or Save As to a path (format from the extension: .wav, .mp3, .flac, .aif, .sesx for sessions). " +
        "export=true writes the file but keeps the document pointing at its original file (a waveform 'Export'; for a session, a mixdown export).",
      inputSchema: {
        path: z.string().min(1).optional().describe("Absolute path for Save As / Export. Omit to save in place."),
        export: z.boolean().optional().describe("Export a copy instead of re-pointing the document. Defaults to false."),
      },
    },
    async ({ path, export: asExport }) => run(saveDocumentScript(path, asExport ?? false), { timeoutClass: "render", timeoutMs: 10 * 60_000 }),
  );

  server.registerTool(
    "au_close_document",
    {
      title: "Audition: close the active document",
      description: "Close the active document. Audition may ask about unsaved changes; save first with au_save_document to avoid the prompt.",
      inputSchema: {},
    },
    async () => run(closeDocumentScript()),
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
