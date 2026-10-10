import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsStringLiteral } from "../bridge/script-escape.js";
import { EvalTimeoutError, ScriptError, type AppBridge, type EvalOptions, type JsonValue } from "../bridge/types.js";
import type { JobRegistry } from "../jobs.js";
import { log } from "../logging.js";
import { currentToolCall, withToolContext } from "./call-context.js";
import { echoArgs, excerptLine } from "./echo.js";
import { runOrQueue, waitParam, type ProgressExtra } from "./jobs.js";
import { lineCount } from "./raw-script.js";
import { guard, imageResult, jsonResult } from "./result.js";
import { closestNames, fold, rank, stripAeVendor, suggestionThreshold } from "./suggest.js";

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

/**
 * ES3 helpers prepended inside every script's IIFE (after the host-line guard, see AE_PRELUDE).
 *
 * String.raw, so the ES3 source is exactly what is typed here (`"\\"` is one backslash in ES3,
 * `\u2014` an em dash). Style rules the helper map (aeHelperRanges) relies on, checked when this
 * module loads: every helper is a top-level `  function __name(` (two-space indent) closed by a
 * line that is exactly `  }`; no one-line helpers and no nested function declarations; pure ASCII
 * (write an em dash as \u2014). Also: no backtick or dollar-brace; no ES6 words (not even in
 * messages or comments); no ES5 array or string methods; no else-if chain whose condition reads a
 * host object (After Effects' line attribution there is unverified).
 *
 * Every lookup failure says what happened, lists what exists (cut by count and by length, so the
 * "what to do next" clause after the dash always survives the server's cap) and what to do next.
 */
const HELPERS = String.raw`
  // Length budgets (UTF-16 units) for candidate lists, so every message stays far below the
  // server's 1500-character cap and keeps its "what to do next" clause.
  var __BUDGET = 600;
  var __PATH_BUDGET = 300;
  // How many children a miss reads to find the names that repeat, listed or not.
  var __SCAN = 200;
  // A name as a message quotes it: quote and backslash escaped; every control character (C0, DEL,
  // C1) and the line and paragraph separators a space; cut at 60 with "...".
  function __q(s) {
    var t = String(s), out = "", i, c;
    for (i = 0; i < t.length && i < 60; i++) {
      c = t.charCodeAt(i);
      if (c === 34 || c === 92) { out += "\\" + t.charAt(i); }
      else if (c < 32 || (c > 126 && c < 160) || c === 8232 || c === 8233) { out += " "; }
      else { out += t.charAt(i); }
    }
    if (t.length > 60) { out += "..."; }
    return "\"" + out + "\"";
  }
  function __list(names, total, budget) {
    var out = "", shown = 0, i, s;
    for (i = 0; i < names.length; i++) {
      s = __q(names[i]);
      if (shown > 0 && out.length + 2 + s.length > budget) { break; }
      out += (shown > 0 ? ", " : "") + s;
      shown++;
    }
    return "[" + out + "]" + (total > shown ? " (+" + (total - shown) + " more)" : "");
  }
  function __kind(l) {
    // instanceof against the layer classes is unreliable in AE ExtendScript; matchName is not.
    var mn = l.matchName;
    if (mn === "ADBE Text Layer") { return "text"; }
    if (mn === "ADBE Camera Layer") { return "camera"; }
    if (mn === "ADBE Light Layer") { return "light"; }
    if (mn === "ADBE Vector Layer") { return "shape"; }
    if (l.nullLayer) { return "null"; }
    if (l.adjustmentLayer) { return "adjustment"; }
    if (l.source && l.source instanceof CompItem) { return "precomp"; }
    if (l.source && l.source.mainSource && l.source.mainSource instanceof SolidSource) { return "solid"; }
    return "footage";
  }
  function __layerLabel(l) {
    // Only ever part of a message: a read that fails never replaces the failure being reported.
    var n = "?", s = "(unreadable)", k = "unknown kind";
    try { n = String(l.index); } catch (e) {}
    try { s = __q(l.name); } catch (e) {}
    try { k = __kind(l); } catch (e) {}
    return n + " " + s + " (" + k + ")";
  }
  function __layerList(comp, max) {
    var out = "", shown = 0, i, s;
    for (i = 1; i <= comp.numLayers && i <= max; i++) {
      try { s = __layerLabel(comp.layer(i)); } catch (e) { s = i + " (unreadable)"; }
      if (shown > 0 && out.length + 2 + s.length > __BUDGET) { break; }
      out += (shown > 0 ? ", " : "") + s;
      shown++;
    }
    return out + (comp.numLayers > shown ? " ... and " + (comp.numLayers - shown) + " more" : "");
  }
  function __compList(max) {
    // "" when the project has no compositions: callers then say how to make one.
    var out = "", shown = 0, n = 0, full = false, i, it, s;
    for (i = 1; i <= app.project.numItems; i++) {
      it = app.project.item(i);
      if (it instanceof CompItem) {
        n++;
        if (!full) {
          try { s = it.id + " " + __q(it.name); } catch (e) { s = String(it.id); }
          if (shown >= max || (shown > 0 && out.length + 2 + s.length > __BUDGET)) { full = true; }
          else { out += (shown > 0 ? ", " : "") + s; shown++; }
        }
      }
    }
    if (n === 0) { return ""; }
    return "the project has " + n + ": " + out + (n > shown ? " ... and " + (n - shown) + " more" : "");
  }
  function __comp(id) {
    var item = null, list, what;
    // itemByID throws (it does not return null) for an id no item has; verified live on 26.3.
    try { item = app.project.itemByID(id); } catch (e) { item = null; }
    if (item && item instanceof CompItem) { return item; }
    list = __compList(20);
    if (!item) {
      if (list === "") { throw new Error("No composition with id " + id + "; the project has no compositions \u2014 create one with ae_create_comp and pass its id."); }
      throw new Error("No composition with id " + id + "; " + list + " \u2014 pass one of these compIds (ae_list_compositions lists them all).");
    }
    what = "Item " + id + " " + __q(item.name) + " is " + (item instanceof FolderItem ? "a folder" : "a footage item") + ", not a composition";
    if (list === "") { throw new Error(what + ", and the project has no compositions \u2014 create one with ae_create_comp and pass its id."); }
    throw new Error(what + "; " + list + " \u2014 pass one of these compIds (ae_list_compositions lists them all).");
  }
  function __layer(comp, index, role) {
    if (index >= 1 && index <= comp.numLayers) { return comp.layer(index); }
    var what = (role ? role + " layer" : "Layer") + " index " + index + " is out of range";
    if (comp.numLayers === 0) { throw new Error(what + ": " + __q(comp.name) + " (id " + comp.id + ") has no layers \u2014 add one first (ae_add_layer)."); }
    throw new Error(what + " (1.." + comp.numLayers + ") in " + __q(comp.name) + " (id " + comp.id + "): " + __layerList(comp, 20) + " \u2014 pass one of these indexes (ae_get_comp lists every layer).");
  }
  function __undo(name, fn) {
    app.beginUndoGroup(name);
    try { return fn(); } finally { app.endUndoGroup(); }
  }
  var __TRANSFORM = { position: "ADBE Position", scale: "ADBE Scale", rotation: "ADBE Rotate Z", opacity: "ADBE Opacity", anchorPoint: "ADBE Anchor Point" };
  // Top-level groups that exist on one kind of layer only: a miss there is explained by the kind.
  var __KIND_ROOTS = { "ADBE Text Properties": "text", "ADBE Root Vectors Group": "shape", "ADBE Camera Options Group": "camera", "ADBE Light Options Group": "light" };
  // Groups whose children the user names, or whose children all share one match name (every shape
  // group is "ADBE Vector Group", every mask "ADBE Mask Atom"): listed by name whatever the caller passed.
  var __BY_NAME = { "ADBE Effect Parade": true, "ADBE Mask Parade": true, "ADBE Root Vectors Group": true, "ADBE Vectors Group": true, "ADBE Text Animators": true, "ADBE Text Selectors": true };
  function __named(g) {
    // In the fixed set, or an indexed group: the user names (and can rename) its children.
    var mn = "", indexed = false;
    try { mn = String(g.matchName); } catch (e) { mn = ""; }
    if (Object.prototype.hasOwnProperty.call(__BY_NAME, mn)) { return true; }
    try { indexed = g.propertyType === PropertyType.INDEXED_GROUP; } catch (e) { indexed = false; }
    return indexed;
  }
  function __byName(g, segment) {
    if (__named(g)) { return true; }
    // Otherwise answer in the caller's vocabulary: a match-name segment gets match names.
    return String(segment).substring(0, 5) !== "ADBE ";
  }
  function __kids(g, max, byName, budget) {
    // Lists up to max names. Repeats are looked for among every child (up to __SCAN), listed or
    // not, and named after the list ("; repeated: [...]"): the server reads that list and never
    // suggests a name in it.
    var names = [], rep = [], seen = {}, n = 0, i, s, key, text;
    try { n = g.numProperties; } catch (e) { n = 0; }
    if (!(n > 0)) { n = 0; }
    for (i = 1; i <= n && i <= __SCAN; i++) {
      s = null;
      try { s = String(byName ? g.property(i).name : g.property(i).matchName); } catch (e) { s = null; }
      if (s !== null) {
        key = "#" + s;
        if (!Object.prototype.hasOwnProperty.call(seen, key)) { seen[key] = 1; }
        else if (seen[key] === 1) { seen[key] = 2; rep.push(s); }
        if (names.length < max) { names.push(s); }
      }
    }
    text = __list(names, n, budget ? budget : __BUDGET);
    if (rep.length > 0) { text += "; repeated: " + __list(rep, rep.length, __PATH_BUDGET); }
    return { n: n, dup: rep.length > 0, rep: rep, byName: byName, text: text };
  }
  function __repMatch(g, rep) {
    // Each repeated name with the match name of every child that has it, in order:
    // "Source": ["ADBE X-0004", "ADBE X-0008"]; "Offset": [...]
    var at = {}, n = 0, out = "", shown = 0, i, c, key, s;
    for (i = 0; i < rep.length; i++) { at["#" + rep[i]] = []; }
    try { n = g.numProperties; } catch (e) { n = 0; }
    if (!(n > 0)) { n = 0; }
    for (i = 1; i <= n && i <= __SCAN; i++) {
      try {
        c = g.property(i);
        key = "#" + String(c.name);
        if (Object.prototype.hasOwnProperty.call(at, key)) { at[key].push(String(c.matchName)); }
      } catch (e) {}
    }
    for (i = 0; i < rep.length; i++) {
      key = "#" + rep[i];
      s = __q(rep[i]) + ": " + __list(at[key], at[key].length, __PATH_BUDGET);
      if (shown > 0 && out.length + 2 + s.length > __BUDGET) { break; }
      out += (shown > 0 ? "; " : "") + s;
      shown++;
    }
    return out + (rep.length > shown ? " (+" + (rep.length - shown) + " more)" : "");
  }
  function __pick(k, g) {
    // Repeated names (named after the list): the user can rename what __named covers; elsewhere
    // each repeated name's match names tell its copies apart.
    if (!k.dup) { return " \u2014 use one of these names."; }
    if (__named(g)) { return " \u2014 a path cannot tell repeated names apart; rename them in After Effects so each is unique, then pass one."; }
    if (!k.byName) { return " \u2014 a repeated name reaches only the first of them; use one of these names."; }
    return " \u2014 a repeated name reaches only the first of them; pass the match name instead (by match name: " + __repMatch(g, k.rep) + ").";
  }
  function __isLeaf(p) {
    try { return p.propertyType === PropertyType.PROPERTY; } catch (e) { return false; }
  }
  function __isGroup(p) {
    try { return typeof p.numProperties === "number"; } catch (e) { return false; }
  }
  function __pathHead(l) {
    return "Property path not found on layer " + __layerLabel(l) + ": ";
  }
  function __prop(layer, name, path) {
    var p, q, i, only, kind, at, mn, k, pmn, under;
    if (path !== null) {
      p = layer;
      // __pathHead reads the layer's name and kind, so it is built only for a miss.
      for (i = 0; i < path.length; i++) {
        if (i > 0 && __isLeaf(p)) { throw new Error(__pathHead(layer) + __q(path[i - 1]) + " is a property, not a group, so nothing named " + __q(path[i]) + " is under it \u2014 end the path at " + __q(path[i - 1]) + "."); }
        q = null;
        try { q = p.property(path[i]); } catch (e) { q = null; }
        if (!q) {
          only = (i === 0 && Object.prototype.hasOwnProperty.call(__KIND_ROOTS, path[0])) ? __KIND_ROOTS[path[0]] : null;
          if (only !== null) {
            kind = null;
            try { kind = __kind(layer); } catch (e) { kind = null; }
            if (kind !== null && kind !== only) { throw new Error(__pathHead(layer) + __q(path[0]) + " exists only on " + only + " layers \u2014 address a " + only + " layer (ae_get_comp lists each layer's kind)."); }
          }
          at = i === 0 ? "at the top of the layer" : "under " + __list(path.slice(0, i), i, __PATH_BUDGET);
          k = __kids(p, i === 0 ? 20 : 10, __byName(p, path[i]));
          if (k.n === 0) {
            pmn = "";
            try { pmn = String(p.matchName); } catch (e) { pmn = ""; }
            if (pmn === "ADBE Effect Parade") { throw new Error(__pathHead(layer) + "segment " + __q(path[i]) + " not found " + at + ", which is empty \u2014 the layer has no effects; apply one first (ae_apply_effect), or check the path."); }
            if (pmn === "ADBE Mask Parade") { throw new Error(__pathHead(layer) + "segment " + __q(path[i]) + " not found " + at + ", which is empty \u2014 the layer has no masks; add one first (ae_add_mask), or check the path."); }
            under = i > 0 ? __q(path[i - 1]) : "the layer";
            if (__isGroup(p)) { throw new Error(__pathHead(layer) + "segment " + __q(path[i]) + " not found " + at + ", which is an empty group \u2014 nothing can be addressed under " + under + " until something is added there; check the path."); }
            // Not a group: only without PropertyType (__isLeaf cannot tell), where p may be the leaf the path should end at.
            throw new Error(__pathHead(layer) + "segment " + __q(path[i]) + " not found " + at + ", which has nothing under it \u2014 " + (i > 0 ? "if " + under + " is the property you want, end the path there; otherwise " : "") + "check the path (ae_get_layer lists the layer's effects).");
          }
          throw new Error(__pathHead(layer) + "segment " + __q(path[i]) + " not found " + at + "; children here: " + k.text + __pick(k, p));
        }
        p = q;
      }
      return p;
    }
    mn = __TRANSFORM[name];
    if (!mn) { throw new Error("Unknown transform property " + __q(name) + " \u2014 use position, scale, rotation, opacity or anchorPoint, or pass propertyPath."); }
    p = layer.property("ADBE Transform Group").property(mn);
    if (!p) { throw new Error("Layer " + __layerLabel(layer) + " has no " + name + " \u2014 pass propertyPath for this layer."); }
    return p;
  }
  function __layerInfo(l) {
    return { index: l.index, name: l.name, kind: __kind(l), enabled: l.enabled, inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime, parentIndex: l.parent ? l.parent.index : null, sourceId: l.source ? l.source.id : null };
  }
  function __centerAnchor(l) {
    var r = l.sourceRectAtTime(0, false);
    if (r && r.width > 0) { l.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]); }
  }
  function __originAnchor(l) {
    l.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
  }
  function __trimLayers(c, d) {
    // Shrinking a comp does not shorten its layers; expressions keyed to outPoint need it to.
    for (var i = 1; i <= c.numLayers; i++) { var l = c.layer(i); if (l.outPoint > d) { try { l.outPoint = d; } catch (e) {} } }
  }
  function __compInfo(c) {
    return { id: c.id, name: c.name, width: c.width, height: c.height, duration: c.duration, frameRate: c.frameRate, numLayers: c.numLayers, pixelAspect: c.pixelAspect };
  }
  function __styles(l) {
    var g = l.property("ADBE Layer Styles");
    if (!g) { throw new Error("Layer " + __layerLabel(l) + " has no layer styles \u2014 cameras and lights cannot take styles; address another layer."); }
    return g;
  }
  // A style's group is fetched by its match name "<key>/enabled" (the short key
  // resolves for dropShadow only). canSetEnabled is false until the style is
  // actually added, so it doubles as "is this style present".
  function __styleGroup(g, key) {
    var f = null;
    try { f = g.property(key + "/enabled"); } catch (e) {}
    if (f && !f.canSetEnabled) { f = null; }
    return f;
  }
  function __styleParams(s) {
    var out = [];
    for (var i = 1; i <= s.numProperties; i++) {
      var q = s.property(i);
      var v = null;
      try { v = q.value; } catch (e) {}
      out.push({ index: i, name: q.name, matchName: q.matchName, value: v });
    }
    return out;
  }
`;

/**
 * Blank lines between "(function () {" and HELPERS. The CEP panel's host.jsx (62 lines) reports an
 * error it raises while serializing a result with ITS OWN line number (the observed "line 40" was
 * host.jsx:40, a host object in the result). With this guard such a line can never land on a
 * helper or body line, so locateAeError() reports it as outside the tool's code instead of blaming
 * a helper. Keep it above host.jsx's line count (after-effects-errors.test.ts checks the tracked
 * packages/panel-cep/host.jsx).
 */
export const HOST_LINE_GUARD = 100;

/** Any character outside ASCII (built from a string so the source holds no raw control characters). */
const NON_ASCII_CLASS = "[^\\x00-\\x7f]";
const NON_ASCII = new RegExp(NON_ASCII_CLASS, "g");

/**
 * Every non-ASCII code unit as \uXXXX: After Effects scripts travel as pure ASCII. Valid for this
 * file's scripts because builder text holds non-ASCII only inside string literals (where \uXXXX is
 * the same character) and // comments (where it is inert); no identifier, regex or whitespace
 * outside a literal is non-ASCII. A surrogate pair becomes two escapes, as ES3 expects. The line
 * count is unchanged (lit() already escapes U+2028/U+2029).
 */
function asciiSource(source: string): string {
  return source.replace(NON_ASCII, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const AE_PRELUDE = asciiSource("(function () {" + "\n".repeat(HOST_LINE_GUARD) + HELPERS);
const AE_SUFFIX = "\n})()";
const wrap = (body: string): string => AE_PRELUDE + asciiSource(body) + AE_SUFFIX;

/** wrap() for callers that assemble After Effects scripts outside this file (AE-03's ae_batch, tests). */
export const wrapAe = wrap;

/**
 * Script lines wholly taken by the prelude ("(function () {", the guard, HELPERS). Body-string
 * line k is script line AE_PRELUDE_LINES + k. Derived, never typed.
 */
export const AE_PRELUDE_LINES = lineCount(AE_PRELUDE) - 1;

/** A helper's script lines, inclusive. */
export interface AeHelperRange {
  readonly name: string;
  readonly first: number;
  readonly last: number;
}

function scanHelpers(prelude: string): AeHelperRange[] {
  const out: AeHelperRange[] = [];
  const lines = prelude.split("\n"); // template literals normalize CRLF, so the prelude holds LF only
  let open: { name: string; first: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1; // script line
    const start = /^ {2}function (__\w+)\(/.exec(line);
    if (start !== null) {
      if (open !== null) throw new Error(`HELPERS: ${start[1]} starts before ${open.name} closes`);
      open = { name: start[1]!, first: n };
    }
    if (open !== null && line === "  }") {
      out.push({ name: open.name, first: open.first, last: n });
      open = null;
    }
  }
  if (open !== null) throw new Error(`HELPERS: ${open.name} has no closing "  }" line`);
  return out;
}

// Module-load checks: a broken prelude fails the first import, so every test run.
if (!AE_PRELUDE.endsWith("\n")) throw new Error("HELPERS must end with a newline (no prelude line may be shared with the body)");
if (new RegExp(NON_ASCII_CLASS).test(HELPERS)) throw new Error("HELPERS must be pure ASCII (write an em dash as \\u2014)");

/** Built once at module load from the prelude; throws if a helper breaks the style rules. */
const AE_HELPERS: readonly AeHelperRange[] = scanHelpers(AE_PRELUDE);

/** What __q appends to a name it cut (checked against __q's source with AE_NAME_CUT). */
export const AE_CUT_MARK = "...";
const CUT_MARK = AE_CUT_MARK;

/** __q's cut length, read from its own source (one N in `i < N` and `.length > N`); throws when that cannot be read. */
function nameCutOf(helpers: string): number {
  const q = /\n {2}function __q\([\s\S]*?\n {2}\}\n/.exec(helpers)?.[0] ?? "";
  const kept = /\bi < (\d+)/.exec(q)?.[1];
  const marked = /\.length > (\d+)\)/.exec(q)?.[1];
  if (kept === undefined || kept !== marked || !q.includes(`"${CUT_MARK}"`)) {
    throw new Error(`HELPERS: __q must keep a name's first N characters and append "${CUT_MARK}" past N (i < N and .length > N, one N)`);
  }
  return Number(kept);
}

/**
 * How many UTF-16 units of a name __q keeps before it cuts the rest and appends "...". Read from
 * __q's source, so the number is typed once: a cut name can never resolve (aeListSuggestions drops
 * it), and buildRuntime passes it (with AE_CUT_MARK) to redaction, which then finds a secret in a
 * name __q cut, whether the name was the secret or the secret came after other text.
 */
export const AE_NAME_CUT = nameCutOf(HELPERS);

/** The shared helpers' script-line ranges (tests, AE-03). */
export function aeHelperRanges(): readonly AeHelperRange[] {
  return AE_HELPERS;
}

export type AeErrorLocation =
  | { readonly kind: "body"; readonly bodyLine: number }
  | { readonly kind: "helper"; readonly helper: string }
  | { readonly kind: "outside" }
  | { readonly kind: "unknown" };

/** The body of a wrap()ped script, or null for any other script (a future ae_batch, a raw wrapper). */
function aeBody(script: string): string | null {
  return script.length >= AE_PRELUDE.length + AE_SUFFIX.length && script.startsWith(AE_PRELUDE) && script.endsWith(AE_SUFFIX)
    ? script.slice(AE_PRELUDE.length, script.length - AE_SUFFIX.length)
    : null;
}

/**
 * Where a host-reported line falls in a wrap()ped script: a body line (the first body statement
 * is 1), a shared helper, outside the tool's code (the guard, line 1, a top-level helper var, the
 * empty first body line, the closing line, or past the end: host.jsx's serializer), or unknown.
 */
export function locateAeError(script: string, scriptLine: number | undefined): AeErrorLocation {
  if (scriptLine === undefined || !Number.isInteger(scriptLine) || scriptLine < 1) return { kind: "unknown" };
  const body = aeBody(script);
  if (body === null) return { kind: "unknown" };
  if (scriptLine <= AE_PRELUDE_LINES) {
    const h = AE_HELPERS.find((r) => scriptLine >= r.first && scriptLine <= r.last);
    return h === undefined ? { kind: "outside" } : { kind: "helper", helper: h.name };
  }
  const lead = body.startsWith("\n") ? 1 : 0; // every body today starts with "\n"
  const k = scriptLine - AE_PRELUDE_LINES; // 1-based line of the body string
  if (k <= lead || k > lineCount(body)) return { kind: "outside" };
  return { kind: "body", bodyLine: k - lead };
}

/** The line terminators lineCount() counts. */
const LINE_SPLIT = new RegExp("\\r\\n|[\\n\\r\\u2028\\u2029]");

/** Up to 3 lines around bodyLine, as "N: code" with ">>> " on the failing one; blank neighbours dropped; redacted and capped. */
export function aeExcerpt(script: string, bodyLine: number): string[] {
  const body = aeBody(script);
  if (body === null) return [];
  const lines = body.split(LINE_SPLIT);
  const lead = body.startsWith("\n") ? 1 : 0;
  const last = lines.length - lead;
  const out: string[] = [];
  for (let n = Math.max(1, bodyLine - 1); n <= Math.min(last, bodyLine + 1); n++) {
    const code = lines[n - 1 + lead]!.trim();
    if (code === "" && n !== bodyLine) continue;
    out.push(`${n === bodyLine ? ">>> " : ""}${n}: ${excerptLine(code)}`);
  }
  return out;
}

/** Tools whose arguments are never echoed (raw script text). AE-01's ae_run_script goes here. */
const AE_NO_ARG_ECHO: ReadonlySet<string> = new Set(["ae_run_script"]);

/**
 * What to say next when the host message does not. Every throw the builders and helpers raise
 * carries its own " — <next step>", so these reach only errors After Effects raised itself.
 * A bad id, index or path always gets a helper's own message, so a host error inside a helper
 * never blames the arguments.
 */
const AE_NEXT_STEP = {
  body: "check the values the line marked >>> uses (ae_get_comp and ae_get_layer show what exists), then retry",
  helper:
    "After Effects itself refused an operation inside a shared helper (a bad id or path gets its own message); " +
    "check the current state with ae_get_comp or ae_get_layer, then retry",
  outside: "the result held a value After Effects could not read; read it another way (for example ae_get_layer) or report the tool and its arguments",
  unknown: "check the arguments and retry; if it keeps failing, close and reopen the brainferno-mcp-bridge panel in After Effects",
} as const;

/** Helpers whose host failures have one likely cause: the next step for that cause. */
const ANCHOR_NEXT =
  "most likely the Anchor Point has keyframes, which After Effects will not overwrite: remove them with ae_remove_keyframes (property anchorPoint), then retry. " +
  "What the call changed before this stays; one Ctrl-Z in After Effects undoes it";
const AE_HELPER_NEXT: Readonly<Record<string, string>> = { __centerAnchor: ANCHOR_NEXT, __originAnchor: ANCHOR_NEXT };

function aeNextStep(at: AeErrorLocation): string {
  return at.kind === "helper" ? (AE_HELPER_NEXT[at.helper] ?? AE_NEXT_STEP.helper) : AE_NEXT_STEP[at.kind];
}

/** A double-quoted name or path in a host message (__q's quoting, or a host's own). */
const QUOTED_SPAN = /"(?:[^"\\]|\\.)*"/g;

/** Whether the host message already says what to do next: a " — " outside the names it quotes. */
function saysNext(message: string): boolean {
  return message.replace(QUOTED_SPAN, '""').includes(" — ");
}

/**
 * Adds AE-16's details to an After Effects ScriptError raised by `script`: where the line falls,
 * the code around a body line, the tool and its arguments (from the tool-call context), "did you
 * mean" names from a list the host message carries, and a next step when the message has none.
 * Anything else is returned unchanged; message, appId and scriptLine never change.
 */
export function enrichAeError(error: unknown, script: string): unknown {
  if (!(error instanceof ScriptError) || error.appId !== "after_effects" || error.details.where !== undefined) return error;
  const at = locateAeError(script, error.scriptLine);
  const call = currentToolCall();
  const names = aeListSuggestions(error.message);
  return error.withDetails({
    where: at.kind,
    ...(at.kind === "body" ? { bodyLine: at.bodyLine, excerpt: aeExcerpt(script, at.bodyLine) } : {}),
    ...(at.kind === "helper" ? { helper: at.helper } : {}),
    ...(call !== undefined ? { tool: call.tool, ...(call.args !== undefined ? { args: echoArgs(call.args) } : {}) } : {}),
    ...(names.length > 0 ? { suggestions: names.map((name) => ({ name })) } : {}),
    ...(saysNext(error.message) ? {} : { next: aeNextStep(at) }),
  });
}

/** bridge.evaluate for wrap()ped After Effects scripts: a ScriptError comes back enriched. Use it at every AE evaluate site. */
export async function evaluateAe(bridge: AppBridge, script: string, options?: EvalOptions): Promise<JsonValue> {
  try {
    return await bridge.evaluate(script, options);
  } catch (error) {
    throw enrichAeError(error, script);
  }
}

// ---- "did you mean" from a list the host message carries -------------------------

const JSON_STRING = '("(?:[^"\\\\]|\\\\.)*")';
const LIST_MISSES: readonly RegExp[] = [
  // __prop (non-greedy: a ";" in a path name does not break it)
  new RegExp(`segment ${JSON_STRING} not found .*?; children here: (?=\\[)`),
  // setEffectParamScript: an effect, then a parameter, that is not there
  new RegExp(`: ${JSON_STRING}; effects on this layer: (?=\\[)`),
  new RegExp(`: ${JSON_STRING}; parameters: (?=\\[)`),
  // queueRenderScript: a composition name that is not there
  new RegExp(`^No composition named ${JSON_STRING}; compositions: (?=\\[)`),
];

/** __q cuts names at AE_NAME_CUT UTF-16 units and appends "...": such a name can never resolve. */
const isCutName = (s: string): boolean => s.length === AE_NAME_CUT + CUT_MARK.length && s.endsWith(CUT_MARK);

function parseJsonString(literal: string): string | null {
  try {
    const v: unknown = JSON.parse(literal);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The JSON array of strings starting at text[start] (a "[" ) and the index just past it, or null when there is none. */
function readJsonStringArray(text: string, start: number): { items: string[]; end: number } | null {
  if (text[start] !== "[") return null;
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      try {
        const v: unknown = JSON.parse(text.slice(start, i + 1));
        return Array.isArray(v) ? { items: v.filter((x): x is string => typeof x === "string"), end: i + 1 } : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The names that appear once: a name that repeats in a list names several items, and a lookup by it reaches only the first. */
function onlyUnique(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return names.filter((n) => seen.get(n) === 1);
}

/** What __kids writes after a list when names repeat among all the children, listed or not; then the count __list adds when it cut. */
const REPEATED_AFTER_LIST = /^(?: \(\+\d+ more\))?; repeated: (?=\[)/;
const LIST_CUT = /^ \(\+\d+ more\)/;

/**
 * The names __kids says repeat, read right after the list that ends at `end`: [] when it says none;
 * null when it names them but that list was cut or does not parse (then any listed name may repeat).
 */
function repeatedNames(message: string, end: number): string[] | null {
  const rest = message.slice(end);
  const m = REPEATED_AFTER_LIST.exec(rest);
  if (m === null) return [];
  const rep = readJsonStringArray(rest, m[0].length);
  return rep === null || LIST_CUT.test(rest.slice(rep.end)) ? null : rep.items;
}

/**
 * Ranks the names a host message lists against the name it could not find, leaving out cut names,
 * names that repeat in the list and names the host says repeat among children it did not list;
 * [] when the message is not one of these misses or does not parse.
 */
export function aeListSuggestions(message: string): string[] {
  for (const re of LIST_MISSES) {
    const m = re.exec(message);
    if (m === null) continue;
    const query = parseJsonString(m[1]!);
    const names = readJsonStringArray(message, m.index + m[0].length);
    if (query === null || names === null || /^\d+$/.test(query) || isCutName(query)) return [];
    const repeated = repeatedNames(message, names.end);
    if (repeated === null) return [];
    return closestNames(
      query,
      onlyUnique(names.items).filter((n) => !isCutName(n) && !repeated.includes(n)),
      { limit: 3, normalize: stripAeVendor },
    );
  }
  return [];
}

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
  if (!f.exists) { throw new Error("No file at " + f.fsName + " — pass the absolute path of an existing .aep file."); }
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
  if (!f.exists) { throw new Error("No file at " + f.fsName + " — pass the absolute path of an existing media file."); }
  return __undo("Import footage", function () {
    var item = app.project.importFile(new ImportOptions(f));
    return { id: item.id, name: item.name, width: item.width, height: item.height, duration: item.duration, hasVideo: item.hasVideo, hasAudio: item.hasAudio };
  });`);
}

/**
 * Import a layered PSD or AI as a composition (one AE layer per source layer).
 * ImportAsType.COMP keeps each layer at document size; COMP_CROPPED_LAYERS crops
 * to content. The importer preserves blend modes and positions, and — for PSD —
 * layer styles as After Effects imports them. There is no ImportOptions flag for
 * the dialog's "editable vs merged layer styles"; AE uses its own default.
 */
export interface ImportAsCompOptions {
  duration?: number;
  frameRate?: number;
}

export function importAsCompScript(path: string, cropped: boolean, opts: ImportAsCompOptions = {}): string {
  const want = cropped ? "ImportAsType.COMP_CROPPED_LAYERS" : "ImportAsType.COMP";
  // The imported comp takes the project's default length (often minutes); callers
  // building a template want it at the real duration and frame rate right away.
  const timing =
    (opts.frameRate !== undefined ? `    item.frameRate = ${num(opts.frameRate)};\n` : "") +
    (opts.duration !== undefined ? `    item.duration = ${num(opts.duration)}; __trimLayers(item, ${num(opts.duration)});\n` : "");
  return wrap(`
  var f = new File(${lit(path)});
  if (!f.exists) { throw new Error("No file at " + f.fsName + " — pass the absolute path of an existing .psd or .ai file."); }
  return __undo("Import as composition", function () {
    var io = new ImportOptions(f);
    if (io.canImportAs(${want})) { io.importAs = ${want}; }
    else if (io.canImportAs(ImportAsType.COMP)) { io.importAs = ImportAsType.COMP; }
    else { throw new Error("After Effects cannot import this file as a composition — pass a layered .psd, or an .ai saved in RGB (not CMYK) with PDF compatibility."); }
    var item = app.project.importFile(io);
    if (!(item instanceof CompItem)) { throw new Error("Imported " + __q(item.name) + " (id " + item.id + ") as footage, not as a composition, so the file may have only one layer — add that footage with ae_add_layer (kind footage, itemId " + item.id + "), or pass a layered .psd or .ai."); }
${timing}    var info = __compInfo(item);
    var layers = [];
    for (var i = 1; i <= item.numLayers; i++) { layers.push(__layerInfo(item.layer(i))); }
    info.layers = layers;
    return info;
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

export interface CompProps {
  name?: string;
  duration?: number;
  frameRate?: number;
  width?: number;
  height?: number;
}

export function setCompPropsScript(compId: number, p: CompProps): string {
  const lines =
    (p.name !== undefined ? `    c.name = ${lit(p.name)};\n` : "") +
    (p.frameRate !== undefined ? `    c.frameRate = ${num(p.frameRate)};\n` : "") +
    (p.width !== undefined ? `    c.width = ${num(p.width)};\n` : "") +
    (p.height !== undefined ? `    c.height = ${num(p.height)};\n` : "") +
    (p.duration !== undefined ? `    c.duration = ${num(p.duration)}; __trimLayers(c, ${num(p.duration)});\n` : "");
  return wrap(`
  var c = __comp(${num(compId)});
  return __undo("Set comp properties", function () {
${lines}    return __compInfo(c);
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
  /** text: where the anchor goes. center (default) = position is the text's visual centre; origin = position is the left baseline. */
  anchor?: TextAnchor;
}

export type TextAnchor = "center" | "origin";

export function addLayerScript(p: AddLayerParams): string {
  const color = p.color ? rgb(p.color) : "[1, 1, 1]";
  // Footage: look the item up before the undo group opens, so a bad id changes nothing. itemByID
  // throws for an unknown id (verified live on 26.3) and is never called with null.
  const pass = "pass a footage item id (ae_list_footage) or a composition id (ae_list_compositions).";
  const lookup =
    p.itemId === undefined
      ? ""
      : `
  try { item = app.project.itemByID(${num(p.itemId)}); } catch (e) { item = null; }
  if (!item) { throw new Error("No project item with id " + itemId + " — ${pass}"); }
  // AVItem is not a global in AE 26.3's ExtendScript; test the concrete classes.
  if (!(item instanceof FootageItem || item instanceof CompItem)) { throw new Error("Item " + itemId + " " + __q(item.name) + " is a folder, not footage or a composition — ${pass}"); }`;
  const footage =
    p.kind !== "footage"
      ? ""
      : `
  var item = null, itemId = ${optNum(p.itemId)};
  if (itemId === null) { throw new Error("kind 'footage' needs itemId — ${pass}"); }${lookup}`;
  return wrap(`
  var c = __comp(${num(p.compId)});${footage}
  return __undo("Add layer", function () {
    var kind = ${lit(p.kind)}, l;
    if (kind === "footage") {
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
    if (kind === "text") { ${p.anchor === "origin" ? "__originAnchor(l);" : "__centerAnchor(l);"} }
    return __layerInfo(l);
  });`);
}

export interface AddShapeParams {
  compId: number;
  kind: "rectangle" | "ellipse" | "star" | "polygon";
  width?: number;
  height?: number;
  points?: number;
  outerRadius?: number;
  innerRadius?: number;
  roundness?: number;
  position?: [number, number];
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  name?: string;
}

/**
 * Create a shape layer with one parametric shape (rectangle/ellipse/star/polygon)
 * plus an optional fill and stroke. The vector tree is layer → "ADBE Root Vectors
 * Group" (Contents) → "ADBE Vector Group" → its "ADBE Vectors Group" holding the
 * shape, then Fill, then Stroke (stroke last so it draws on top). Verified live.
 */
export function addShapeScript(p: AddShapeParams): string {
  const w = p.width ?? 200;
  const h = p.height ?? 200;
  const points = p.points ?? 5;
  const outer = p.outerRadius ?? 100;
  const inner = p.innerRadius ?? 50;
  const fill = p.fill === undefined ? "#ffffff" : p.fill; // null clears fill
  const strokeWidth = p.strokeWidth ?? (p.stroke ? 4 : 0);
  const strokeColor = p.stroke ?? "#000000";
  const pos = p.position ? `[${num(p.position[0])}, ${num(p.position[1])}]` : "[c.width / 2, c.height / 2]";
  let shapeBody: string;
  if (p.kind === "rectangle") {
    shapeBody = `
    var shape = gc.addProperty("ADBE Vector Shape - Rect");
    shape.property("ADBE Vector Rect Size").setValue([${num(w)}, ${num(h)}]);
    ${p.roundness ? `shape.property("ADBE Vector Rect Roundness").setValue(${num(p.roundness)});` : ""}`;
  } else if (p.kind === "ellipse") {
    shapeBody = `
    var shape = gc.addProperty("ADBE Vector Shape - Ellipse");
    shape.property("ADBE Vector Ellipse Size").setValue([${num(w)}, ${num(h)}]);`;
  } else {
    shapeBody = `
    var shape = gc.addProperty("ADBE Vector Shape - Star");
    shape.property("ADBE Vector Star Type").setValue(${p.kind === "polygon" ? "2" : "1"});
    shape.property("ADBE Vector Star Points").setValue(${num(points)});
    shape.property("ADBE Vector Star Outer Radius").setValue(${num(outer)});
    ${p.kind === "star" ? `shape.property("ADBE Vector Star Inner Radius").setValue(${num(inner)});` : ""}`;
  }
  return wrap(`
  var c = __comp(${num(p.compId)});
  return __undo("Add shape", function () {
    var l = c.layers.addShape();
    var name = ${opt(p.name)}; if (name !== null) { l.name = name; }
    var root = l.property("ADBE Root Vectors Group");
    var grp = root.addProperty("ADBE Vector Group");
    var gc = grp.property("ADBE Vectors Group");
    ${shapeBody}
    ${fill === null ? "" : `gc.addProperty("ADBE Vector Graphic - Fill").property("ADBE Vector Fill Color").setValue(${rgb(fill)});`}
    ${strokeWidth > 0 ? `var st = gc.addProperty("ADBE Vector Graphic - Stroke"); st.property("ADBE Vector Stroke Color").setValue(${rgb(strokeColor)}); st.property("ADBE Vector Stroke Width").setValue(${num(strokeWidth)});` : ""}
    l.property("ADBE Transform Group").property("ADBE Position").setValue(${pos});
    return __layerInfo(l);
  });`);
}

export interface AddMaskParams {
  compId: number;
  layerIndex: number;
  kind: "rectangle" | "ellipse";
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  mode?: "add" | "subtract" | "intersect" | "lighten" | "darken" | "difference" | "none";
  feather?: number;
  opacity?: number;
  expansion?: number;
  name?: string;
}

/**
 * Add a rectangle or ellipse mask to a layer, in that layer's coordinates. A rect
 * is a 4-vertex closed Shape; an ellipse is a 4-vertex closed Shape with the
 * standard 0.5523·radius bezier handles. Bounds default to the whole comp.
 * Verified live on a solid.
 */
export function addMaskScript(p: AddMaskParams): string {
  const mode = { add: "ADD", subtract: "SUBTRACT", intersect: "INTERSECT", lighten: "LIGHTEN", darken: "DARKEN", difference: "DIFFERENCE", none: "NONE" }[p.mode ?? "add"];
  const L = p.left === undefined ? "0" : num(p.left);
  const T = p.top === undefined ? "0" : num(p.top);
  const R = p.right === undefined ? "c.width" : num(p.right);
  const B = p.bottom === undefined ? "c.height" : num(p.bottom);
  const shapeBody =
    p.kind === "rectangle"
      ? `s.vertices = [[L, T], [R, T], [R, B], [L, B]]; s.closed = true;`
      : `var cx = (L + R) / 2, cy = (T + B) / 2, rx = (R - L) / 2, ry = (B - T) / 2, k = 0.5522847498;
         s.vertices = [[cx, T], [L, cy], [cx, B], [R, cy]];
         s.inTangents  = [[rx * k, 0], [0, -ry * k], [-rx * k, 0], [0, ry * k]];
         s.outTangents = [[-rx * k, 0], [0, ry * k], [rx * k, 0], [0, -ry * k]];
         s.closed = true;`;
  return wrap(`
  var c = __comp(${num(p.compId)}); var l = __layer(c, ${num(p.layerIndex)});
  return __undo("Add mask", function () {
    var parade = l.property("ADBE Mask Parade");
    if (!parade) { throw new Error("Layer " + __layerLabel(l) + " cannot take masks — cameras and lights have none; address another layer."); }
    var mask = parade.addProperty("ADBE Mask Atom");
    var name = ${opt(p.name)}; if (name !== null) { mask.name = name; }
    var L = ${L}, T = ${T}, R = ${R}, B = ${B};
    var s = new Shape();
    ${shapeBody}
    mask.property("ADBE Mask Shape").setValue(s);
    mask.maskMode = MaskMode.${mode};
    ${p.feather ? `mask.property("ADBE Mask Feather").setValue([${num(p.feather)}, ${num(p.feather)}]);` : ""}
    ${p.opacity === undefined ? "" : `mask.property("ADBE Mask Opacity").setValue(${num(p.opacity)});`}
    ${p.expansion ? `mask.property("ADBE Mask Offset").setValue(${num(p.expansion)});` : ""}
    return { mask: mask.name, mode: ${lit(p.mode ?? "add")}, masks: parade.numProperties };
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
  // A numeric parent is resolved before the undo group: an out-of-range index then changes nothing.
  const parent = typeof p.parentIndex === "number" ? `\n  var parentLayer = __layer(c, ${num(p.parentIndex)}, "Parent");` : "";
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});${parent}
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
    ${p.parentIndex === undefined ? "" : p.parentIndex === null ? "l.parent = null;" : "l.parent = parentLayer;"}
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
    // Keep the old expression so a failed compile leaves the property untouched
    // (AE otherwise keeps the broken source assigned, just disabled).
    var prev = prop.expression;
    prop.expression = e;
    if (prop.expressionError) {
      var err = prop.expressionError;
      prop.expression = prev;
      throw new Error("Expression error: " + err + " — fix the expression; the property keeps its previous one.");
    }
    return { property: prop.name, expression: prop.expression, enabled: prop.expressionEnabled };
  });`);
}

/** The marker both the ES3 throw in applyEffectScript and the server's "did you mean" check use. */
export const EFFECT_MISS = "Effect not available: ";

/** The Effect Parade lookup both effect builders open with (two lines at `indent`): a camera or light has none. */
const effectParade = (indent: string): string =>
  `${indent}var fx = l.property("ADBE Effect Parade");\n` +
  `${indent}if (!fx) { throw new Error("Layer " + __layerLabel(l) + " cannot have effects — address a footage, solid, text, shape, null, adjustment or precomp layer."); }`;

export function applyEffectScript(compId: number, layerIndex: number, matchName: string, name?: string): string {
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  return __undo("Apply effect", function () {
${effectParade("    ")}
    if (!fx.canAddProperty(${lit(matchName)})) { throw new Error(${lit(EFFECT_MISS)} + __q(${lit(matchName)}) + " (layer " + __layerLabel(l) + ") — use an installed effect's match name, e.g. 'ADBE Gaussian Blur 2', or its display name."); }
    var e = fx.addProperty(${lit(matchName)});
${name !== undefined ? `    e.name = ${lit(name)};\n` : ""}
    var params = [];
    for (var i = 1; i <= e.numProperties; i++) { var pp = e.property(i); params.push({ index: i, name: pp.name, matchName: pp.matchName }); }
    return { index: e.propertyIndex, name: e.name, matchName: e.matchName, params: params };
  });`);
}

export function setEffectParamScript(compId: number, layerIndex: number, effect: number | string, param: string, value: number | number[] | string): string {
  const v = typeof value === "string" ? lit(value) : Array.isArray(value) ? `[${value.map(num).join(", ")}]` : num(value);
  const eff = typeof effect === "number" ? num(effect) : lit(effect);
  // The parameter list answers in the caller's vocabulary (the same rule as __byName).
  const byName = !param.startsWith("ADBE ");
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
${effectParade("  ")}
  if (!(fx.numProperties > 0)) { throw new Error("Layer " + __layerLabel(l) + " has no effects — apply one first (ae_apply_effect)."); }
  var e = null;
  try { e = fx.property(${eff}); } catch (x) { e = null; }
  if (!e) { var ek = __kids(fx, 20, true); throw new Error("Effect not found on layer " + __layerLabel(l) + ": " + __q(${eff}) + "; effects on this layer: " + ek.text + (ek.dup ? " — a repeated name reaches only the first of them; pass the effect's index (1 = first) instead." : " — pass one of these names, or the effect's index (1 = first).")); }
  var pp = null;
  try { pp = e.property(${lit(param)}); } catch (x) { pp = null; }
  if (!pp) { var pk = __kids(e, 20, ${byName ? "true" : "false"}); throw new Error("Parameter not found on effect " + __q(e.name) + ": " + __q(${lit(param)}) + "; parameters: " + pk.text + __pick(pk, e)); }
  return __undo("Set effect parameter", function () { pp.setValue(${v}); return { effect: e.name, param: pp.name, value: pp.value }; });`);
}

// ---- installed effects and effect "did you mean" ------------------------------

/**
 * Host facts the live probes decide (AE-16 spec §13, probe 13). The defaults state the unverified
 * assumption; a probe result flips the constant, and the messages follow from it.
 *  - EFFECT_NAMES_CASE_SENSITIVE: canAddProperty rejects a case-folded match name.
 *  - EFFECT_DISPLAY_NAMES_ACCEPTED: canAddProperty/addProperty accept a display name.
 */
export const EFFECT_NAMES_CASE_SENSITIVE = true;
export const EFFECT_DISPLAY_NAMES_ACCEPTED = false;

/** A full app.effects read slower than this switches the catalog to the filtered read for later connections. */
export const SLOW_EFFECTS_READ_MS = 3000;

/** Every installed effect as [matchName, displayName] tuples (compact on purpose: __acmStr serializes per character). */
export const LIST_INSTALLED_EFFECTS = wrap(`
  var out = [];
  var all = app.effects;
  for (var i = 0; i < all.length; i++) {
    try { out.push([String(all[i].matchName), String(all[i].displayName)]); } catch (e) {}
  }
  return out;`);

/**
 * Installed effects whose names are about as long as `query` (the catalog's filtered read). Read-only.
 * `query` is the requested name folded and without its vendor tag, `threshold` its rank threshold;
 * the window is the threshold plus 2, so UTF-16 vs code-point lengths can only add entries, never
 * drop one the server would keep. The server ranks the subset with the same code as a full list.
 */
export function filteredEffectsScript(query: string, threshold: number): string {
  return wrap(`
  var q = ${lit(query)}, w = ${num(threshold + 2)}, out = [], all = app.effects, i, mn, dn;
  var V = ["adbe", "cc", "apc", "visinf", "bcc"];
  function strip(s) {
    var k, c;
    for (k = 0; k < V.length; k++) {
      c = s.charAt(V[k].length);
      if (s.substring(0, V[k].length) === V[k] && (c === " " || c === "_")) { return s.substring(V[k].length + 1); }
    }
    return s;
  }
  function near(s) { return Math.abs(s.length - q.length) <= w; }
  for (i = 0; i < all.length; i++) {
    try {
      mn = String(all[i].matchName); dn = String(all[i].displayName);
      if (near(strip(mn.toLowerCase())) || near(dn.toLowerCase()) || near(strip(dn.toLowerCase()))) { out.push([mn, dn]); }
    } catch (e) {}
  }
  return out;`);
}

export interface InstalledEffect {
  readonly matchName: string;
  readonly displayName: string;
}

/** Keeps the [matchName, displayName] string pairs of a list read; anything else is dropped. */
function parseEffects(raw: JsonValue): InstalledEffect[] {
  if (!Array.isArray(raw)) return [];
  const out: InstalledEffect[] = [];
  for (const e of raw) {
    if (Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string") out.push({ matchName: e[0], displayName: e[1] });
  }
  return out;
}

/**
 * The installed effects, for one MCP session (built in registerAfterEffectsTools), read only on an
 * effect miss. Cached per panel connection (the bridge's connectionEpoch): restarting After
 * Effects, installing a plugin or reloading the panel reconnects, so the next miss re-reads.
 *
 * Failures are not cached and are retried on the next miss, except a timeout: the server cannot
 * cancel the host, so a timed-out read stops reads for the rest of that connection, and every
 * later connection uses the filtered read. A full read that succeeds but takes more than
 * SLOW_EFFECTS_READ_MS is kept for this connection and also switches later connections to the
 * filtered read. Concurrent misses share one read.
 */
export class EffectCatalog {
  private list: { readonly epoch: number; readonly effects: readonly InstalledEffect[] } | null = null;
  private inflight: { readonly epoch: number; readonly promise: Promise<readonly InstalledEffect[]> } | null = null;
  /** The full read proved slow or timed out: later reads send filteredEffectsScript. */
  private filtered = false;
  /** A read timed out on this connection: no more reads until the panel reconnects (the host may still be busy with it). */
  private timedOutEpoch: number | null = null;

  constructor(
    private readonly bridge: AppBridge,
    private readonly clock: () => number = Date.now,
  ) {}

  private epoch(): number {
    return this.bridge.connectionEpoch?.() ?? 0;
  }

  /** Effects worth ranking against `requested`: the cached full list, or a filtered subset. Rejects when no read is possible now. */
  async candidates(requested: string): Promise<readonly InstalledEffect[]> {
    const epoch = this.epoch();
    if (this.timedOutEpoch === epoch) throw new Error("the installed-effects read timed out on this connection");
    if (this.list !== null && this.list.epoch === epoch) return this.list.effects;
    if (this.filtered) return this.readFiltered(requested, epoch);
    if (this.inflight === null || this.inflight.epoch !== epoch) {
      const promise = this.readAll(epoch);
      this.inflight = { epoch, promise };
      // A failure is retried on the next miss.
      promise.catch(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
      });
    }
    return this.inflight.promise;
  }

  private async readAll(epoch: number): Promise<readonly InstalledEffect[]> {
    const t0 = this.clock();
    let raw: JsonValue;
    try {
      raw = await this.bridge.evaluate(LIST_INSTALLED_EFFECTS, { timeoutClass: "fast" });
    } catch (error) {
      if (error instanceof EvalTimeoutError) {
        this.filtered = true;
        this.timedOutEpoch = epoch;
      }
      throw error;
    }
    const ms = this.clock() - t0;
    const effects = parseEffects(raw);
    log.debug(`app.effects: ${effects.length} effects read in ${ms} ms`);
    if (effects.length === 0) throw new Error("the installed-effects read came back empty"); // a failure, never a cached success
    if (ms > SLOW_EFFECTS_READ_MS && !this.filtered) {
      this.filtered = true;
      log.info(`reading the installed After Effects effects took ${ms} ms; later reads ask only for names of a similar length`);
    }
    this.list = { epoch, effects };
    return effects;
  }

  private async readFiltered(requested: string, epoch: number): Promise<readonly InstalledEffect[]> {
    const q = stripAeVendor(fold(requested));
    try {
      return parseEffects(await this.bridge.evaluate(filteredEffectsScript(q, suggestionThreshold(q)), { timeoutClass: "fast" }));
    } catch (error) {
      if (error instanceof EvalTimeoutError) this.timedOutEpoch = epoch;
      throw error;
    }
  }
}

/** The two probe-decided facts, as a parameter so tests cover both branches without mutating exports. */
export interface EffectNameRules {
  readonly caseSensitive: boolean;
  readonly displayNamesAccepted: boolean;
}
const EFFECT_NAME_RULES: EffectNameRules = { caseSensitive: EFFECT_NAMES_CASE_SENSITIVE, displayNamesAccepted: EFFECT_DISPLAY_NAMES_ACCEPTED };

/**
 * ae_apply_effect's miss path: an installed effect After Effects refused gets a note; a display
 * name or a case slip gets the exact match name; a typo gets up to 3 close installed names.
 * Returns `error` unchanged for anything else, or when the installed list cannot be read now.
 */
export async function withEffectSuggestions(catalog: EffectCatalog, error: unknown, requested: string, rules: EffectNameRules = EFFECT_NAME_RULES): Promise<unknown> {
  if (!(error instanceof ScriptError) || !error.message.startsWith(EFFECT_MISS)) return error;
  let effects: readonly InstalledEffect[];
  try {
    effects = await catalog.candidates(requested);
  } catch {
    return error;
  }
  const refused = "That effect is installed, but After Effects would not add it to this layer.";
  const caseNote = "Names must match exactly, case included.";
  /** A display name that is (or would be, once its case is right) refused: the match name to pass instead. */
  const passMatchName = (e: InstalledEffect) =>
    error.withDetails({
      suggestions: [{ name: e.matchName, label: e.displayName }],
      note: "That effect is installed; pass its match name — if that also fails, this layer cannot take it.",
    });
  const byMatch = effects.find((e) => e.matchName === requested);
  if (byMatch !== undefined) {
    return error.withDetails({ note: `"${byMatch.matchName}" (${byMatch.displayName}) is installed, but After Effects would not add it to this layer.` });
  }
  const byDisplay = effects.find((e) => e.displayName === requested);
  if (byDisplay !== undefined) return rules.displayNamesAccepted ? error.withDetails({ note: refused }) : passMatchName(byDisplay);
  const folded = fold(requested);
  // A match name with a case slip: only the case rule applies.
  const caseMatch = effects.find((e) => fold(e.matchName) === folded);
  if (caseMatch !== undefined) {
    return rules.caseSensitive
      ? error.withDetails({ suggestions: [{ name: caseMatch.matchName, label: caseMatch.displayName }], note: caseNote })
      : error.withDetails({ note: refused });
  }
  // A display name with a case slip: the display-name rule decides first, then the case rule.
  const caseDisplay = effects.find((e) => fold(e.displayName) === folded);
  if (caseDisplay !== undefined) {
    if (!rules.displayNamesAccepted) return passMatchName(caseDisplay);
    return rules.caseSensitive ? error.withDetails({ suggestions: [{ name: caseDisplay.displayName }], note: caseNote }) : error.withDetails({ note: refused });
  }
  const ranked = rank(requested, effects, (e) => [e.matchName, e.displayName], { limit: 3, normalize: stripAeVendor });
  if (ranked.length === 0) return error;
  return error.withDetails({ suggestions: ranked.map((r) => ({ name: r.item.matchName, label: r.item.displayName })) });
}

/**
 * Layer styles are Photoshop's effects (drop shadow, stroke, …) living under
 * "ADBE Layer Styles". Each maps to an internal key; the group is addressed by
 * its match name "<key>/enabled" and its parameters by "<key>/<param>".
 */
export const LAYER_STYLE_KEYS = {
  dropShadow: "dropShadow",
  innerShadow: "innerShadow",
  outerGlow: "outerGlow",
  innerGlow: "innerGlow",
  bevelEmboss: "bevelEmboss",
  satin: "chromeFX",
  colorOverlay: "solidFill",
  gradientOverlay: "gradientFill",
  stroke: "frameFX",
} as const;
export type LayerStyleName = keyof typeof LAYER_STYLE_KEYS;

/**
 * Layer styles cannot be added with addProperty (After Effects refuses it). The
 * working way is the Layer > Layer Styles menu command, which needs the comp
 * open in the viewer and the target layer selected. The menu ids are the stable
 * 9000–9008 block (verified live); findMenuCommandId returned a bogus id once
 * after a reconnect, so the fixed id runs first and the label is only a retry.
 */
const LAYER_STYLE_MENU: Record<LayerStyleName, { label: string; id: number }> = {
  dropShadow: { label: "Drop Shadow", id: 9000 },
  innerShadow: { label: "Inner Shadow", id: 9001 },
  outerGlow: { label: "Outer Glow", id: 9002 },
  innerGlow: { label: "Inner Glow", id: 9003 },
  bevelEmboss: { label: "Bevel and Emboss", id: 9004 },
  satin: { label: "Satin", id: 9005 },
  colorOverlay: { label: "Color Overlay", id: 9006 },
  gradientOverlay: { label: "Gradient Overlay", id: 9007 },
  stroke: { label: "Stroke", id: 9008 },
};

export function addLayerStyleScript(compId: number, layerIndex: number, style: LayerStyleName): string {
  const key = LAYER_STYLE_KEYS[style];
  const menu = LAYER_STYLE_MENU[style];
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var g = __styles(l);
  var s = __styleGroup(g, ${lit(key)});
  if (s) {
    return __undo("Enable layer style", function () {
      try { s.enabled = true; } catch (e) {}
      return { style: ${lit(style)}, matchName: s.matchName, params: __styleParams(s), alreadyPresent: true };
    });
  }
  // addProperty does not work for layer styles — the Layer Styles menu command
  // is the only way, and it needs the comp foremost and only this layer selected.
  return __undo("Add layer style", function () {
    var added = null;
    // Seen live: the command did not take when other scripts were queued behind
    // it. Reselect and try again after a short pause before giving up.
    for (var attempt = 0; attempt < 3 && !added; attempt++) {
      if (attempt > 0) { $.sleep(150); }
      c.openInViewer();
      for (var j = 1; j <= c.numLayers; j++) { c.layer(j).selected = false; }
      l.selected = true;
      app.executeCommand(${num(menu.id)});
      added = __styleGroup(g, ${lit(key)});
    }
    if (!added) {
      // Very rare: the fixed id was renumbered. Retry via the localized label.
      var mid = 0;
      try { mid = app.findMenuCommandId(${lit(menu.label)}); } catch (e) {}
      if (mid) { app.executeCommand(mid); added = __styleGroup(g, ${lit(key)}); }
    }
    if (!added) { throw new Error("Could not add the " + ${lit(style)} + " layer style to layer " + __layerLabel(l) + ": the Layer Styles menu command did not take — close any open dialog in After Effects and retry; if it keeps failing, add the style from the Layer menu (Layer Styles) in After Effects."); }
    try { added.enabled = true; } catch (e) {}
    return { style: ${lit(style)}, matchName: added.matchName, params: __styleParams(added) };
  });`);
}

export function getLayerStylesScript(compId: number, layerIndex: number): string {
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var g = __styles(l);
  var out = { enabled: g.enabled, styles: [] };
  for (var i = 1; i <= g.numProperties; i++) {
    var s = g.property(i);
    if (s.matchName === "ADBE Blend Options Group") { continue; }
    if (!s.canSetEnabled) { continue; } // hidden template group, not actually on the layer
    out.styles.push({ name: s.name, matchName: s.matchName, enabled: s.enabled, params: __styleParams(s) });
  }
  return out;`);
}

export function setLayerStyleParamScript(compId: number, layerIndex: number, style: LayerStyleName, param: string, value: number | number[] | string): string {
  const key = LAYER_STYLE_KEYS[style];
  // Hex colors become AE's [r, g, b, a] 0–1 arrays; other strings pass through.
  const hexMatch = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
  const v = hexMatch ? `${rgb(value as string).slice(0, -1)}, 1]` : typeof value === "string" ? lit(value) : Array.isArray(value) ? `[${value.map(num).join(", ")}]` : num(value);
  // The parameter list answers in the caller's vocabulary: match names ("dropShadow/blur") hold a slash.
  const byName = !param.includes("/");
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var g = __styles(l);
  var s = __styleGroup(g, ${lit(key)});
  if (!s) { throw new Error("The " + ${lit(style)} + " style is not on layer " + __layerLabel(l) + " — add it first with ae_add_layer_style."); }
  var q = null;
  var want = ${lit(param)};
  var wl = want.toLowerCase();
  for (var i = 1; i <= s.numProperties; i++) {
    var cand = s.property(i);
    if (cand.matchName === want || String(cand.name).toLowerCase() === wl) { q = cand; break; }
  }
  if (!q) {
    var pk = __kids(s, 20, ${byName ? "true" : "false"});
    throw new Error("Parameter not found on the " + ${lit(style)} + " style of layer " + __layerLabel(l) + ": " + __q(want) + "; parameters: " + pk.text + (pk.dup ? " — a repeated name reaches only the first of them; pass the parameter's match name instead (ae_get_layer_styles lists them)." : " — use one of these names."));
  }
  return __undo("Set layer style parameter", function () { q.setValue(${v}); return { style: ${lit(style)}, param: q.name, matchName: q.matchName, value: q.value }; });`);
}

export function removeLayerStyleScript(compId: number, layerIndex: number, style: LayerStyleName): string {
  const key = LAYER_STYLE_KEYS[style];
  // After Effects keeps a permanent slot per style and rejects .remove() on it,
  // so "remove" turns the style off (enabled = false) — the visible effect goes
  // away, matching what the eyeball toggle does in the UI.
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var g = __styles(l);
  var s = __styleGroup(g, ${lit(key)});
  if (!s) { throw new Error("The " + ${lit(style)} + " style is not on layer " + __layerLabel(l) + " — nothing to turn off; ae_get_layer_styles lists the styles on this layer."); }
  return __undo("Turn off layer style", function () { s.enabled = false; return { style: ${lit(style)}, enabled: false }; });`);
}

// ---- Essential Graphics / Motion Graphics templates -------------------------

/**
 * Expose a layer property in the comp's Essential Graphics panel so the comp can
 * be exported as a Motion Graphics template. Verified live on AE 26.3:
 * canAddToMotionGraphicsTemplate / addToMotionGraphicsTemplate take the comp the
 * property lives in; the control is named after the property (AE 26.3 has no
 * script to rename it). Source Text lives at ADBE Text Properties > Text Document.
 */
export function addToEssentialGraphicsScript(compId: number, layerIndex: number, property: string, propertyPath: string[] | undefined): string {
  const path = propertyPath ? `[${propertyPath.map(lit).join(", ")}]` : "null";
  return wrap(`
  var c = __comp(${num(compId)}); var l = __layer(c, ${num(layerIndex)});
  var prop = __prop(l, ${lit(property)}, ${path});
  if (!prop.canAddToMotionGraphicsTemplate(c)) {
    throw new Error("Property " + __q(prop.name) + " of layer " + __layerLabel(l) + " cannot be added to Essential Graphics: its type is not supported, or the panel already has a control with that name — pass another property (a transform channel, sourceText or an effect control), or rename that control in the Essential Graphics panel, then retry.");
  }
  return __undo("Add to Essential Graphics", function () {
    var ok = prop.addToMotionGraphicsTemplate(c);
    if (!ok) { throw new Error("After Effects refused to add " + __q(prop.name) + " to the Essential Graphics panel of " + __q(c.name) + " — check that panel in After Effects, then retry or pass another property."); }
    var count = c.motionGraphicsTemplateControllerCount;
    var names = [];
    for (var i = 1; i <= count; i++) { names.push(c.getMotionGraphicsTemplateControllerName(i)); }
    return { added: prop.name, controllerCount: count, controllers: names };
  });`);
}

/**
 * Export the comp as a .mogrt. The host's exportAsMotionGraphicsTemplate takes a
 * *folder* and names the file from motionGraphicsTemplateName, so we split the
 * requested path, set the name, and write <folder>/<name>.mogrt. Verified live on
 * AE 26.3 (the pre-24.3 "always returns false" bug is gone; we still check the
 * file exists). The project must be saved — a dirty project makes AE prompt.
 * Without overwrite, an existing file is refused before anything is saved or exported, so the
 * file check after the export only ever sees a folder it could not write or an export that failed.
 */
export function exportMogrtScript(compId: number, folder: string, name: string, overwrite: boolean): string {
  return wrap(`
  var c = __comp(${num(compId)});
  if (!app.project.file) { throw new Error("The project has never been saved, and exporting a Motion Graphics template needs a saved project — save it first with ae_save_project (pass a path ending in .aep), then retry."); }
  var outPath = ${lit(folder)} + "/" + ${lit(name)} + ".mogrt";
${overwrite ? "" : `  if (new File(outPath).exists) { throw new Error("A file already exists at " + outPath + " — pass overwrite: true (the default) or another outputPath."); }\n`}  var fo = new Folder(${lit(folder)});
  if (!fo.exists) { fo.create(); }
  c.motionGraphicsTemplateName = ${lit(name)};
  // Read everything off the comp now: exportAsMotionGraphicsTemplate invalidates
  // the comp reference, so touching c afterwards throws "Object is invalid".
  var compName = c.name;
  var controllers = c.motionGraphicsTemplateControllerCount;
  // A missing font (or any project warning) pops a modal, and any modal blocks ALL
  // scripting until a human dismisses it. Suppress dialogs around the save+export
  // so it stays headless.
  var ok = false;
  app.beginSuppressDialogs();
  try {
    app.project.save();
    ok = c.exportAsMotionGraphicsTemplate(${overwrite ? "true" : "false"}, ${lit(folder)});
  } finally {
    app.endSuppressDialogs(false);
  }
  var f = new File(outPath);
  if (!f.exists) { throw new Error("After Effects did not write " + outPath + " (export returned " + ok + "): the folder is not writable, or the export failed — pass a folder you can write to, then retry."); }
  return { compName: compName, name: ${lit(name)}, outputPath: outPath, controllerCount: controllers };`);
}

export interface SetTextParams {
  compId: number;
  layerIndex: number;
  text?: string;
  fontSize?: number;
  font?: string;
  color?: string;
  justification?: "left" | "center" | "right";
  anchor?: TextAnchor;
}

export function setTextScript(p: SetTextParams): string {
  return wrap(`
  var c = __comp(${num(p.compId)}); var l = __layer(c, ${num(p.layerIndex)});
  if (l.matchName !== "ADBE Text Layer") { throw new Error("Layer " + __layerLabel(l) + " is not a text layer — address a text layer (ae_get_comp lists each layer's kind)."); }
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
    // Point text is positioned by its anchor; by default put the anchor at the
    // visual center so position means "center of the text" regardless of
    // justification (CENTER_JUSTIFY did not center on the anchor here).
    // anchor "origin" leaves it at [0, 0]: position is then the left baseline.
    ${p.anchor === "origin" ? "__originAnchor(l);" : "__centerAnchor(l);"}
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

/** Add a comp (by name) to the render queue with an output path and optional output-module template. */
export function queueRenderScript(compName: string, outputPath: string, templateName: string | undefined): string {
  return wrap(`
  var target = null;
  for (var i = 1; i <= app.project.numItems; i++) { var item = app.project.item(i); if (item instanceof CompItem && item.name === ${lit(compName)}) { target = item; break; } }
  if (target === null) {
    // The names this tool takes, as a list aeListSuggestions reads (up to 20, cut by length).
    var names = [], n = 0;
    for (var j = 1; j <= app.project.numItems; j++) { var it = app.project.item(j); if (it instanceof CompItem) { n++; if (names.length < 20) { names.push(it.name); } } }
    if (n === 0) { throw new Error("No composition named " + __q(${lit(compName)}) + "; the project has no compositions — create one with ae_create_comp, then queue it."); }
    throw new Error("No composition named " + __q(${lit(compName)}) + "; compositions: " + __list(names, n, __BUDGET) + " — pass one of these names exactly (ae_list_compositions lists them all).");
  }
  return __undo("Queue render", function () {
    var rqItem = app.project.renderQueue.items.add(target);
    var output = rqItem.outputModule(1);
    var template = ${opt(templateName)};
    if (template !== null) { output.applyTemplate(template); }
    output.file = new File(${lit(outputPath)});
    return { queueIndex: app.project.renderQueue.numItems, compName: target.name, outputPath: output.file.fsName, status: "queued" };
  });`);
}

export const AERENDER_INFO = wrap(`
  var proj = app.project;
  var appFolder = Folder.appPackage.fsName;
  return { projectPath: proj.file ? proj.file.fsName : null, dirty: proj.dirty === true, appFolder: appFolder, isWindows: $.os.indexOf("Windows") === 0 };`);

// ---- aerender (process lane) -------------------------------------------------

export function aerenderExecutable(appFolder: string, isWindows: boolean): string {
  // Windows: <...>\Support Files\aerender.exe (appPackage IS "Support Files").
  // macOS: appPackage is the .app bundle itself ("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app");
  // aerender sits next to the bundle, in its parent folder.
  // Explicit flavours so the result is right for the host's platform even when computed elsewhere (tests on CI).
  if (isWindows) return win32.join(appFolder, "aerender.exe");
  const folder = /\.app\/?$/i.test(appFolder) ? posix.dirname(appFolder) : appFolder;
  return posix.join(folder, "aerender");
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
  throw new Error(
    `After Effects did not finish writing ${path} within ${Math.round(timeoutMs / 1000)}s — turn on "Allow Scripts to Write Files and Access Network" ` +
      "in After Effects (Preferences > Scripting & Expressions) if it is off, then retry.",
  );
}

function runAerender(exe: string, args: string[], timeoutMs: number, signal?: AbortSignal, onLine?: (line: string) => void): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let partial = "";
    const keep = (d: Buffer) => {
      const text = d.toString();
      out += text;
      if (out.length > 8000) out = out.slice(-8000);
      if (onLine) {
        partial += text;
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const l of lines) if (l.includes("PROGRESS:") || l.includes("Finished") || /error/i.test(l)) onLine(l.trim());
      }
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`aerender did not finish within ${Math.round(timeoutMs / 1000)}s — queue the composition with ae_queue_render and render it in After Effects instead.`));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      reject(new Error("aerender was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, tail: out });
    });
  });
}

export interface RenderCompOptions {
  compName: string;
  outputPath: string;
  outputModule?: string;
  renderSettings?: string;
}

/**
 * Save the project, then render one comp with aerender. Shared by the
 * ae_render_comp tool and the pipelines; throws with an actionable message.
 */
export async function renderCompHeadless(bridge: AppBridge, o: RenderCompOptions, ctx: { signal?: AbortSignal; log?: (line: string) => void } = {}): Promise<{ outputPath: string; compName: string; log: string }> {
  const info = (await evaluateAe(bridge, saveProjectScript(undefined), { timeoutClass: "slow" })) as { path?: string };
  const meta = (await evaluateAe(bridge, AERENDER_INFO, { timeoutClass: "fast" })) as { projectPath: string | null; appFolder: string; isWindows: boolean };
  if (!info.path || !meta.projectPath) throw new Error("The project has no file — save it first with ae_save_project (pass a path ending in .aep), then retry.");
  const exe = aerenderExecutable(meta.appFolder, meta.isWindows);
  try {
    await stat(exe);
  } catch {
    throw new Error(`aerender not found at ${exe} — check that After Effects is fully installed (aerender ships with it), or queue the composition with ae_queue_render instead.`);
  }
  const args = ["-project", meta.projectPath, "-comp", o.compName, "-output", o.outputPath];
  if (o.outputModule) args.push("-OMtemplate", o.outputModule);
  if (o.renderSettings) args.push("-RStemplate", o.renderSettings);
  log.info(`aerender ${args.join(" ")}`);
  const { code, tail } = await runAerender(exe, args, 30 * 60_000, ctx.signal, ctx.log);
  if (code !== 0) {
    throw new Error(
      `aerender exited with ${code} — check compName and the outputModule and renderSettings template names against the project, then retry. Its output ends:\n${tail.slice(-1500)}`,
    );
  }
  return { outputPath: o.outputPath, compName: o.compName, log: tail.slice(-600) };
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

export interface AfterEffectsToolOptions {
  /** When given, ae_render_comp runs as a job (progress, cancel, wait:false). */
  jobs?: JobRegistry;
  /** Whether ae_render_comp blocks when the caller passes no `wait` (BRAINFERNO_MCP_DEFAULT_WAIT). */
  defaultWait?: boolean;
}

export function registerAfterEffectsTools(mcp: McpServer, bridge: AppBridge, options: AfterEffectsToolOptions = {}): void {
  // Every callback runs inside a tool-call context (tool name + validated arguments) that an
  // error raised deep inside a bridge call can name. The registerTool calls below are unchanged.
  const server = withToolContext(mcp, { noArgs: AE_NO_ARG_ECHO });
  // One per MCP session; refreshed when the panel reconnects. Read only on an effect miss.
  const effects = new EffectCatalog(bridge);
  const run = (script: string, opts?: EvalOptions) => guard(async () => jsonResult(await evaluateAe(bridge, script, opts)));

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

  server.registerTool(
    "ae_import_as_comp",
    {
      title: "After Effects: import a PSD or AI file as a composition",
      description:
        "Import a layered Photoshop (.psd) or Illustrator (.ai) file as a composition — every source layer becomes " +
        "its own After Effects layer, keeping blend modes, positions, and (for PSD) layer styles as After Effects " +
        "imports them. Illustrator files must be RGB (not CMYK) and saved with PDF compatibility. Returns the new " +
        "composition with its layers.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to a .psd or .ai file."),
        cropped: z.boolean().optional().describe("Crop each layer to its content (Composition - Cropped Layers). Defaults to false = keep document-size layers."),
        duration: z.number().positive().optional().describe("Seconds. Sets the new comp's length and trims its layers to match. Without it the comp takes the project default (often minutes)."),
        frameRate: z.number().positive().optional().describe("Frames per second for the new comp. Defaults to the project default."),
      },
    },
    async ({ path, cropped, duration, frameRate }) => run(importAsCompScript(path, cropped ?? false, { duration, frameRate })),
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
    "ae_set_comp_props",
    {
      title: "After Effects: set composition properties",
      description:
        "Change a composition's name, duration (seconds), frame rate, width, or height. Only given fields change. " +
        "Shortening the duration also trims every layer whose outPoint runs past it, so outPoint-based animation lands at the new end.",
      inputSchema: {
        compId,
        name: z.string().min(1).optional(),
        duration: z.number().positive().optional().describe("Seconds."),
        frameRate: z.number().positive().optional(),
        width: z.number().int().positive().optional().describe("Pixels."),
        height: z.number().int().positive().optional().describe("Pixels."),
      },
    },
    async ({ compId: id, ...p }) => run(setCompPropsScript(id, p)),
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
        anchor: z
          .enum(["center", "origin"])
          .optional()
          .describe("text: center (default) makes position the text's visual centre; origin makes position the left baseline (use with left justification for lower thirds)."),
        width: z.number().int().positive().optional().describe("solid: defaults to comp width."),
        height: z.number().int().positive().optional().describe("solid: defaults to comp height."),
      },
    },
    async (p) => run(addLayerScript(p)),
  );

  server.registerTool(
    "ae_add_shape",
    {
      title: "After Effects: add a shape layer",
      description:
        "Create a shape layer with one parametric shape and an optional fill and stroke. kind: rectangle or ellipse " +
        "(width/height), star or polygon (points, outerRadius, and — star only — innerRadius). Colors are hex; a stroke " +
        "is added when stroke or strokeWidth is given. position is the layer centre (defaults to the comp centre).",
      inputSchema: {
        compId,
        kind: z.enum(["rectangle", "ellipse", "star", "polygon"]),
        width: z.number().positive().optional().describe("rectangle/ellipse width in px. Defaults to 200."),
        height: z.number().positive().optional().describe("rectangle/ellipse height in px. Defaults to 200."),
        points: z.number().int().min(3).optional().describe("star/polygon point count. Defaults to 5."),
        outerRadius: z.number().positive().optional().describe("star/polygon outer radius in px. Defaults to 100."),
        innerRadius: z.number().positive().optional().describe("star inner radius in px. Defaults to 50."),
        roundness: z.number().min(0).optional().describe("rectangle corner roundness in px."),
        position: z.array(z.number().finite()).length(2).optional().describe("[x, y] layer centre. Defaults to the comp centre."),
        fill: hexColor.nullable().optional().describe("Fill color (hex). Defaults to white; null for no fill."),
        stroke: hexColor.optional().describe("Stroke color (hex). Omit for no stroke."),
        strokeWidth: z.number().min(0).optional().describe("Stroke width in px (defaults to 4 when a stroke color is given)."),
        name: z.string().min(1).optional(),
      },
    },
    async (p) =>
      run(
        addShapeScript({
          compId: p.compId,
          kind: p.kind,
          ...(p.width !== undefined ? { width: p.width } : {}),
          ...(p.height !== undefined ? { height: p.height } : {}),
          ...(p.points !== undefined ? { points: p.points } : {}),
          ...(p.outerRadius !== undefined ? { outerRadius: p.outerRadius } : {}),
          ...(p.innerRadius !== undefined ? { innerRadius: p.innerRadius } : {}),
          ...(p.roundness !== undefined ? { roundness: p.roundness } : {}),
          ...(p.position !== undefined ? { position: [p.position[0]!, p.position[1]!] } : {}),
          ...(p.fill !== undefined ? { fill: p.fill } : {}),
          ...(p.stroke !== undefined ? { stroke: p.stroke } : {}),
          ...(p.strokeWidth !== undefined ? { strokeWidth: p.strokeWidth } : {}),
          ...(p.name !== undefined ? { name: p.name } : {}),
        }),
      ),
  );

  server.registerTool(
    "ae_add_mask",
    {
      title: "After Effects: add a mask to a layer",
      description:
        "Add a rectangle or ellipse mask to a layer, in that layer's coordinates. Bounds are left/top/right/bottom " +
        "(default: the whole comp). mode is add (default), subtract, intersect, lighten, darken, difference, or none. " +
        "feather and expansion are in pixels; opacity is 0–100.",
      inputSchema: {
        compId,
        layerIndex,
        kind: z.enum(["rectangle", "ellipse"]),
        left: z.number().finite().optional(),
        top: z.number().finite().optional(),
        right: z.number().finite().optional(),
        bottom: z.number().finite().optional(),
        mode: z.enum(["add", "subtract", "intersect", "lighten", "darken", "difference", "none"]).optional(),
        feather: z.number().min(0).optional(),
        opacity: z.number().min(0).max(100).optional(),
        expansion: z.number().finite().optional(),
        name: z.string().min(1).optional(),
      },
    },
    async ({ compId: id, layerIndex: li, ...p }) =>
      run(
        addMaskScript({
          compId: id,
          layerIndex: li,
          kind: p.kind,
          ...(p.left !== undefined ? { left: p.left } : {}),
          ...(p.top !== undefined ? { top: p.top } : {}),
          ...(p.right !== undefined ? { right: p.right } : {}),
          ...(p.bottom !== undefined ? { bottom: p.bottom } : {}),
          ...(p.mode !== undefined ? { mode: p.mode } : {}),
          ...(p.feather !== undefined ? { feather: p.feather } : {}),
          ...(p.opacity !== undefined ? { opacity: p.opacity } : {}),
          ...(p.expansion !== undefined ? { expansion: p.expansion } : {}),
          ...(p.name !== undefined ? { name: p.name } : {}),
        }),
      ),
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
      description:
        "Set (or clear with null) the expression on a layer property. Use `property` for a transform channel, or " +
        "`propertyPath` (match/display names) to reach an effect parameter, mask, or text source. If the expression " +
        "does not compile it fails with the error text and the property keeps its previous expression.",
      inputSchema: { compId, layerIndex, property: propertyName, propertyPath, expression: z.string().nullable().describe("Expression source, or null to remove.") },
    },
    async ({ compId: id, layerIndex: li, property, propertyPath: pp, expression }) => run(setExpressionScript(id, li, property, pp, expression)),
  );

  // ---- essential graphics / motion graphics templates ---------------------
  server.registerTool(
    "ae_add_to_essential_graphics",
    {
      title: "After Effects: add a control to Essential Graphics",
      description:
        "Expose a layer property in the comp's Essential Graphics panel so the comp can be exported as a Motion " +
        "Graphics template (.mogrt). Give `property` for a transform channel or `sourceText` for a text layer's " +
        "content, or `propertyPath` (match/display names) for anything else, e.g. an effect's Slider or Color. " +
        "The control takes the property's name (rename it in the panel; After Effects has no script for that).",
      inputSchema: {
        compId,
        layerIndex,
        property: z
          .enum(["position", "scale", "rotation", "opacity", "anchorPoint", "sourceText"])
          .optional()
          .describe("Transform channel, or sourceText for a text layer's content. For anything else, use propertyPath."),
        propertyPath,
      },
    },
    async ({ compId: id, layerIndex: li, property, propertyPath: pp }) => {
      const path = property === "sourceText" && !pp ? ["ADBE Text Properties", "ADBE Text Document"] : pp;
      const prop = property && property !== "sourceText" ? property : "position";
      return run(addToEssentialGraphicsScript(id, li, prop, path));
    },
  );

  server.registerTool(
    "ae_export_mogrt",
    {
      title: "After Effects: export a Motion Graphics template",
      description:
        "Export a composition as a Motion Graphics template (.mogrt) — the controls added with " +
        "ae_add_to_essential_graphics become its editable fields. Saves the project first (it must have been saved " +
        "once). Returns the written path.",
      inputSchema: {
        compId,
        outputPath: z.string().min(1).describe("Absolute path ending in .mogrt. The file name (minus .mogrt) becomes the template name."),
        overwrite: z.boolean().optional().describe("Overwrite an existing file at that path. Defaults to true."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ compId: id, outputPath, overwrite }) => {
      const norm = outputPath.replace(/\\/g, "/");
      const slash = norm.lastIndexOf("/");
      const folder = slash >= 0 ? norm.slice(0, slash) : ".";
      const name = (slash >= 0 ? norm.slice(slash + 1) : norm).replace(/\.mogrt$/i, "");
      if (!name) return run(exportMogrtScript(id, folder, "Untitled", overwrite ?? true)); // unreachable-ish; keeps a name
      return run(exportMogrtScript(id, folder, name, overwrite ?? true));
    },
  );

  // ---- effects, text, markers ---------------------------------------------
  server.registerTool(
    "ae_apply_effect",
    {
      title: "After Effects: apply an effect",
      description:
        "Add an effect to a layer by match name (e.g. 'ADBE Gaussian Blur 2', 'ADBE Drop Shadow', 'ADBE Glo2', 'ADBE Tint') " +
        "or display name. Returns the effect index and its parameter names for ae_set_effect_param.",
      inputSchema: {
        compId,
        layerIndex,
        matchName: z
          .string()
          .min(1)
          .describe("Effect match name (e.g. 'ADBE Gaussian Blur 2') or display name (e.g. 'Gaussian Blur'). An unknown name fails with up to 3 close installed names."),
        name: z.string().min(1).optional().describe("Rename the effect once applied (e.g. a Slider Control named 'Speed'). Essential Graphics shows a control under this name."),
      },
    },
    async ({ compId: id, layerIndex: li, matchName, name }) =>
      guard(async () => {
        try {
          return jsonResult(await evaluateAe(bridge, applyEffectScript(id, li, matchName, name)));
        } catch (error) {
          throw await withEffectSuggestions(effects, error, matchName);
        }
      }),
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
        value: z
          .union([z.number(), z.array(z.number()), z.string()])
          .describe(
            "The new value: a number (a slider, angle or opacity; a checkbox as 1 or 0; a menu as its item number, 1 = first), " +
              "an array of numbers (a point as [x, y] or [x, y, z]; a color as [r, g, b] with each channel 0–1), or a string (a text parameter).",
          ),
      },
    },
    async ({ compId: id, layerIndex: li, effect, param, value }) => run(setEffectParamScript(id, li, effect, param, value)),
  );

  // ---- layer styles -------------------------------------------------------
  const styleName = z
    .enum(["dropShadow", "innerShadow", "outerGlow", "innerGlow", "bevelEmboss", "satin", "colorOverlay", "gradientOverlay", "stroke"])
    .describe("Layer style name.");

  server.registerTool(
    "ae_add_layer_style",
    {
      title: "After Effects: add a layer style",
      description:
        "Add a Photoshop-style layer style (drop shadow, inner shadow, glows, bevel & emboss, satin, color/gradient " +
        "overlay, stroke) to a layer. Returns the style's parameters (names and current values) for ae_set_layer_style_param.",
      inputSchema: { compId, layerIndex, style: styleName },
    },
    async ({ compId: id, layerIndex: li, style }) => run(addLayerStyleScript(id, li, style)),
  );

  server.registerTool(
    "ae_get_layer_styles",
    {
      title: "After Effects: read a layer's styles",
      description: "List the layer styles on a layer with each style's parameters and current values.",
      inputSchema: { compId, layerIndex },
      annotations: { readOnlyHint: true },
    },
    async ({ compId: id, layerIndex: li }) => run(getLayerStylesScript(id, li), { timeoutClass: "fast" }),
  );

  server.registerTool(
    "ae_set_layer_style_param",
    {
      title: "After Effects: set a layer style parameter",
      description:
        "Set a parameter on a layer style already added with ae_add_layer_style — by display name (e.g. 'Distance', " +
        "'Opacity', 'Color') or match name (e.g. 'dropShadow/blur'). Colors take a hex string or [r,g,b] 0–1 array.",
      inputSchema: {
        compId,
        layerIndex,
        style: styleName,
        param: z.string().min(1).describe("Parameter display name or match name."),
        value: z.union([z.number(), z.array(z.number()), z.string()]).describe("Number, [r,g,b] 0–1 array, or hex color like #ff8800."),
      },
    },
    async ({ compId: id, layerIndex: li, style, param, value }) => run(setLayerStyleParamScript(id, li, style, param, value)),
  );

  server.registerTool(
    "ae_remove_layer_style",
    {
      title: "After Effects: turn off a layer style",
      description:
        "Turn a layer style off (its visible effect goes away). After Effects keeps a permanent slot per style, " +
        "so this disables the style rather than deleting the slot; ae_add_layer_style turns it back on.",
      inputSchema: { compId, layerIndex, style: styleName },
      annotations: { destructiveHint: true },
    },
    async ({ compId: id, layerIndex: li, style }) => run(removeLayerStyleScript(id, li, style)),
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
        anchor: z
          .enum(["center", "origin"])
          .optional()
          .describe("Where the anchor ends up: center (default) = position is the text's visual centre; origin = position is the left baseline. Every call re-applies this, so pass it whenever you moved the anchor yourself."),
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
        const dir = join(tmpdir(), "brainferno-mcp-bridge", "previews");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${randomUUID()}.png`).replace(/\\/g, "/");
        await evaluateAe(bridge, renderFrameScript(id, time ?? 0, path, maxDimension ?? 1024), { timeoutClass: "slow" });
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
    async ({ compName, outputPath, templateName }) => run(queueRenderScript(compName, outputPath, templateName)),
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
        wait: waitParam(options.defaultWait ?? true, "the render"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ compName, outputPath, outputModule, renderSettings, wait }, extra) =>
      guard(async () => {
        const o: RenderCompOptions = { compName, outputPath, ...(outputModule !== undefined ? { outputModule } : {}), ...(renderSettings !== undefined ? { renderSettings } : {}) };
        if (!options.jobs) return jsonResult(await renderCompHeadless(bridge, o));
        return runOrQueue(
          options.jobs,
          "ae_render_comp",
          [{ name: "Render with aerender", recoveryTool: "ae_render_comp", run: (ctx) => renderCompHeadless(bridge, o, { signal: ctx.signal, log: ctx.log }).then((r) => (ctx.artifact(r.outputPath), r)) }],
          (results) => results[0],
          { wait: wait ?? options.defaultWait ?? true, timeoutMs: 30 * 60_000, extra: extra as ProgressExtra },
        );
      }),
  );
}
