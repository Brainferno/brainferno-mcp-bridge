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

/**
 * Card Dance's parameters as After Effects lists them (63; the match name of parameter i is
 * "ADBE Card Dance-" and i in 4 digits): eight transformations (X/Y/Z Position, X/Y/Z Rotation,
 * X/Y Scale), each a header then Source, Multiplier and Offset, and later the camera's X/Y/Z
 * Rotation, Z Position and Focal Length again. So 8 names repeat: Source, Multiplier and Offset 8
 * times each (Offset is 12, 16, ... 40), the other five twice.
 */
export const CARD_DANCE: readonly string[] = [
  "Rows & Columns", "Rows", "Columns", "Back Layer", "Gradient Layer 1", "Gradient Layer 2", "Rotation Order", "Transformation Order",
  ...["X Position", "Y Position", "Z Position", "X Rotation", "Y Rotation", "Z Rotation", "X Scale", "Y Scale"].flatMap((axis) => [axis, "Source", "Multiplier", "Offset"]),
  "Camera System", "X Rotation", "Y Rotation", "Z Rotation", "X, Y Position", "Z Position", "Focal Length", "Transform Order",
  "Upper Left Corner", "Upper Right Corner", "Lower Left Corner", "Lower Right Corner", "Auto Focal Length", "Focal Length",
  "Light Type", "Light Intensity", "Light Color", "Light Position", "Light Depth", "Ambient Light",
  "Diffuse Reflection", "Specular Reflection", "Highlight Sharpness",
];

/** Parameters (display names) of the effects the tests address; any other effect has one "Amount". */
const EFFECT_PARAMS: Record<string, readonly string[]> = {
  "ADBE Gaussian Blur 2": ["Blurriness", "Blur Dimensions", "Repeat Edge Pixels"],
  "ADBE Glo2": ["Glow Based On", "Glow Threshold", "Glow Radius", "Glow Intensity"],
  "ADBE Card Dance": CARD_DANCE,
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
  readonly undo: { begin: number; end: number };
  comp(id: number): any;
  eval(script: string): EvalReply;
}

/** A fake After Effects with the panel's evaluator loaded. */
export function aeHost(spec: ProjectSpec = { comps: [MAIN] }, options: HostOptions = {}): AeHost {
  const ctx = vm.createContext({});
  vm.runInContext(LINE_GETTER, ctx);
  vm.runInContext(hostFunctions(), ctx);
  const VmError = vm.runInContext("Error", ctx) as ErrorConstructor;
  const VmArray = vm.runInContext("Array", ctx) as ArrayConstructor;
  const arr = (...xs: unknown[]): unknown[] => VmArray.of(...xs);
  const mutations: string[] = [];
  const undo = { begin: 0, end: 0 };
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
        : (EFFECT_PARAMS[mn] ?? ["Amount"]).map((p, i) => leaf(`${mn}-${String(i + 1).padStart(4, "0")}`, p)),
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

  const makeLayer = (comp: any, s: LayerSpec, source?: unknown): any => {
    const tops: any[] = [group("ADBE Marker", "Marker", [])];
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
    let name = s.name;
    let parent: any = null;
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
      get: () => name,
      set: (v: string) => {
        mutations.push(`layer.name=${v}`);
        name = v;
      },
      enumerable: true,
    });
    Object.defineProperty(layer, "parent", {
      get: () => parent,
      set: (v: unknown) => {
        mutations.push("layer.parent");
        parent = v;
      },
      enumerable: true,
    });
    return layer;
  };

  // ---- project --------------------------------------------------------------------
  const items: any[] = [];
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
    const add = (l: any) => {
      comp.layerList.unshift(l);
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
  for (const c of spec.comps ?? []) items.push(makeComp(c));
  for (const f of spec.footage ?? []) items.push(Object.assign(new FootageItem(), { id: f.id, name: f.name, mainSource: new FileSource() }));
  for (const f of spec.folders ?? []) items.push(Object.assign(new FolderItem(), { id: f.id, name: f.name }));

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
        // Verified live on 26.3: an id no item has throws instead of returning null.
        if (it === undefined) throw new VmError("internal verification failure, sorry! {Item Not Found}");
        return it;
      },
    },
    effects: installed.map(([matchName, displayName]) => ({ matchName, displayName })),
    beginUndoGroup() {
      undo.begin++;
    },
    endUndoGroup() {
      undo.end++;
    },
  };

  Object.assign(ctx, { app, CompItem, FolderItem, FootageItem, SolidSource, TextDocument });
  if (!options.noPropertyType) Object.assign(ctx, { PropertyType });

  return {
    ctx,
    VmError,
    app,
    mutations,
    undo,
    comp: (id: number) => items.find((x: { id: number }) => x instanceof CompItem && x.id === id),
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
