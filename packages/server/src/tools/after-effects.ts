import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsStringLiteral } from "../bridge/script-escape.js";
import type { AppBridge, JsonValue } from "../bridge/types.js";
import { log } from "../logging.js";
import { errorResult, guard, imageResult, jsonResult } from "./result.js";

/**
 * After Effects is ExtendScript-only (ES3): the scripts below deliberately use
 * `var`, avoid arrow functions, and build plain objects for the panel to
 * serialize (host.jsx's __acmEval turns the value into JSON). Do not
 * modernize them. Every mutation is wrapped in an undo group so one tool call
 * is one Ctrl-Z for the operator.
 *
 * Renders: `ae_render_frame` uses CompItem.saveFrameToPng on a temporary
 * downscaled comp; `ae_render_comp` saves the project and spawns aerender
 * (headless, never freezes the UI). Layers are addressed by comp id + layer
 * index (1-based, top of the timeline = 1), as After Effects does.
 */

const lit = jsStringLiteral;
const num = (n: number): string => String(n);
const opt = (v: string | undefined | null): string => (v === undefined || v === null ? "null" : lit(v));
const optNum = (v: number | undefined | null): string => (v === undefined || v === null ? "null" : num(v));
const rgb = (hex: string): string => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!;
  return `[${parseInt(m[1]!, 16) / 255}, ${parseInt(m[2]!, 16) / 255}, ${parseInt(m[3]!, 16) / 255}]`;
};

/** ES3 helpers prepended inside every script's IIFE. */
const HELPERS = `
  function __comp(id) {
    var item = app.project.itemByID(id);
    if (!item || !(item instanceof CompItem)) { throw new Error("No composition with id " + id + ". Call ae_list_compositions."); }
    return item;
  }
  function __layer(comp, index) {
    if (index < 1 || index > comp.numLayers) { throw new Error("Layer index " + index + " is out of range (1.." + comp.numLayers + ")."); }
    return comp.layer(index);
  }
  function __undo(name, fn) {
    app.beginUndoGroup(name);
    try { return fn(); } finally { app.endUndoGroup(); }
  }
  var __TRANSFORM = { position: "ADBE Position", scale: "ADBE Scale", rotation: "ADBE Rotate Z", opacity: "ADBE Opacity", anchorPoint: "ADBE Anchor Point" };
  function __prop(layer, name, path) {
    var p;
    if (path !== null) {
      p = layer;
      for (var i = 0; i < path.length; i++) { p = p.property(path[i]); if (!p) { throw new Error("Property path not found at " + path[i]); } }
      return p;
    }
    var mn = __TRANSFORM[name];
    if (!mn) { throw new Error("Unknown property " + name); }
    p = layer.property("ADBE Transform Group").property(mn);
    if (!p) { throw new Error("Layer has no " + name); }
    return p;
  }
  function __layerInfo(l) {
    // instanceof against the layer classes is unreliable in AE ExtendScript; matchName is not.
    var mn = l.matchName, kind;
    if (mn === "ADBE Text Layer") { kind = "text"; }
    else if (mn === "ADBE Camera Layer") { kind = "camera"; }
    else if (mn === "ADBE Light Layer") { kind = "light"; }
    else if (mn === "ADBE Vector Layer") { kind = "shape"; }
    else if (l.nullLayer) { kind = "null"; }
    else if (l.adjustmentLayer) { kind = "adjustment"; }
    else if (l.source && l.source instanceof CompItem) { kind = "precomp"; }
    else if (l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) { kind = "solid"; }
    else { kind = "footage"; }
    return { index: l.index, name: l.name, kind: kind, enabled: l.enabled, inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime, parentIndex: l.parent ? l.parent.index : null, sourceId: l.source ? l.source.id : null };
  }
  function __compInfo(c) {
    return { id: c.id, name: c.name, width: c.width, height: c.height, duration: c.duration, frameRate: c.frameRate, numLayers: c.numLayers, pixelAspect: c.pixelAspect };
  }
`;

const wrap = (body: string): string => `(function () {${HELPERS}${body}
})()`;

// ---- script builders (exported for tests) -----------------------------------

export const LIST_COMPOSITIONS = wrap(`
  var comps = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem) { comps.push(__compInfo(item)); }
  }
  return comps;`);

export const PROJECT_INFO = wrap(`
  var proj = app.project;
  return { path: proj.file ? proj.file.fsName : null, numItems: proj.numItems, bitsPerChannel: proj.bitsPerChannel, dirty: proj.dirty === true, version: app.version };`);

export const LIST_FOOTAGE = wrap(`
  var out = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    if (item instanceof FootageItem) {
      out.push({ id: item.id, name: item.name, path: item.file ? item.file.fsName : null, width: item.width, height: item.height, duration: item.duration, hasVideo: item.hasVideo, hasAudio: item.hasAudio, isSolid: item.mainSource instanceof SolidSource });
    }
  }
  return out;`);

export function getCompScript(compId: number): string {
  return wrap(`
  var c = __comp(${num(compId)});
  var layers = [];
  for (var i = 1; i <= c.numLayers; i++) { layers.push(__layerInfo(c.layer(i))); }
  var info = __compInfo(c); info.layers = layers; return info;`);
}

export function getLayerScript(compId: number, layerIndex: number): string {
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var info = __layerInfo(l);
  var t = l.property("ADBE Transform Group");
  var names = ["position", "scale", "rotation", "opacity", "anchorPoint"];
  info.transform = {};
  for (var i = 0; i < names.length; i++) {
    var p = t.property(__TRANSFORM[names[i]]);
    if (p) { info.transform[names[i]] = { value: p.value, numKeys: p.numKeys, expression: p.expressionEnabled ? p.expression : null }; }
  }
  var fx = l.property("ADBE Effect Parade"); info.effects = [];
  if (fx) { for (var j = 1; j <= fx.numProperties; j++) { var e = fx.property(j); info.effects.push({ index: j, name: e.name, matchName: e.matchName, enabled: e.enabled }); } }
  if (l.matchName === "ADBE Text Layer") { info.text = l.property("ADBE Text Properties").property("ADBE Text Document").value.text; }
  return info;`);
}

export function openProjectScript(path: string): string {
  return wrap(`
  var f = new File(${lit(path)});
  if (!f.exists) { throw new Error("No file at " + f.fsName); }
  var proj = app.open(f);
  return { path: proj.file ? proj.file.fsName : null, numItems: proj.numItems };`);
}

export function saveProjectScript(path: string | undefined): string {
  return wrap(`
  var path = ${opt(path)};
  if (path === null) {
    if (!app.project.file) { throw new Error("This project has never been saved — pass a path ending in .aep."); }
    app.project.save();
    return { path: app.project.file.fsName, saved: true };
  }
  var f = new File(path);
  app.project.save(f);
  return { path: f.fsName, saved: true };`);
}

export function importFootageScript(path: string): string {
  return wrap(`
  var f = new File(${lit(path)});
  if (!f.exists) { throw new Error("No file at " + f.fsName); }
  return __undo("Import footage", function () {
    var item = app.project.importFile(new ImportOptions(f));
    return { id: item.id, name: item.name, width: item.width, height: item.height, duration: item.duration, hasVideo: item.hasVideo, hasAudio: item.hasAudio };
  });`);
}

export interface CreateCompParams {
  name: string;
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  pixelAspect: number;
}

export function createCompScript(p: CreateCompParams): string {
  return wrap(`
  return __undo("Create comp", function () {
    var c = app.project.items.addComp(${lit(p.name)}, ${num(p.width)}, ${num(p.height)}, ${num(p.pixelAspect)}, ${num(p.duration)}, ${num(p.frameRate)});
    return __compInfo(c);
  });`);
}

export interface AddLayerParams {
  compId: number;
  kind: "footage" | "solid" | "text" | "null" | "adjustment";
  itemId?: number;
  color?: string;
  name?: string;
  text?: string;
  width?: number;
  height?: number;
}

export function addLayerScript(p: AddLayerParams): string {
  const color = p.color ? rgb(p.color) : "[1, 1, 1]";
  return wrap(`
  var c = __comp(${num(p.compId)});
  return __undo("Add layer", function () {
    var kind = ${lit(p.kind)}, l;
    if (kind === "footage") {
      var item = app.project.itemByID(${optNum(p.itemId)});
      if (!item || !(item instanceof AVItem)) { throw new Error("footage needs itemId of a footage item or comp (ae_list_footage / ae_list_compositions)."); }
      l = c.layers.add(item);
    } else if (kind === "solid" || kind === "adjustment") {
      l = c.layers.addSolid(${color}, ${opt(p.name) === "null" ? lit(p.kind === "adjustment" ? "Adjustment" : "Solid") : lit(p.name as string)}, ${optNum(p.width) === "null" ? "c.width" : num(p.width as number)}, ${optNum(p.height) === "null" ? "c.height" : num(p.height as number)}, 1.0);
      if (kind === "adjustment") { l.adjustmentLayer = true; }
    } else if (kind === "text") {
      l = c.layers.addText(${opt(p.text) === "null" ? '""' : lit(p.text as string)});
    } else {
      l = c.layers.addNull();
    }
    var name = ${opt(p.name)};
    if (name !== null) { l.name = name; }
    return __layerInfo(l);
  });`);
}

export interface LayerProps {
  name?: string;
  enabled?: boolean;
  inPoint?: number;
  outPoint?: number;
  startTime?: number;
  position?: number[];
  scale?: number[];
  rotation?: number;
  opacity?: number;
  anchorPoint?: number[];
  parentIndex?: number | null;
}

export function setLayerPropsScript(compId: number, layerIndex: number, p: LayerProps): string {
  const arr = (v: number[] | undefined): string => (v === undefined ? "null" : `[${v.map(num).join(", ")}]`);
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  return __undo("Set layer properties", function () {
    var v;
    v = ${opt(p.name)}; if (v !== null) { l.name = v; }
    v = ${p.enabled === undefined ? "null" : String(p.enabled)}; if (v !== null) { l.enabled = v; }
    v = ${optNum(p.startTime)}; if (v !== null) { l.startTime = v; }
    v = ${optNum(p.inPoint)}; if (v !== null) { l.inPoint = v; }
    v = ${optNum(p.outPoint)}; if (v !== null) { l.outPoint = v; }
    var t = l.property("ADBE Transform Group");
    v = ${arr(p.position)}; if (v !== null) { t.property("ADBE Position").setValue(v); }
    v = ${arr(p.scale)}; if (v !== null) { t.property("ADBE Scale").setValue(v); }
    v = ${optNum(p.rotation)}; if (v !== null) { t.property("ADBE Rotate Z").setValue(v); }
    v = ${optNum(p.opacity)}; if (v !== null) { t.property("ADBE Opacity").setValue(v); }
    v = ${arr(p.anchorPoint)}; if (v !== null) { t.property("ADBE Anchor Point").setValue(v); }
    ${p.parentIndex === undefined ? "" : p.parentIndex === null ? "l.parent = null;" : `l.parent = __layer(c, ${num(p.parentIndex)});`}
    return __layerInfo(l);
  });`);
}

export function duplicateLayerScript(compId: number, layerIndex: number, name: string | undefined): string {
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  return __undo("Duplicate layer", function () {
    var d = l.duplicate();
    var name = ${opt(name)}; if (name !== null) { d.name = name; }
    return __layerInfo(d);
  });`);
}

export function deleteLayerScript(compId: number, layerIndex: number): string {
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  return __undo("Delete layer", function () { var name = l.name; l.remove(); return { deleted: name }; });`);
}

export interface KeyframeParams {
  compId: number;
  layerIndex: number;
  property: string;
  propertyPath?: string[];
  keys: { time: number; value: number | number[]; easy?: boolean }[];
}

export function setKeyframesScript(p: KeyframeParams): string {
  const path = p.propertyPath ? `[${p.propertyPath.map(lit).join(", ")}]` : "null";
  const keys = p.keys
    .map((k) => `{ t: ${num(k.time)}, v: ${Array.isArray(k.value) ? `[${k.value.map(num).join(", ")}]` : num(k.value)}, e: ${k.easy ? "true" : "false"} }`)
    .join(", ");
  return wrap(`
  var c = __comp(${num(p.compId)}); var l = __layer(c, ${num(p.layerIndex)});
  var prop = __prop(l, ${lit(p.property)}, ${path});
  var keys = [${keys}];
  return __undo("Set keyframes", function () {
    for (var i = 0; i < keys.length; i++) {
      prop.setValueAtTime(keys[i].t, keys[i].v);
      if (keys[i].e) {
        var k = prop.nearestKeyIndex(keys[i].t);
        // Spatial properties (position, anchor point) take ONE ease; other
        // multi-dimensional properties (scale) take one per dimension.
        var dims = prop.isSpatial ? 1 : (prop.value instanceof Array ? prop.value.length : 1);
        var ease = []; for (var d = 0; d < dims; d++) { ease.push(new KeyframeEase(0, 33.3333)); }
        prop.setTemporalEaseAtKey(k, ease, ease);
      }
    }
    return { property: prop.name, numKeys: prop.numKeys };
  });`);
}

export function getKeyframesScript(compId: number, layerIndex: number, property: string, propertyPath: string[] | undefined): string {
  const path = propertyPath ? `[${propertyPath.map(lit).join(", ")}]` : "null";
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var prop = __prop(l, ${lit(property)}, ${path});
  var keys = [];
  for (var i = 1; i <= prop.numKeys; i++) { keys.push({ time: prop.keyTime(i), value: prop.keyValue(i) }); }
  return { property: prop.name, value: prop.value, numKeys: prop.numKeys, keys: keys, expression: prop.expressionEnabled ? prop.expression : null };`);
}

export function removeKeyframesScript(compId: number, layerIndex: number, property: string, propertyPath: string[] | undefined): string {
  const path = propertyPath ? `[${propertyPath.map(lit).join(", ")}]` : "null";
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var prop = __prop(l, ${lit(property)}, ${path});
  return __undo("Remove keyframes", function () {
    var n = prop.numKeys;
    while (prop.numKeys > 0) { prop.removeKey(1); }
    return { property: prop.name, removed: n };
  });`);
}

export function setExpressionScript(compId: number, layerIndex: number, property: string, propertyPath: string[] | undefined, expression: string | null): string {
  const path = propertyPath ? `[${propertyPath.map(lit).join(", ")}]` : "null";
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var prop = __prop(l, ${lit(property)}, ${path});
  return __undo("Set expression", function () {
    var e = ${opt(expression)};
    if (e === null) { prop.expression = ""; return { property: prop.name, expression: null }; }
    prop.expression = e;
    if (prop.expressionError) { throw new Error("Expression error: " + prop.expressionError); }
    return { property: prop.name, expression: prop.expression, enabled: prop.expressionEnabled };
  });`);
}

export function applyEffectScript(compId: number, layerIndex: number, matchName: string): string {
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  return __undo("Apply effect", function () {
    var fx = l.property("ADBE Effect Parade");
    if (!fx.canAddProperty(${lit(matchName)})) { throw new Error("Effect not available: " + ${lit(matchName)} + " (use a match name like 'ADBE Gaussian Blur 2' or a display name)."); }
    var e = fx.addProperty(${lit(matchName)});
    var params = [];
    for (var i = 1; i <= e.numProperties; i++) { var pp = e.property(i); params.push({ index: i, name: pp.name, matchName: pp.matchName }); }
    return { index: e.propertyIndex, name: e.name, matchName: e.matchName, params: params };
  });`);
}

export function setEffectParamScript(compId: number, layerIndex: number, effect: number | string, param: string, value: number | number[] | string): string {
  const v = typeof value === "string" ? lit(value) : Array.isArray(value) ? `[${value.map(num).join(", ")}]` : num(value);
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var fx = l.property("ADBE Effect Parade");
  var e = fx.property(${typeof effect === "number" ? num(effect) : lit(effect)});
  if (!e) { throw new Error("Effect not found on layer: " + ${typeof effect === "number" ? num(effect) : lit(effect)}); }
  var pp = e.property(${lit(param)});
  if (!pp) { throw new Error("Parameter not found: " + ${lit(param)}); }
  return __undo("Set effect parameter", function () { pp.setValue(${v}); return { effect: e.name, param: pp.name, value: pp.value }; });`);
}

export interface SetTextParams {
  compId: number;
  layerIndex: number;
  text?: string;
  fontSize?: number;
  font?: string;
  color?: string;
  justification?: "left" | "center" | "right";
}

export function setTextScript(p: SetTextParams): string {
  return wrap(`
  var c = __comp(${num(p.compId)}); var l = __layer(c, ${num(p.layerIndex)});
  if (l.matchName !== "ADBE Text Layer") { throw new Error("Layer " + l.index + " is not a text layer."); }
  return __undo("Set text", function () {
    var st = l.property("ADBE Text Properties").property("ADBE Text Document");
    var td = st.value;
    var v;
    v = ${opt(p.text)}; if (v !== null) { td.text = v; }
    v = ${optNum(p.fontSize)}; if (v !== null) { td.fontSize = v; }
    v = ${opt(p.font)}; if (v !== null) { td.font = v; }
    v = ${p.color ? rgb(p.color) : "null"}; if (v !== null) { td.applyFill = true; td.fillColor = v; }
    v = ${opt(p.justification)};
    if (v !== null) { td.justification = v === "center" ? ParagraphJustification.CENTER_JUSTIFY : v === "right" ? ParagraphJustification.RIGHT_JUSTIFY : ParagraphJustification.LEFT_JUSTIFY; }
    st.setValue(td);
    var info = __layerInfo(l); info.text = st.value.text; return info;
  });`);
}

export function addMarkerScript(compId: number, time: number, comment: string, layerIndex: number | undefined, duration: number | undefined): string {
  return wrap(`
  var c = __comp(${num(compId)});
  return __undo("Add marker", function () {
    var m = new MarkerValue(${lit(comment)});
    var dur = ${optNum(duration)}; if (dur !== null) { m.duration = dur; }
    var li = ${optNum(layerIndex)};
    var target = li === null ? c.markerProperty : __layer(c, li).property("ADBE Marker");
    target.setValueAtTime(${num(time)}, m);
    return { time: ${num(time)}, comment: ${lit(comment)}, on: li === null ? "comp" : "layer " + li };
  });`);
}

export function renderFrameScript(compId: number, time: number, path: string, maxDimension: number): string {
  return wrap(`
  var c = __comp(${num(compId)});
  var longest = Math.max(c.width, c.height);
  var s = longest > ${num(maxDimension)} ? ${num(maxDimension)} / longest : 1;
  var w = Math.max(4, Math.round(c.width * s)), h = Math.max(4, Math.round(c.height * s));
  var tmp = app.project.items.addComp("__acm_preview", w, h, c.pixelAspect, Math.max(c.duration, ${num(time)} + c.frameDuration), c.frameRate);
  try {
    var l = tmp.layers.add(c);
    l.property("ADBE Transform Group").property("ADBE Scale").setValue([s * 100, s * 100]);
    l.property("ADBE Transform Group").property("ADBE Position").setValue([w / 2, h / 2]);
    tmp.saveFrameToPng(${num(time)}, new File(${lit(path)}));
  } finally {
    tmp.remove();
  }
  return { path: ${lit(path)}, time: ${num(time)}, width: w, height: h, sourceWidth: c.width, sourceHeight: c.height };`);
}

export const AERENDER_INFO = wrap(`
  var proj = app.project;
  var appFolder = Folder.appPackage.fsName;
  return { projectPath: proj.file ? proj.file.fsName : null, dirty: proj.dirty === true, appFolder: appFolder, isWindows: $.os.indexOf("Windows") === 0 };`);

// ---- aerender (process lane) -------------------------------------------------

function aerenderExecutable(appFolder: string, isWindows: boolean): string {
  // Windows: <...>\Support Files\aerender.exe (appPackage IS "Support Files").
  // macOS: appPackage is the .app bundle's parent folder; aerender sits next to the app.
  return isWindows ? join(appFolder, "aerender.exe") : join(appFolder, "aerender");
}

/** saveFrameToPng returns before the file is fully written: wait for it to appear and stop growing. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    try {
      const { size } = await stat(path);
      if (size > 0 && size === lastSize) return;
      lastSize = size;
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`After Effects did not finish writing ${path} within ${Math.round(timeoutMs / 1000)}s. Is "Allow Scripts to Write Files and Access Network" enabled in Preferences > Scripting & Expressions?`);
}

function runAerender(exe: string, args: string[], timeoutMs: number): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const keep = (d: Buffer) => {
      out += d.toString();
      if (out.length > 8000) out = out.slice(-8000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`aerender did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, tail: out });
    });
  });
}

// ---- registration --------------------------------------------------------------

const compId = z.number().int().describe("Composition id from ae_list_compositions.");
const layerIndex = z.number().int().min(1).describe("Layer index in the comp (1 = top of the timeline), from ae_get_comp.");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex color like #ff8800").describe("Hex color like #ff8800.");
const propertyName = z
  .enum(["position", "scale", "rotation", "opacity", "anchorPoint"])
  .describe("Transform property. For anything else, give propertyPath instead.");
const propertyPath = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe("Optional explicit property path of match names or display names from the layer, e.g. [\"ADBE Effect Parade\", \"Gaussian Blur\", \"Blurriness\"]. Overrides `property`.");
const seconds = (what: string) => z.number().finite().nonnegative().describe(`${what}, in seconds.`);

export function registerAfterEffectsTools(server: McpServer, bridge: AppBridge): void {
  const run = (script: string, opts?: { timeoutClass?: "fast" | "slow" | "render"; timeoutMs?: number }) =>
    guard(async () => jsonResult(await bridge.evaluate(script, opts)));

  // ---- read ---------------------------------------------------------------
  server.registerTool(
    "ae_project_info",
    {
      title: "After Effects: project info",
      description: "Read the open After Effects project's file path, item count, bit depth, and unsaved-changes flag.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(PROJECT_INFO, { timeoutClass: "fast" }),
  );

  server.registerTool(
    "ae_list_compositions",
    {
      title: "After Effects: list compositions",
      description: "List every composition in the open project with its id, dimensions, duration, frame rate, and layer count.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(LIST_COMPOSITIONS, { timeoutClass: "fast" }),
  );

  server.registerTool(
    "ae_list_footage",
    {
      title: "After Effects: list footage items",
      description: "List imported footage and solids with ids (for ae_add_layer kind=footage), paths, size, and duration.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(LIST_FOOTAGE, { timeoutClass: "fast" }),
  );

  server.registerTool(
    "ae_get_comp",
    {
      title: "After Effects: comp details with layers",
      description: "A composition's settings and every layer (index, name, kind, in/out/start, parent). Layer indexes are what the layer tools take.",
      inputSchema: { compId },
      annotations: { readOnlyHint: true },
    },
    async ({ compId: id }) => run(getCompScript(id), { timeoutClass: "fast" }),
  );

  server.registerTool(
    "ae_get_layer",
    {
      title: "After Effects: layer details",
      description: "One layer's transform values (with keyframe counts and expressions), effects, and text content.",
      inputSchema: { compId, layerIndex },
      annotations: { readOnlyHint: true },
    },
    async ({ compId: id, layerIndex: li }) => run(getLayerScript(id, li), { timeoutClass: "fast" }),
  );

  // ---- project ------------------------------------------------------------
  server.registerTool(
    "ae_open_project",
    {
      title: "After Effects: open a project",
      description: "Open an .aep project file (closes the current project; After Effects may prompt to save it).",
      inputSchema: { path: z.string().min(1).describe("Absolute path to an .aep file.") },
      annotations: { destructiveHint: true },
    },
    async ({ path }) => run(openProjectScript(path)),
  );

  server.registerTool(
    "ae_save_project",
    {
      title: "After Effects: save the project",
      description: "Save the project. Pass a path to Save As (.aep; required the first time); omit it to save in place.",
      inputSchema: { path: z.string().min(1).optional().describe("Absolute path ending in .aep.") },
      annotations: { destructiveHint: true },
    },
    async ({ path }) => run(saveProjectScript(path)),
  );

  server.registerTool(
    "ae_import_footage",
    {
      title: "After Effects: import footage",
      description: "Import an image, video, audio, or PSD file into the project. Returns the footage item id for ae_add_layer.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to the media file.") },
    },
    async ({ path }) => run(importFootageScript(path)),
  );

  // ---- comps & layers -----------------------------------------------------
  server.registerTool(
    "ae_create_comp",
    {
      title: "After Effects: create a composition",
      description: "Create a new composition. Returns its id.",
      inputSchema: {
        name: z.string().min(1),
        width: z.number().int().positive().describe("Pixels."),
        height: z.number().int().positive().describe("Pixels."),
        frameRate: z.number().positive().optional().describe("Defaults to 30."),
        duration: z.number().positive().optional().describe("Seconds. Defaults to 10."),
        pixelAspect: z.number().positive().optional().describe("Defaults to 1."),
      },
    },
    async (p) => run(createCompScript({ ...p, frameRate: p.frameRate ?? 30, duration: p.duration ?? 10, pixelAspect: p.pixelAspect ?? 1 })),
  );

  server.registerTool(
    "ae_add_layer",
    {
      title: "After Effects: add a layer",
      description:
        "Add a layer to a comp: footage (needs itemId — a footage item or another comp), solid (color, optional size), " +
        "text (initial text), null, or adjustment. New layers go to the top. Returns the layer's index.",
      inputSchema: {
        compId,
        kind: z.enum(["footage", "solid", "text", "null", "adjustment"]),
        itemId: z.number().int().optional().describe("footage: id from ae_list_footage or ae_list_compositions."),
        color: hexColor.optional().describe("solid: fill color. Defaults to white."),
        name: z.string().min(1).optional(),
        text: z.string().optional().describe("text: initial content."),
        width: z.number().int().positive().optional().describe("solid: defaults to comp width."),
        height: z.number().int().positive().optional().describe("solid: defaults to comp height."),
      },
    },
    async (p) => run(addLayerScript(p)),
  );

  server.registerTool(
    "ae_set_layer_props",
    {
      title: "After Effects: set layer properties",
      description:
        "Set any of: name, enabled, startTime/inPoint/outPoint (seconds), position [x,y] or [x,y,z], scale [%,%], " +
        "rotation (degrees), opacity (0–100), anchorPoint, parentIndex (null to unparent). Only given fields change.",
      inputSchema: {
        compId,
        layerIndex,
        name: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        startTime: z.number().finite().optional(),
        inPoint: z.number().finite().optional(),
        outPoint: z.number().finite().optional(),
        position: z.array(z.number().finite()).min(2).max(3).optional(),
        scale: z.array(z.number().finite()).min(2).max(3).optional(),
        rotation: z.number().finite().optional(),
        opacity: z.number().min(0).max(100).optional(),
        anchorPoint: z.array(z.number().finite()).min(2).max(3).optional(),
        parentIndex: z.number().int().min(1).nullable().optional(),
      },
    },
    async ({ compId: id, layerIndex: li, ...props }) => run(setLayerPropsScript(id, li, props)),
  );

  server.registerTool(
    "ae_duplicate_layer",
    {
      title: "After Effects: duplicate a layer",
      description: "Duplicate a layer (the copy goes directly above it). Returns the copy's index.",
      inputSchema: { compId, layerIndex, name: z.string().min(1).optional() },
    },
    async ({ compId: id, layerIndex: li, name }) => run(duplicateLayerScript(id, li, name)),
  );

  server.registerTool(
    "ae_delete_layer",
    {
      title: "After Effects: delete a layer",
      description: "Remove a layer from a comp.",
      inputSchema: { compId, layerIndex },
      annotations: { destructiveHint: true },
    },
    async ({ compId: id, layerIndex: li }) => run(deleteLayerScript(id, li)),
  );

  // ---- animation ----------------------------------------------------------
  server.registerTool(
    "ae_set_keyframes",
    {
      title: "After Effects: set keyframes",
      description:
        "Add or replace keyframes on a layer property. Each key is {time, value, easy?}; value is a number (opacity, rotation) " +
        "or an array (position, scale, anchorPoint). easy applies Easy Ease. Use propertyPath for effect parameters.",
      inputSchema: {
        compId,
        layerIndex,
        property: propertyName,
        propertyPath,
        keys: z
          .array(z.object({ time: seconds("Key time"), value: z.union([z.number(), z.array(z.number())]), easy: z.boolean().optional() }))
          .min(1),
      },
    },
    async (p) => run(setKeyframesScript(p)),
  );

  server.registerTool(
    "ae_get_keyframes",
    {
      title: "After Effects: read a property's keyframes",
      description: "Current value, keyframes (time + value), and expression of a layer property.",
      inputSchema: { compId, layerIndex, property: propertyName, propertyPath },
      annotations: { readOnlyHint: true },
    },
    async ({ compId: id, layerIndex: li, property, propertyPath: pp }) => run(getKeyframesScript(id, li, property, pp), { timeoutClass: "fast" }),
  );

  server.registerTool(
    "ae_remove_keyframes",
    {
      title: "After Effects: remove all keyframes on a property",
      description: "Delete every keyframe on the property (the value freezes at its current value).",
      inputSchema: { compId, layerIndex, property: propertyName, propertyPath },
      annotations: { destructiveHint: true },
    },
    async ({ compId: id, layerIndex: li, property, propertyPath: pp }) => run(removeKeyframesScript(id, li, property, pp)),
  );

  server.registerTool(
    "ae_set_expression",
    {
      title: "After Effects: set an expression",
      description: "Set (or clear with null) the expression on a layer property. Fails with the error text if the expression does not compile.",
      inputSchema: { compId, layerIndex, property: propertyName, propertyPath, expression: z.string().nullable().describe("Expression source, or null to remove.") },
    },
    async ({ compId: id, layerIndex: li, property, propertyPath: pp, expression }) => run(setExpressionScript(id, li, property, pp, expression)),
  );

  // ---- effects, text, markers ---------------------------------------------
  server.registerTool(
    "ae_apply_effect",
    {
      title: "After Effects: apply an effect",
      description:
        "Add an effect to a layer by match name (e.g. 'ADBE Gaussian Blur 2', 'ADBE Drop Shadow', 'ADBE Glo2', 'ADBE Tint') " +
        "or display name. Returns the effect index and its parameter names for ae_set_effect_param.",
      inputSchema: { compId, layerIndex, matchName: z.string().min(1) },
    },
    async ({ compId: id, layerIndex: li, matchName }) => run(applyEffectScript(id, li, matchName)),
  );

  server.registerTool(
    "ae_set_effect_param",
    {
      title: "After Effects: set an effect parameter",
      description: "Set a parameter on an effect (by effect index or name) — number, array (color as [r,g,b] 0–1, point), or text.",
      inputSchema: {
        compId,
        layerIndex,
        effect: z.union([z.number().int().min(1), z.string().min(1)]).describe("Effect index (from ae_apply_effect / ae_get_layer) or name."),
        param: z.string().min(1).describe("Parameter display name or match name, e.g. 'Blurriness'."),
        value: z.union([z.number(), z.array(z.number()), z.string()]),
      },
    },
    async ({ compId: id, layerIndex: li, effect, param, value }) => run(setEffectParamScript(id, li, effect, param, value)),
  );

  server.registerTool(
    "ae_set_text",
    {
      title: "After Effects: set text layer content and style",
      description: "Change a text layer's text, font size, font (PostScript name), color, or justification.",
      inputSchema: {
        compId,
        layerIndex,
        text: z.string().optional(),
        fontSize: z.number().positive().optional(),
        font: z.string().min(1).optional().describe("PostScript font name, e.g. Arial-BoldMT."),
        color: hexColor.optional(),
        justification: z.enum(["left", "center", "right"]).optional(),
      },
    },
    async (p) => run(setTextScript(p)),
  );

  server.registerTool(
    "ae_add_marker",
    {
      title: "After Effects: add a marker",
      description: "Add a comp marker (or a layer marker if layerIndex is given) at a time with a comment.",
      inputSchema: { compId, time: seconds("Marker time"), comment: z.string(), layerIndex: layerIndex.optional(), duration: seconds("Marker duration").optional() },
    },
    async ({ compId: id, time, comment, layerIndex: li, duration }) => run(addMarkerScript(id, time, comment, li, duration)),
  );

  // ---- render -------------------------------------------------------------
  server.registerTool(
    "ae_render_frame",
    {
      title: "After Effects: render one frame as an image",
      description:
        "Render a single frame of a comp at a time (seconds) to a small PNG and return it as an image so you can see it. " +
        "Uses a temporary downscaled comp; the project is left as it was.",
      inputSchema: { compId, time: seconds("Frame time").optional(), maxDimension: z.number().int().min(64).max(2048).optional().describe("Longest edge in px. Defaults to 1024.") },
      annotations: { readOnlyHint: true },
    },
    async ({ compId: id, time, maxDimension }) =>
      guard(async () => {
        const dir = join(tmpdir(), "adobe-cc-mcp", "previews");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${randomUUID()}.png`).replace(/\\/g, "/");
        await bridge.evaluate(renderFrameScript(id, time ?? 0, path, maxDimension ?? 1024), { timeoutClass: "slow" });
        await waitForFile(path, 20_000);
        return imageResult(path, "image/png", `Frame at ${time ?? 0}s`);
      }),
  );

  server.registerTool(
    "ae_queue_render",
    {
      title: "After Effects: add a composition to the render queue",
      description: "Add a comp to the render queue with an output path (and optional output-module template). Queues only; ae_render_comp renders headlessly.",
      inputSchema: {
        compName: z.string().min(1).describe("Exact name of the composition to queue."),
        outputPath: z.string().min(1).describe("Absolute output file path."),
        templateName: z.string().min(1).optional().describe("Output module template, e.g. 'H.264 - Match Render Settings'."),
      },
    },
    async ({ compName, outputPath, templateName }) =>
      run(
        wrap(`
  var target = null;
  for (var i = 1; i <= app.project.numItems; i++) { var item = app.project.item(i); if (item instanceof CompItem && item.name === ${lit(compName)}) { target = item; break; } }
  if (target === null) { throw new Error("No composition named " + ${lit(compName)}); }
  return __undo("Queue render", function () {
    var rqItem = app.project.renderQueue.items.add(target);
    var output = rqItem.outputModule(1);
    var template = ${opt(templateName)};
    if (template !== null) { output.applyTemplate(template); }
    output.file = new File(${lit(outputPath)});
    return { queueIndex: app.project.renderQueue.numItems, compName: target.name, outputPath: output.file.fsName, status: "queued" };
  });`),
      ),
  );

  server.registerTool(
    "ae_render_comp",
    {
      title: "After Effects: render a comp headlessly (aerender)",
      description:
        "Save the project, then render a comp with aerender in the background (the After Effects UI stays free). " +
        "Waits for it to finish (up to 30 minutes) and returns the output path. The project must have been saved once (ae_save_project).",
      inputSchema: {
        compName: z.string().min(1).describe("Exact composition name."),
        outputPath: z.string().min(1).describe("Absolute output path, e.g. C:/renders/comp.mp4 or .mov; aerender picks the format from the output module."),
        outputModule: z.string().min(1).optional().describe("Output module template name, e.g. 'H.264 - Match Render Settings' or 'Lossless'."),
        renderSettings: z.string().min(1).optional().describe("Render settings template, e.g. 'Best Settings'."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ compName, outputPath, outputModule, renderSettings }) =>
      guard(async () => {
        const info = (await bridge.evaluate(saveProjectScript(undefined), { timeoutClass: "slow" })) as { path?: string };
        const meta = (await bridge.evaluate(AERENDER_INFO, { timeoutClass: "fast" })) as { projectPath: string | null; appFolder: string; isWindows: boolean };
        if (!info.path || !meta.projectPath) return errorResult("Project has no file. Save it first with ae_save_project.");
        const exe = aerenderExecutable(meta.appFolder, meta.isWindows);
        try {
          await stat(exe);
        } catch {
          return errorResult(`aerender not found at ${exe}`);
        }
        const args = ["-project", meta.projectPath, "-comp", compName, "-output", outputPath];
        if (outputModule) args.push("-OMtemplate", outputModule);
        if (renderSettings) args.push("-RStemplate", renderSettings);
        log.info(`aerender ${args.join(" ")}`);
        const { code, tail } = await runAerender(exe, args, 30 * 60_000);
        if (code !== 0) return errorResult(`aerender exited with ${code}:\n${tail.slice(-1500)}`);
        return jsonResult({ outputPath, compName, log: tail.slice(-600) } as JsonValue);
      }),
  );
}
