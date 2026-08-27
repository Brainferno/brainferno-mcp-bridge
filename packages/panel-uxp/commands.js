/*
 * Photoshop command implementations for the Brainferno MCP Bridge panel.
 * Each entry is a named command (protocol v2) the server can send. Built on
 * the `photoshop` UXP module: the DOM where it has a method, batchPlay where
 * it does not, and everything that changes the document inside
 * core.executeAsModal (Photoshop refuses mutations outside it).
 *
 * Loaded before main.js; exposes window.AcmPhotoshopCommands.
 */
(function (global) {
  "use strict";

  const ps = require("photoshop");
  const { app, core, action, constants } = ps;
  const lfs = require("uxp").storage.localFileSystem;

  // ---- helpers -----------------------------------------------------------
  function modal(name, fn) {
    return core.executeAsModal(fn, { commandName: name });
  }

  function activeDoc() {
    const doc = app.activeDocument;
    if (!doc) throw new Error("No document is open. Create or open one first (ps_create_document).");
    return doc;
  }

  function docById(id) {
    if (id === null || id === undefined) return activeDoc();
    for (const d of app.documents) if (d.id === id) return d;
    throw new Error("Document " + id + " not found. Call ps_list_documents.");
  }

  function findLayer(doc, id) {
    const walk = (layers) => {
      for (const layer of layers) {
        if (layer.id === id) return layer;
        if (layer.layers) {
          const hit = walk(layer.layers);
          if (hit) return hit;
        }
      }
      return null;
    };
    const layer = walk(doc.layers);
    if (!layer) throw new Error("Layer " + id + " not found in the active document. Call ps_list_layers.");
    return layer;
  }

  function hex(color) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color || "");
    if (!m) throw new Error("Color must be hex like #ff8800");
    return { red: parseInt(m[1], 16), green: parseInt(m[2], 16), blue: parseInt(m[3], 16) };
  }
  // batchPlay spells green "grain" in RGBColor descriptors.
  const rgbDescriptor = (c) => ({ _obj: "RGBColor", red: c.red, grain: c.green, blue: c.blue });

  function fileUrl(path) {
    const p = String(path).split("\\").join("/");
    return "file:" + (p.startsWith("/") ? p : "/" + p);
  }
  const inputEntry = (path) => lfs.getEntryWithUrl(fileUrl(path));
  const outputEntry = (path) => lfs.createEntryWithUrl(fileUrl(path), { overwrite: true });

  function layerInfo(layer, depth) {
    let bounds = null;
    try {
      const b = layer.bounds;
      bounds = b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null;
    } catch (e) {
      bounds = null;
    }
    return { id: layer.id, name: layer.name, kind: String(layer.kind), visible: layer.visible, opacity: layer.opacity, depth: depth || 0, bounds };
  }

  async function batch(descriptors) {
    const results = await action.batchPlay(descriptors, { synchronousExecution: false, modalBehavior: "execute" });
    return results;
  }

  const blendModes = {
    normal: constants.BlendMode.NORMAL,
    multiply: constants.BlendMode.MULTIPLY,
    screen: constants.BlendMode.SCREEN,
    overlay: constants.BlendMode.OVERLAY,
    softLight: constants.BlendMode.SOFTLIGHT,
    hardLight: constants.BlendMode.HARDLIGHT,
    darken: constants.BlendMode.DARKEN,
    lighten: constants.BlendMode.LIGHTEN,
    difference: constants.BlendMode.DIFFERENCE,
    colorDodge: constants.BlendMode.COLORDODGE,
    colorBurn: constants.BlendMode.COLORBURN,
  };

  // ---- commands ----------------------------------------------------------
  const commands = {
    "ps.host_info": async () => {
      const uxp = require("uxp");
      return { app: uxp.host.name, version: uxp.host.version, uxpVersion: uxp.versions && uxp.versions.uxp };
    },

    "ps.list_documents": async () => {
      const docs = [];
      for (const doc of app.documents) {
        docs.push({
          id: doc.id,
          name: doc.name,
          path: doc.path || null,
          width: doc.width,
          height: doc.height,
          resolution: doc.resolution,
          mode: String(doc.mode),
          layerCount: doc.layers.length,
          active: app.activeDocument ? app.activeDocument.id === doc.id : false,
        });
      }
      return docs;
    },

    "ps.list_layers": async (p) => {
      const doc = docById(p && p.documentId);
      const out = [];
      const walk = (layers, depth) => {
        for (const layer of layers) {
          out.push(layerInfo(layer, depth));
          if (layer.layers) walk(layer.layers, depth + 1);
        }
      };
      walk(doc.layers, 0);
      return out;
    },

    "ps.create_document": async (p) =>
      modal("Create document", async () => {
        const fill = p.fill === "transparent" ? "transparent" : p.fill === "black" ? "black" : "white";
        const doc = await app.createDocument({
          width: p.width,
          height: p.height,
          resolution: p.resolution || 72,
          mode: p.mode === "grayscale" ? "grayscaleMode" : "RGBColorMode",
          fill,
          name: p.name || undefined,
        });
        return { id: doc.id, name: doc.name, width: doc.width, height: doc.height, resolution: doc.resolution };
      }),

    "ps.open_document": async (p) =>
      modal("Open document", async () => {
        const entry = await inputEntry(p.path);
        const doc = await app.open(entry);
        return { id: doc.id, name: doc.name, width: doc.width, height: doc.height, layerCount: doc.layers.length };
      }),

    "ps.save_document": async (p) =>
      modal("Save document", async () => {
        const doc = activeDoc();
        if (p.path) {
          const entry = await outputEntry(p.path);
          await doc.saveAs.psd(entry, { embedColorProfile: true }, false);
          return { path: entry.nativePath, saved: true };
        }
        if (!doc.path) throw new Error("This document has never been saved — pass a path ending in .psd.");
        await doc.save();
        return { path: doc.path, saved: true };
      }),

    "ps.export": async (p) =>
      modal("Export copy", async () => {
        const doc = activeDoc();
        const entry = await outputEntry(p.path);
        if (p.format === "jpg") await doc.saveAs.jpg(entry, { quality: p.quality == null ? 10 : p.quality, embedColorProfile: true }, true);
        else await doc.saveAs.png(entry, { compression: 6 }, true);
        return { path: entry.nativePath, format: p.format };
      }),

    "ps.preview": async (p) =>
      modal("Preview", async () => {
        const doc = activeDoc();
        const max = p.maxDimension || 1024;
        const copy = await doc.duplicate();
        try {
          const longest = Math.max(copy.width, copy.height);
          if (longest > max) {
            const s = max / longest;
            await copy.resizeImage(Math.round(copy.width * s), Math.round(copy.height * s));
          }
          await copy.flatten();
          const entry = await outputEntry(p.path);
          await copy.saveAs.png(entry, { compression: 6 }, true);
          return { path: entry.nativePath, width: copy.width, height: copy.height, sourceWidth: doc.width, sourceHeight: doc.height };
        } finally {
          await copy.closeWithoutSaving();
        }
      }),

    "ps.create_layer": async (p) =>
      modal("Create layer", async () => {
        const doc = activeDoc();
        const layer = p.kind === "group" ? await doc.createLayerGroup({ name: p.name || undefined }) : await doc.createLayer({ name: p.name || undefined });
        return layerInfo(layer, 0);
      }),

    "ps.create_text_layer": async (p) =>
      modal("Create text layer", async () => {
        const doc = activeDoc();
        const c = hex(p.color || "#000000");
        const before = new Set([...doc.layers].map((l) => l.id));
        await batch([
          {
            _obj: "make",
            _target: [{ _ref: "textLayer" }],
            using: {
              _obj: "textLayer",
              textKey: p.text,
              textClickPoint: {
                _obj: "paint",
                horizontal: { _unit: "percentUnit", _value: (p.x / doc.width) * 100 },
                vertical: { _unit: "percentUnit", _value: (p.y / doc.height) * 100 },
              },
              textStyleRange: [
                {
                  _obj: "textStyleRange",
                  from: 0,
                  to: p.text.length,
                  textStyle: {
                    _obj: "textStyle",
                    fontPostScriptName: p.font || "ArialMT",
                    size: { _unit: "pointsUnit", _value: p.fontSize || 48 },
                    color: rgbDescriptor(c),
                  },
                },
              ],
            },
            _options: { dialogOptions: "dontDisplay" },
          },
        ]);
        let layer = doc.activeLayers && doc.activeLayers[0];
        if (!layer || before.has(layer.id)) layer = [...doc.layers].find((l) => !before.has(l.id)) || layer;
        if (!layer) throw new Error("Text layer was not created");
        if (p.name) layer.name = p.name;
        return layerInfo(layer, 0);
      }),

    "ps.set_layer_props": async (p) =>
      modal("Set layer properties", async () => {
        const doc = activeDoc();
        const layer = findLayer(doc, p.layerId);
        if (p.name !== undefined && p.name !== null) layer.name = p.name;
        if (p.visible !== undefined && p.visible !== null) layer.visible = p.visible;
        if (p.opacity !== undefined && p.opacity !== null) layer.opacity = p.opacity;
        if (p.blendMode) layer.blendMode = blendModes[p.blendMode] || layer.blendMode;
        if (p.locked !== undefined && p.locked !== null) layer.allLocked = p.locked;
        return layerInfo(layer, 0);
      }),

    "ps.move_layer": async (p) =>
      modal("Move layer", async () => {
        const doc = activeDoc();
        const layer = findLayer(doc, p.layerId);
        await layer.translate(p.dx, p.dy);
        return layerInfo(layer, 0);
      }),

    "ps.duplicate_layer": async (p) =>
      modal("Duplicate layer", async () => {
        const doc = activeDoc();
        const layer = findLayer(doc, p.layerId);
        const copy = await layer.duplicate();
        if (p.name) copy.name = p.name;
        return layerInfo(copy, 0);
      }),

    "ps.delete_layer": async (p) =>
      modal("Delete layer", async () => {
        const doc = activeDoc();
        const layer = findLayer(doc, p.layerId);
        const name = layer.name;
        await layer.delete();
        return { deleted: name };
      }),

    "ps.place_image": async (p) =>
      modal("Place image", async () => {
        const doc = activeDoc();
        const entry = await inputEntry(p.path);
        const token = await lfs.createSessionToken(entry);
        const before = new Set([...doc.layers].map((l) => l.id));
        await batch([
          {
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
            offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
            _options: { dialogOptions: "dontDisplay" },
          },
        ]);
        let layer = doc.activeLayers && doc.activeLayers[0];
        if (!layer || before.has(layer.id)) layer = [...doc.layers].find((l) => !before.has(l.id)) || layer;
        if (!layer) throw new Error("Image was not placed");
        if (p.name) layer.name = p.name;
        return layerInfo(layer, 0);
      }),

    "ps.fill": async (p) =>
      modal("Fill", async () => {
        const doc = activeDoc();
        if (p.layerId !== null && p.layerId !== undefined) {
          const layer = findLayer(doc, p.layerId);
          doc.activeLayers = [layer];
        }
        const hasRect = [p.left, p.top, p.right, p.bottom].every((v) => typeof v === "number");
        if (hasRect) await doc.selection.selectRectangle({ left: p.left, top: p.top, right: p.right, bottom: p.bottom }, constants.SelectionType.REPLACE);
        else await doc.selection.selectAll();
        const c = hex(p.color);
        await batch([
          {
            _obj: "fill",
            using: { _enum: "fillContents", _value: "color" },
            color: rgbDescriptor(c),
            opacity: { _unit: "percentUnit", _value: 100 },
            mode: { _enum: "blendMode", _value: "normal" },
            _options: { dialogOptions: "dontDisplay" },
          },
        ]);
        await doc.selection.selectAll();
        await batch([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }]);
        return { filled: p.color, rect: hasRect ? { left: p.left, top: p.top, right: p.right, bottom: p.bottom } : "all" };
      }),

    "ps.apply_filter": async (p) =>
      modal("Apply filter", async () => {
        const doc = activeDoc();
        const layer = findLayer(doc, p.layerId);
        doc.activeLayers = [layer];
        // Filters need pixels. A text or smart-object layer would make Photoshop
        // pop a "rasterize?" dialog, which blocks every command until someone
        // clicks it — so rasterize first, silently.
        const kind = String(layer.kind);
        if (kind === "text" || kind === "smartObject") {
          await batch([
            { _obj: "rasterizeLayer", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], _options: { dialogOptions: "dontDisplay" } },
          ]);
        }
        let d;
        if (p.filter === "gaussianBlur") d = { _obj: "gaussianBlur", radius: { _unit: "pixelsUnit", _value: p.radius || 10 } };
        else if (p.filter === "motionBlur") d = { _obj: "motionBlur", angle: p.angle || 0, distance: { _unit: "pixelsUnit", _value: p.distance || 30 } };
        else d = { _obj: "unsharpMask", amount: { _unit: "percentUnit", _value: p.amount || 100 }, radius: { _unit: "pixelsUnit", _value: p.radius || 2 }, threshold: p.threshold || 0 };
        d._options = { dialogOptions: "dontDisplay" };
        await batch([d]);
        return { applied: p.filter, layer: layerInfo(layer, 0) };
      }),

    "ps.resize_image": async (p) =>
      modal("Resize image", async () => {
        const doc = activeDoc();
        let w = p.width, h = p.height;
        if (w && !h) h = Math.round((doc.height * w) / doc.width);
        if (h && !w) w = Math.round((doc.width * h) / doc.height);
        if (!w && !h) throw new Error("Give width and/or height");
        await doc.resizeImage(w, h, p.resolution || undefined);
        return { width: doc.width, height: doc.height, resolution: doc.resolution };
      }),

    "ps.crop": async (p) =>
      modal("Crop", async () => {
        const doc = activeDoc();
        await doc.crop({ left: p.left, top: p.top, right: p.right, bottom: p.bottom });
        return { width: doc.width, height: doc.height };
      }),

    "ps.batch_play": async (p) => modal("batchPlay", async () => batch(p.descriptors)),
  };

  global.AcmPhotoshopCommands = commands;
})(typeof window !== "undefined" ? window : globalThis);
