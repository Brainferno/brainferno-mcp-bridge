/**
 * node:vm standing in for After Effects behind the CEP panel (AE-16 error tests).
 *
 * It runs the panel's real `__acmStr` / `__acmJson` / `__acmEval` from the tracked
 * `packages/panel-cep/host.jsx`, and gives errors a `line` the way ExtendScript does: the line
 * inside the innermost eval'd source (spike 06). The getter returns the line of the FIRST stack
 * frame inside `eval at __acmEval` — not frame 1, because an error thrown by a stub of the object
 * model below would otherwise report the stub's own line.
 *
 * The object model is a small fake of After Effects: a project with compositions, footage and
 * folders; layers by kind (text, shape, camera, light, null, adjustment, solid, footage, precomp)
 * with their top-level property groups; effects from an installed list; layer-style slots;
 * undo-group counting; and a `mutations` log every setter and `setValue` / `addProperty` /
 * `layers.add*` appends to. File, Folder, import and render-queue objects are not modelled: a
 * test that needs one puts a stub on `ctx` or `app`.
 *
 * AE-03 adds: `items.addComp`, `items.addFolder` and `FolderItem.remove`; layer markers and the
 * comp's `markerProperty` (`setValueAtTime`, `MarkerValue`); a `changes` log whose entries name the
 * layer (`B: Opacity.setValue`); and a group-snapshot undo stack as After Effects showed it live
 * (2026-10-13, spike 06): the outermost undo group snapshots the project when it opens and pushes
 * one entry when it closes, unless nothing changed inside it (an empty group pushes nothing; "changed" is
 * read from the project's state, not only the `mutations` log, since comp fields and plain layer fields
 * have no logging setter);
 * `app.executeCommand(16)` (Edit > Undo) restores the newest entry's snapshot, `2035` (Edit > Redo)
 * re-applies it, and with nothing to undo or redo each is a silent no-op. `2371` is Edit > Purge >
 * Undo, which `findMenuCommandId("Undo")` returns: it clears the history.
 * Errors the stubs throw are built with the vm realm's Error, as a host's would be.
 *
 * Not a test file (no `.test.ts`), so vitest does not collect it on its own.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { AE_EFFECTS } from "./ae-effects-fixture.js";

export const HOST_JSX_PATH = fileURLToPath(new URL("../../panel-cep/host.jsx", import.meta.url));

/** host.jsx's own functions, CRLF-normalized (the regex raw-script.test.ts uses). */
function hostFunctions(): string {
  const src = readFileSync(HOST_JSX_PATH, "utf8").replace(/\r\n/g, "\n");
  return ["__acmStr", "__acmJson", "__acmEval"]
    .map((name) => {
      const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src);
      if (m === null) throw new Error(`host.jsx has no ${name}`);
      return m[0];
    })
    .join("\n");
}

const LINE_GETTER = String.raw`Error.stackTraceLimit = 50;
Object.defineProperty(Error.prototype, "line", { configurable: true, get: function () {
  var frames = String(this.stack).split("\n");
  for (var i = 1; i < frames.length; i++) {
    if (frames[i].indexOf("eval at __acmEval") !== -1) {
      var m = /<anonymous>:(\d+):\d+\)?\s*$/.exec(frames[i]);
      return m ? Number(m[1]) : undefined;
    }
  }
  return undefined;
} });`;

export type LayerKind = "text" | "shape" | "camera" | "light" | "null" | "adjustment" | "solid" | "footage" | "precomp";

export interface LayerSpec {
  kind: LayerKind;
  name: string;
  /** Effects already applied, by match name (display names come from the installed list). */
  effects?: string[];
  /** Masks already on the layer, by name. */
  masks?: string[];
  /** Shape layers: the names of the groups under Contents (each has match name "ADBE Vector Group"). */
  shapes?: string[];
  /**
   * Paint strokes under the layer's "ADBE Paint" effect (list it in `effects`): its "ADBE Paint Group"
   * is an INDEXED_GROUP outside __BY_NAME, and every stroke has match name "ADBE Paint Atom".
   */
  strokes?: string[];
  /** Layer styles on the layer, by key ("dropShadow", "frameFX", …); the other styles' slots are there but not added. */
  styles?: string[];
  /** Text layers: the initial text. */
  text?: string;
}

export interface CompSpec {
  id: number;
  name: string;
  layers?: LayerSpec[];
}

export interface ProjectSpec {
  comps?: CompSpec[];
  footage?: { id: number; name: string }[];
  folders?: { id: number; name: string }[];
  /** The installed effects as [matchName, displayName]; defaults to the 200+ fixture. */
  effects?: readonly (readonly [string, string])[];
}

export interface HostOptions {
  /** Delete the PropertyType global (the degraded __isLeaf path). */
  noPropertyType?: boolean;
}

export type EvalReply = { ok: true; value: unknown } | { ok: false; error: { message: string; line: number | null } };

/** The default comp the tests use: id 12 "Main" with a text, a shape and a solid layer. */
export const MAIN: CompSpec = {
  id: 12,
  name: "Main",
  layers: [
    { kind: "text", name: "Title", text: "Hello" },
    { kind: "shape", name: "Logo", shapes: ["Shape 1"] },
    { kind: "solid", name: "BG" },
  ],
};

const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6214, NAMED_GROUP: 6213 } as const;

/** Card Dance's match name in After Effects 26.5 (read live, 2026-10-10). */
export const CARD_DANCE_MATCH = "APC CardDanceCam";

const cardDance = (name: string, n: number): readonly [string, string] => [name, `${CARD_DANCE_MATCH}-${String(n).padStart(4, "0")}`];

/**
 * Card Dance's 80 parameters as After Effects 26.5 lists them (read live, 2026-10-10), as [name,
 * match name], names exactly as After Effects spells them ("Upper Left  Corner" has two spaces).
 * Each match name is "APC CardDanceCam-" and a 4-digit number that does not follow the list's order
 * (the first Offset is 0022, the eighth 0064), except the last, "Compositing Options", whose match
 * name is "ADBE Effect Built In Params" (Gaussian Blur ends with it too). Each of the 12 topics (the
 * eight transformations, Camera Position, Corner Pins, Lighting, Material) ends with a parameter
 * whose name is empty. Besides the empty name, 8 names repeat: Source, Multiplier and Offset 8 times
 * each, X/Y/Z Rotation, Z Position and Focal Length twice.
 */
export const CARD_DANCE: readonly (readonly [name: string, matchName: string])[] = [
  cardDance("Rows & Columns", 2), cardDance("Rows", 4), cardDance("Columns", 6), cardDance("Back Layer", 8),
  cardDance("Gradient Layer 1", 10), cardDance("Gradient Layer 2", 12), cardDance("Rotation Order", 14), cardDance("Transformation Order", 16),
  // The eight transformations: a topic, its Source, Multiplier and Offset, then the topic's empty-named end.
  ...(
    [
      ["X Position", 19, 18, 27],
      ["Y Position", 29, 24, 37],
      ["Z Position", 39, 30, 47],
      ["X Rotation", 49, 36, 57],
      ["Y Rotation", 59, 42, 67],
      ["Z Rotation", 69, 48, 77],
      ["X Scale", 79, 54, 87],
      ["Y Scale", 89, 60, 97],
    ] as const
  ).flatMap(([topic, at, source, end]) => [cardDance(topic, at), cardDance("Source", source), cardDance("Multiplier", source + 2), cardDance("Offset", source + 4), cardDance("", end)]),
  cardDance("Camera System", 66),
  cardDance("Camera Position", 112), cardDance("X Rotation", 68), cardDance("Y Rotation", 70), cardDance("Z Rotation", 72), cardDance("X,Y Position", 74),
  cardDance("Z Position", 76), cardDance("Focal Length", 78), cardDance("Transform Order", 80), cardDance("", 117),
  cardDance("Corner Pins", 114), cardDance("Upper Left  Corner", 82), cardDance("Upper Right Corner", 84), cardDance("Lower Left  Corner", 86),
  cardDance("Lower Right Corner", 88), cardDance("Auto Focal Length", 90), cardDance("Focal Length", 92), cardDance("", 133),
  cardDance("Lighting", 116), cardDance("Light Type", 102), cardDance("Light Intensity", 94), cardDance("Light Color", 96), cardDance("Light Position", 98),
  cardDance("Light Depth", 100), cardDance("Ambient Light", 104), cardDance("", 149),
  cardDance("Material", 118), cardDance("Diffuse Reflection", 106), cardDance("Specular Reflection", 108), cardDance("Highlight Sharpness", 110), cardDance("", 159),
  ["Compositing Options", "ADBE Effect Built In Params"],
];

/**
 * Parameters of the effects the tests address: display names (parameter i's match name is the
 * effect's, "-" and i in 4 digits) or [name, match name]; any other effect has one "Amount".
 */
const EFFECT_PARAMS: Record<string, readonly (string | readonly [string, string])[]> = {
  "ADBE Gaussian Blur 2": ["Blurriness", "Blur Dimensions", "Repeat Edge Pixels"],
  "ADBE Glo2": ["Glow Based On", "Glow Threshold", "Glow Radius", "Glow Intensity"],
  [CARD_DANCE_MATCH]: CARD_DANCE,
  // A cut-down stand-in for Particle Playground (Cannon, Grid): each name that repeats has one copy
  // among the first 10 and the other past the 20th, so a repeat check that saw only a listed window
  // (10 in a path, 20 in ae_set_effect_param) would miss it.
  "ADBE Playgnd": [
    "Cannon", "Position", "Barrel Radius", "Particles Per Second", "Direction", "Direction Random Spread", "Velocity", "Velocity Random Spread", "Color", "Particle Radius",
    "Grid", "Width", "Height", "Particles Across", "Particles Down", "Layer Exploder", "Explode Layer", "Radius of New Particles", "Dispersion Speed", "Gravity",
    "Position", "Color", "Particle Radius",
  ],
};

/** The layer-style slots every layer that can take styles has (key, display name), and the parameters each style shows. */
const LAYER_STYLES: [string, string][] = [
  ["dropShadow", "Drop Shadow"],
  ["innerShadow", "Inner Shadow"],
  ["outerGlow", "Outer Glow"],
  ["innerGlow", "Inner Glow"],
  ["bevelEmboss", "Bevel and Emboss"],
  ["chromeFX", "Satin"],
  ["solidFill", "Color Overlay"],
  ["gradientFill", "Gradient Overlay"],
  ["frameFX", "Stroke"],
];
const STYLE_PARAMS = ["Blend Mode", "Color", "Opacity", "Angle", "Distance", "Size"];

export interface AeHost {
  readonly ctx: vm.Context;
  /** The vm realm's Error, for stubs a test overrides. */
  readonly VmError: ErrorConstructor;
  readonly app: any;
  readonly mutations: string[];
  /** AE-03: what changed, naming the layer: "B: Opacity.setValue", "B: name=X", "items.addFolder __acm_batch". */
  readonly changes: string[];
  readonly undo: { begin: number; end: number };
  /** AE-03: the undo history's depth: entries Edit > Undo can reach, and entries Edit > Redo can. */
  history(): { undo: number; redo: number };
  comp(id: number): any;
  /** AE-03: the project's items by name (comps, footage, folders). */
  itemsNamed(name: string): any[];
  /** AE-03: a comp's layer names, top first, and each layer's opacity. */
  layers(id: number): { name: string; opacity: unknown }[];
  eval(script: string): EvalReply;
}

/** Edit > Undo and Edit > Redo as app.executeCommand ids (After Effects 26.5x89, live 2026-10-13). */
export const HOST_UNDO = 16;
export const HOST_REDO = 2035;
/** Edit > Purge > Undo: what findMenuCommandId("Undo") returns. It clears the history. */
export const HOST_PURGE_UNDO = 2371;

/** A fake After Effects with the panel's evaluator loaded. */
export function aeHost(spec: ProjectSpec = { comps: [MAIN] }, options: HostOptions = {}): AeHost {
  const ctx = vm.createContext({});
  vm.runInContext(LINE_GETTER, ctx);
  vm.runInContext(hostFunctions(), ctx);
  const VmError = vm.runInContext("Error", ctx) as ErrorConstructor;
  const VmArray = vm.runInContext("Array", ctx) as ArrayConstructor;
  const arr = (...xs: unknown[]): unknown[] => VmArray.of(...xs);
  const mutations: string[] = [];
  const changes: string[] = [];
  const undo = { begin: 0, end: 0 };
  /** The layer a property belongs to (set when the layer is built), for the `changes` log. */
  const ownerName = (node: any): string => (node.owner ? node.owner.name : "?");
  const installed = spec.effects ?? AE_EFFECTS;
  const displayOf = (mn: string): string => installed.find(([m]) => m === mn)?.[1] ?? mn;

  class CompItem {}
  class FolderItem {}
  class FootageItem {}
  class SolidSource {}
  class FileSource {}
  class TextDocument {
    text = "";
    private size = 72;
    get fontSize(): number {
      return this.size;
    }
    set fontSize(v: number) {
      if (v > 1296) throw new VmError("After Effects error: Value 5000 out of range 0.1 to 1296.");
      this.size = v;
    }
  }

  // ---- properties -------------------------------------------------------------
  const leaf = (matchName: string, name: string, value: unknown = 0): any => {
    const p: any = {
      matchName,
      name,
      propertyType: PropertyType.PROPERTY,
      numKeys: 0,
      expression: "",
      expressionEnabled: false,
      expressionError: "",
      value,
      setValue(v: unknown) {
        mutations.push(`${name}.setValue`);
        changes.push(`${ownerName(p)}: ${name}.setValue`);
        p.value = v;
      },
    };
    return p;
  };
  const group = (matchName: string, name: string, kids: any[], type: number = PropertyType.NAMED_GROUP, extra: Record<string, unknown> = {}): any => {
    const g: any = {
      matchName,
      name,
      propertyType: type,
      enabled: true,
      kids,
      get numProperties() {
        return kids.length;
      },
      property(k: number | string) {
        if (typeof k === "number") return kids[k - 1] ?? null;
        return kids.find((c) => c.matchName === k || c.name === k) ?? null;
      },
      ...extra,
    };
    kids.forEach((k, i) => (k.propertyIndex = i + 1));
    return g;
  };
  const effect = (mn: string, strokes: string[] = []): any =>
    group(
      mn,
      displayOf(mn),
      mn === "ADBE Paint"
        ? [
            group("ADBE Paint Group", "Strokes", strokes.map((n) => group("ADBE Paint Atom", n, [])), PropertyType.INDEXED_GROUP),
            leaf(`${mn}-0001`, "Paint on Transparent"),
          ]
        : (EFFECT_PARAMS[mn] ?? ["Amount"]).map((p, i) => (typeof p === "string" ? leaf(`${mn}-${String(i + 1).padStart(4, "0")}`, p) : leaf(p[1], p[0]))),
      PropertyType.NAMED_GROUP,
    );
  const effectParade = (names: string[], strokes: string[] = []): any => {
    const kids = names.map((n) => effect(n, strokes));
    return group("ADBE Effect Parade", "Effects", kids, PropertyType.INDEXED_GROUP, {
      canAddProperty: (name: string) => installed.some(([m]) => m === name),
      addProperty(name: string) {
        mutations.push(`addProperty ${name}`);
        const e = effect(name);
        kids.push(e);
        e.propertyIndex = kids.length;
        return e;
      },
    });
  };
  const maskParade = (names: string[]): any =>
    group("ADBE Mask Parade", "Masks", names.map((n) => group("ADBE Mask Atom", n, [])), PropertyType.INDEXED_GROUP, {
      addProperty(name: string) {
        mutations.push(`addProperty ${name}`);
        return group(name, "Mask", []);
      },
    });
  const transform = (): any =>
    group("ADBE Transform Group", "Transform", [
      leaf("ADBE Anchor Point", "Anchor Point", arr(0, 0)),
      leaf("ADBE Position", "Position", arr(960, 540)),
      leaf("ADBE Scale", "Scale", arr(100, 100)),
      leaf("ADBE Rotate Z", "Rotation", 0),
      leaf("ADBE Opacity", "Opacity", 100),
    ]);

  // ---- layers -------------------------------------------------------------------
  const MATCH: Record<LayerKind, string> = {
    text: "ADBE Text Layer",
    shape: "ADBE Vector Layer",
    camera: "ADBE Camera Layer",
    light: "ADBE Light Layer",
    null: "ADBE AV Layer",
    adjustment: "ADBE AV Layer",
    solid: "ADBE AV Layer",
    footage: "ADBE AV Layer",
    precomp: "ADBE AV Layer",
  };

  /** A marker property: setValueAtTime adds a marker (its kids, so the undo snapshot covers it). */
  const markers = (owner: () => string): any =>
    group("ADBE Marker", "Marker", [], PropertyType.NAMED_GROUP, {
      setValueAtTime(this: any, t: number, m: unknown) {
        mutations.push("marker.setValueAtTime");
        changes.push(`${owner()}: marker at ${t}`);
        this.kids.push({ time: t, value: m });
      },
    });

  const makeLayer = (comp: any, s: LayerSpec, source?: unknown): any => {
    let layerRef: any = null;
    const tops: any[] = [markers(() => (layerRef ? layerRef.name : "?"))];
    if (s.kind === "text") {
      const td = new TextDocument();
      td.text = s.text ?? "";
      tops.push(
        group("ADBE Text Properties", "Text", [
          leaf("ADBE Text Document", "Source Text", td),
          group("ADBE Text Path Options", "Path Options", []),
          group("ADBE Text More Options", "More Options", []),
          group("ADBE Text Animators", "Animators", [], PropertyType.INDEXED_GROUP),
        ]),
      );
    }
    if (s.kind === "shape") {
      tops.push(group("ADBE Root Vectors Group", "Contents", (s.shapes ?? []).map((n) => group("ADBE Vector Group", n, [])), PropertyType.INDEXED_GROUP));
    }
    if (s.kind === "camera") tops.push(group("ADBE Camera Options Group", "Camera Options", []));
    if (s.kind === "light") tops.push(group("ADBE Light Options Group", "Light Options", []));
    if (s.kind !== "camera" && s.kind !== "light") {
      tops.push(maskParade(s.masks ?? []), effectParade(s.effects ?? [], s.strokes));
    }
    tops.push(transform());
    if (s.kind !== "camera" && s.kind !== "light") {
      // Every slot is there; canSetEnabled is true only for a style actually added (what __styleGroup checks).
      const slots = LAYER_STYLES.map(([key, label]) =>
        group(`${key}/enabled`, label, STYLE_PARAMS.map((p, i) => leaf(`${key}/p${i + 1}`, p)), PropertyType.NAMED_GROUP, { canSetEnabled: (s.styles ?? []).includes(key) }),
      );
      tops.push(group("ADBE Layer Styles", "Layer Styles", slots));
    }
    const root = group(MATCH[s.kind], s.name, tops);
    // Name and parent live in one state object the undo snapshot restores without a setter.
    const st: { name: string; parent: any } = { name: s.name, parent: null };
    const solid = Object.assign(new FootageItem(), { id: 900 + comp.id, mainSource: new SolidSource() });
    const layer: any = Object.assign(root, {
      matchName: MATCH[s.kind],
      nullLayer: s.kind === "null",
      adjustmentLayer: s.kind === "adjustment",
      source: source ?? (s.kind === "solid" || s.kind === "adjustment" ? solid : s.kind === "footage" ? Object.assign(new FootageItem(), { id: 77, mainSource: new FileSource() }) : null),
      enabled: true,
      inPoint: 0,
      outPoint: 10,
      startTime: 0,
      sourceRectAtTime: () => ({ left: 0, top: -50, width: 200, height: 60 }),
    });
    // Accessors via defineProperty: Object.assign would copy a getter's value once.
    Object.defineProperty(layer, "index", { get: () => comp.layerList.indexOf(layer) + 1, enumerable: true });
    Object.defineProperty(layer, "name", {
      get: () => st.name,
      set: (v: string) => {
        mutations.push(`layer.name=${v}`);
        changes.push(`${st.name}: name=${v}`);
        st.name = v;
      },
      enumerable: true,
    });
    Object.defineProperty(layer, "parent", {
      get: () => st.parent,
      set: (v: any) => {
        mutations.push("layer.parent");
        changes.push(`${st.name}: parent=${v === null ? "null" : v.name}`);
        st.parent = v;
      },
      enumerable: true,
    });
    Object.defineProperty(layer, "_st", { value: st, enumerable: false });
    layerRef = layer;
    // Every property under the layer knows it, for the `changes` log.
    const own = (node: any): void => {
      Object.defineProperty(node, "owner", { value: layer, enumerable: false, configurable: true });
      for (const k of node.kids ?? []) if (k && typeof k === "object" && "matchName" in k) own(k);
    };
    for (const t of tops) own(t);
    return layer;
  };

  // ---- project --------------------------------------------------------------------
  const items: any[] = [];
  /** Ids for items a script adds (comps, folders): above every id a spec uses. */
  let nextId = 5000;
  const makeComp = (c: CompSpec): any => {
    const comp: any = Object.assign(new CompItem(), {
      id: c.id,
      name: c.name,
      width: 1920,
      height: 1080,
      duration: 10,
      frameRate: 30,
      pixelAspect: 1,
      layerList: [] as any[],
      layer(i: number) {
        const l = comp.layerList[i - 1];
        if (l === undefined) throw new VmError(`After Effects error: layer index ${i} out of range`);
        return l;
      },
    });
    Object.defineProperty(comp, "numLayers", { get: () => comp.layerList.length, enumerable: true });
    comp.markerProperty = markers(() => `comp ${comp.name}`);
    const add = (l: any) => {
      comp.layerList.unshift(l);
      changes.push(`${comp.name}: added ${l.name}`);
      return l;
    };
    comp.layers = {
      add(item: any) {
        mutations.push("layers.add");
        return add(makeLayer(comp, { kind: item instanceof CompItem ? "precomp" : "footage", name: item.name }, item));
      },
      addSolid(_color: unknown, name: string) {
        mutations.push("layers.addSolid");
        return add(makeLayer(comp, { kind: "solid", name }));
      },
      addText(text: string) {
        mutations.push("layers.addText");
        return add(makeLayer(comp, { kind: "text", name: text, text }));
      },
      addNull() {
        mutations.push("layers.addNull");
        return add(makeLayer(comp, { kind: "null", name: "Null 1" }));
      },
    };
    comp.layerList = (c.layers ?? []).map((l) => makeLayer(comp, l));
    return comp;
  };
  const makeFolder = (id: number, name: string): any => {
    const folder: any = Object.assign(new FolderItem(), {
      id,
      name,
      remove() {
        const at = items.indexOf(folder);
        if (at < 0) throw new VmError("After Effects error: Object is invalid");
        mutations.push("folder.remove");
        changes.push(`items.remove ${name}`);
        items.splice(at, 1);
      },
    });
    return folder;
  };
  for (const c of spec.comps ?? []) items.push(makeComp(c));
  for (const f of spec.footage ?? []) items.push(Object.assign(new FootageItem(), { id: f.id, name: f.name, mainSource: new FileSource() }));
  for (const f of spec.folders ?? []) items.push(makeFolder(f.id, f.name));

  // ---- undo history (AE-03) ---------------------------------------------------------
  // A snapshot holds the project's item list and, for every comp, its fields, its layer list, its
  // markers, and every layer's state: name, parent, plain fields, each property group's children and
  // each leaf's value.
  type Snapshot = { items: any[]; restore: (() => void)[] };
  const LAYER_FIELDS = ["enabled", "inPoint", "outPoint", "startTime", "adjustmentLayer"] as const;
  const COMP_FIELDS = ["name", "width", "height", "duration", "frameRate", "pixelAspect"] as const;
  const capture = (): Snapshot => {
    const restore: (() => void)[] = [];
    const tree = (node: any): void => {
      if (Array.isArray(node.kids)) {
        const kids = node.kids.slice();
        restore.push(() => node.kids.splice(0, node.kids.length, ...kids));
        for (const k of kids) if (k && typeof k === "object" && "matchName" in k) tree(k);
      } else if ("value" in node) {
        const v = node.value;
        restore.push(() => (node.value = v));
      }
    };
    for (const it of items) {
      if (!(it instanceof CompItem)) continue;
      const comp: any = it;
      const fields = COMP_FIELDS.map((f) => comp[f]);
      const list = comp.layerList.slice();
      restore.push(() => {
        COMP_FIELDS.forEach((f, i) => (comp[f] = fields[i]));
        comp.layerList = list.slice();
      });
      tree(comp.markerProperty);
      for (const l of list) {
        const st = { ...l._st };
        const plain = LAYER_FIELDS.map((f) => l[f]);
        restore.push(() => {
          Object.assign(l._st, st);
          LAYER_FIELDS.forEach((f, i) => (l[f] = plain[i]));
        });
        tree(l);
      }
    }
    return { items: items.slice(), restore };
  };
  /**
   * What a snapshot covers, as a string: primitives by value, objects by identity. Whether a group changed anything is
   * read from this, not from the `mutations` log alone: comp fields (ae_set_comp_props) and the plain layer fields
   * (enabled, inPoint, …) are set without a logging setter.
   */
  const ids = new WeakMap<object, number>();
  let nextObj = 0;
  const idOf = (o: unknown): string => {
    if (o === null || (typeof o !== "object" && typeof o !== "function")) return JSON.stringify(o) ?? String(o);
    let n = ids.get(o as object);
    if (n === undefined) ids.set(o as object, (n = ++nextObj));
    return `#${n}`;
  };
  const fingerprint = (): string => {
    const out: string[] = [items.map(idOf).join(",")];
    const tree = (node: any): void => {
      if (Array.isArray(node.kids)) {
        out.push(node.kids.map(idOf).join(","));
        for (const k of node.kids) if (k && typeof k === "object" && "matchName" in k) tree(k);
      } else if ("value" in node) {
        out.push(idOf(node.value));
      }
    };
    for (const it of items) {
      if (!(it instanceof CompItem)) continue;
      const comp: any = it;
      out.push(COMP_FIELDS.map((f) => idOf(comp[f])).join(","), comp.layerList.map(idOf).join(","));
      tree(comp.markerProperty);
      for (const l of comp.layerList) {
        out.push([idOf(l._st.name), idOf(l._st.parent), ...LAYER_FIELDS.map((f) => idOf(l[f]))].join(","));
        tree(l);
      }
    }
    return out.join("|");
  };
  const apply = (s: Snapshot): void => {
    items.splice(0, items.length, ...s.items);
    for (const r of s.restore) r();
  };
  const undoStack: { before: Snapshot; after: Snapshot }[] = [];
  const redoStack: { before: Snapshot; after: Snapshot }[] = [];
  let depth = 0;
  let open: { before: Snapshot; mark: number; print: string } | null = null;

  const app: any = {
    project: {
      get numItems() {
        return items.length;
      },
      item(i: number) {
        return items[i - 1] ?? null;
      },
      itemByID(id: number) {
        const it = items.find((x) => x.id === id);
        // Verified live on 26.3 and 26.5: an id no item has throws instead of returning null.
        if (it === undefined) throw new VmError("internal verification failure, sorry! {Item Not Found}");
        return it;
      },
      items: {
        addComp(name: string) {
          mutations.push("items.addComp");
          changes.push(`items.addComp ${name}`);
          const c = makeComp({ id: nextId++, name, layers: [] });
          items.push(c);
          return c;
        },
        addFolder(name: string) {
          mutations.push("items.addFolder");
          changes.push(`items.addFolder ${name}`);
          const f = makeFolder(nextId++, name);
          items.push(f);
          return f;
        },
      },
    },
    effects: installed.map(([matchName, displayName]) => ({ matchName, displayName })),
    beginUndoGroup() {
      undo.begin++;
      if (depth++ === 0) open = { before: capture(), mark: mutations.length, print: fingerprint() };
    },
    endUndoGroup() {
      undo.end++;
      if (depth === 0) return;
      if (--depth === 0 && open !== null) {
        // An empty group (nothing changed inside it) makes no undo entry (live, 2026-10-13). "Changed" is read from the
        // state as well as the log, since some setters do not log.
        if (mutations.length > open.mark || fingerprint() !== open.print) {
          undoStack.push({ before: open.before, after: capture() });
          redoStack.length = 0;
        }
        open = null;
      }
    },
    findMenuCommandId(label: string) {
      // Live, 2026-10-13: "Undo" (and "&Undo") is Edit > Purge > Undo; "Redo" finds nothing.
      return label === "Undo" || label === "&Undo" ? HOST_PURGE_UNDO : 0;
    },
    executeCommand(id: number) {
      if (id === HOST_UNDO) {
        // With nothing to undo: a silent no-op (live L3).
        const e = undoStack.pop();
        if (e === undefined) return;
        apply(e.before);
        redoStack.push(e);
      } else if (id === HOST_REDO) {
        const e = redoStack.pop();
        if (e === undefined) return;
        apply(e.after);
        undoStack.push(e);
      } else if (id === HOST_PURGE_UNDO) {
        undoStack.length = 0;
        redoStack.length = 0;
      }
    },
  };

  class MarkerValue {
    duration = 0;
    constructor(public comment: string) {}
  }

  Object.assign(ctx, { app, CompItem, FolderItem, FootageItem, SolidSource, TextDocument, MarkerValue });
  if (!options.noPropertyType) Object.assign(ctx, { PropertyType });

  return {
    ctx,
    VmError,
    app,
    mutations,
    changes,
    undo,
    history: () => ({ undo: undoStack.length, redo: redoStack.length }),
    comp: (id: number) => items.find((x: { id: number }) => x instanceof CompItem && x.id === id),
    itemsNamed: (name: string) => items.filter((x: { name: string }) => x.name === name),
    layers: (id: number) => {
      const c = items.find((x: { id: number }) => x instanceof CompItem && x.id === id);
      return c.layerList.map((l: any) => ({ name: l.name, opacity: l.property("ADBE Transform Group").property("ADBE Opacity").value }));
    },
    eval(script: string): EvalReply {
      ctx["__aeSrc"] = script;
      return JSON.parse(vm.runInContext("__acmEval(__aeSrc)", ctx) as string) as EvalReply;
    },
  };
}

/** The result frame's `error` the CEP panel would send for a failed eval: `line` omitted when absent (never null). */
export function panelReply(r: EvalReply): { code: "HOST_ERROR"; message: string; line?: number } {
  if (r.ok) throw new Error("panelReply wants a failed eval");
  return { code: "HOST_ERROR", message: r.error.message, ...(r.error.line ? { line: r.error.line } : {}) };
}
