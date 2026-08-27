/*
 * Premiere Pro command implementations for the Brainferno MCP Bridge panel.
 * Each entry is a named command (protocol v2) the server can send, built on
 * the `premierepro` UXP module (typed by @adobe/premierepro 26.3).
 *
 * Rules this file follows (docs/spikes/07-premiere-tools-live.md):
 * - Every mutation goes through project.lockedAccess + executeTransaction so a
 *   tool call is one undo step. Those callbacks are synchronous: gather every
 *   object you need with await *before* opening the transaction.
 * - Times cross the wire as seconds; TickTime only lives in here.
 * - Clips are addressed as {trackType, trackIndex, clipIndex} from pp.get_sequence.
 * - Project items are addressed by the id from pp.list_project_items (name or
 *   media path also accepted).
 *
 * Loaded before main.js; exposes window.AcmPremiereCommands.
 */
(function (global) {
  "use strict";

  const ppro = require("premierepro");
  const C = ppro.Constants;
  const T = ppro.TickTime;

  // ---- helpers -----------------------------------------------------------
  const secs = (s) => T.createWithSeconds(Number(s) || 0);
  const sec = (t) => (t && typeof t.seconds === "number" ? t.seconds : null);
  const isNum = (v) => typeof v === "number" && isFinite(v);

  /** Some option classes are constructed with `new`, some are factories. */
  function make(Ctor) {
    try {
      return new Ctor();
    } catch (e) {
      return Ctor();
    }
  }

  async function project() {
    const p = await ppro.Project.getActiveProject();
    if (!p) throw new Error("No project is open in Premiere Pro. Open one (pp_open_project) or create one in the app.");
    return p;
  }

  async function sequence(p, id) {
    if (id) {
      let s = null;
      try {
        s = p.getSequence(ppro.Guid.fromString(String(id)));
      } catch (e) {
        s = null;
      }
      if (!s) {
        // Fall back to a name match.
        const all = await p.getSequences();
        s = all.find((x) => x.name === id) || null;
      }
      if (!s) throw new Error("No sequence " + id + ". Call pp_list_sequences.");
      return s;
    }
    const s = await p.getActiveSequence();
    if (!s) throw new Error("No active sequence. Pass sequenceId, or create one with pp_create_sequence.");
    return s;
  }

  async function seqSummary(s) {
    return {
      id: String(s.guid),
      name: s.name,
      videoTracks: await s.getVideoTrackCount(),
      audioTracks: await s.getAudioTrackCount(),
      endSeconds: sec(await s.getEndTime()),
    };
  }

  /** One undo step. Throws with the host message if the transaction fails. */
  function tx(p, name, fn) {
    let ok = false;
    let err = null;
    p.lockedAccess(() => {
      try {
        ok = p.executeTransaction((ca) => fn(ca), name);
      } catch (e) {
        err = e;
      }
    });
    if (err) throw err;
    if (!ok) throw new Error(name + " failed: Premiere rejected the transaction.");
    return true;
  }

  /** Synchronous reads that Premiere wants inside lockedAccess. */
  function locked(p, fn) {
    let out;
    let err = null;
    p.lockedAccess(() => {
      try {
        out = fn();
      } catch (e) {
        err = e;
      }
    });
    if (err) throw err;
    return out;
  }

  // ---- project items -------------------------------------------------------
  async function walkItems(p) {
    const root = await p.getRootItem();
    const out = [];
    const queue = [{ folder: root, path: "" }];
    while (queue.length) {
      const cur = queue.shift();
      const items = await cur.folder.getItems();
      for (const item of items) {
        const clip = ppro.ClipProjectItem.cast(item);
        if (clip) {
          let isSeq = false;
          try {
            isSeq = await clip.isSequence();
          } catch (e) {}
          let mediaPath = null;
          if (!isSeq) {
            try {
              mediaPath = await clip.getMediaFilePath();
            } catch (e) {}
          }
          out.push({ id: item.getId(), name: item.name, kind: isSeq ? "sequence" : "clip", bin: cur.path, mediaPath, clip, raw: item });
        } else {
          const f = ppro.FolderItem.cast(item);
          if (f) {
            out.push({ id: item.getId(), name: item.name, kind: "bin", bin: cur.path, mediaPath: null, clip: null, raw: item });
            queue.push({ folder: f, path: cur.path ? cur.path + "/" + item.name : item.name });
          }
        }
      }
    }
    return out;
  }
  const pub = (e) => ({ id: e.id, name: e.name, kind: e.kind, bin: e.bin, mediaPath: e.mediaPath });

  async function findItem(p, ref) {
    const all = await walkItems(p);
    const key = String(ref);
    const norm = (s) => String(s || "").split("\\").join("/").toLowerCase();
    const hit =
      all.find((e) => e.id === key) ||
      all.find((e) => e.kind !== "bin" && e.name === key) ||
      all.find((e) => e.mediaPath && norm(e.mediaPath) === norm(key));
    if (!hit) throw new Error("No project item " + key + ". Call pp_list_project_items (or pp_import_files).");
    return hit;
  }

  // ---- tracks and clips ----------------------------------------------------
  async function clipInfo(it, index) {
    let projectItem = null;
    try {
      const pi = await it.getProjectItem();
      if (pi) projectItem = { id: pi.getId(), name: pi.name };
    } catch (e) {}
    return {
      index,
      name: await it.getName(),
      startSeconds: sec(await it.getStartTime()),
      endSeconds: sec(await it.getEndTime()),
      durationSeconds: sec(await it.getDuration()),
      inSeconds: sec(await it.getInPoint()),
      outSeconds: sec(await it.getOutPoint()),
      disabled: await it.isDisabled(),
      speed: await it.getSpeed(),
      projectItem,
    };
  }

  async function trackOf(s, type, index) {
    const t = type === "audio" ? await s.getAudioTrack(index) : await s.getVideoTrack(index);
    if (!t) throw new Error("No " + type + " track " + index + " in sequence " + s.name + ". Call pp_get_sequence.");
    return t;
  }

  async function trackClips(t) {
    return await t.getTrackItems(C.TrackItemType.CLIP, false);
  }

  async function tracks(s, type) {
    const n = type === "audio" ? await s.getAudioTrackCount() : await s.getVideoTrackCount();
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = await trackOf(s, type, i);
      const items = await trackClips(t);
      const clips = [];
      for (let j = 0; j < items.length; j++) clips.push(await clipInfo(items[j], j));
      let muted = null;
      try {
        muted = await t.isMuted();
      } catch (e) {}
      out.push({ index: i, name: t.name, muted, clips });
    }
    return out;
  }

  async function clipAt(s, ref) {
    const type = ref.trackType === "audio" ? "audio" : "video";
    const ti = ref.trackIndex || 0;
    const ci = ref.clipIndex || 0;
    const t = await trackOf(s, type, ti);
    const items = await trackClips(t);
    const it = items[ci];
    if (!it) throw new Error("No clip " + ci + " on " + type + " track " + ti + " (" + items.length + " clips). Call pp_get_sequence.");
    return it;
  }

  async function refreshedClip(s, ref) {
    try {
      const type = ref.trackType === "audio" ? "audio" : "video";
      const items = await trackClips(await trackOf(s, type, ref.trackIndex || 0));
      const ci = ref.clipIndex || 0;
      return items[ci] ? await clipInfo(items[ci], ci) : null;
    } catch (e) {
      return null;
    }
  }

  async function seqInfo(s) {
    const base = await seqSummary(s);
    let frameRate = null;
    let width = null;
    let height = null;
    try {
      const st = await s.getSettings();
      const fr = st.getVideoFrameRate();
      frameRate = fr ? fr.value : null;
    } catch (e) {}
    try {
      const r = await s.getFrameSize();
      width = r.width;
      height = r.height;
    } catch (e) {}
    return Object.assign(base, {
      frameRate,
      width,
      height,
      inSeconds: optSec(await s.getInPoint()),
      outSeconds: optSec(await s.getOutPoint()),
      playerPositionSeconds: sec(await s.getPlayerPosition()),
      video: await tracks(s, "video"),
      audio: await tracks(s, "audio"),
    });
  }

  // ---- effects -------------------------------------------------------------
  function plainValue(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return null;
    if (typeof v !== "object") return v;
    if (typeof v.x === "number" && typeof v.y === "number") return [v.x, v.y];
    if (typeof v.red === "number") return { r: v.red, g: v.green, b: v.blue, a: v.alpha };
    // Premiere hands values back wrapped ({ value: ... }, sometimes twice).
    if ("value" in v && depth < 3) return plainValue(v.value, depth + 1);
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      return String(v);
    }
  }

  /** Premiere reports "unset" times as a huge negative number. */
  function optSec(t) {
    const s = sec(t);
    return s === null || s < -100000 ? null : s;
  }

  function hostValue(v) {
    if (Array.isArray(v) && v.length === 2) return new ppro.PointF(v[0], v[1]);
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) {
      const n = parseInt(v.slice(1), 16);
      return new ppro.Color((n >> 16) & 255, (n >> 8) & 255, n & 255, 255);
    }
    return v;
  }

  async function components(p, chain) {
    const comps = locked(p, () => {
      const n = chain.getComponentCount();
      const arr = [];
      for (let i = 0; i < n; i++) {
        const c = chain.getComponentAtIndex(i);
        const pc = c.getParamCount();
        const params = [];
        for (let j = 0; j < pc; j++) {
          const q = c.getParam(j);
          let keyframes = [];
          let timeVarying = false;
          try {
            timeVarying = q.isTimeVarying();
            keyframes = q.getKeyframeListAsTickTimes().map(sec);
          } catch (e) {}
          params.push({ index: j, name: q.displayName, timeVarying, keyframes, param: q });
        }
        arr.push({ index: i, component: c, params });
      }
      return arr;
    });
    for (const c of comps) {
      c.matchName = await c.component.getMatchName();
      c.displayName = await c.component.getDisplayName();
    }
    return comps;
  }

  async function findComponent(p, chain, ref) {
    const comps = await components(p, chain);
    const key = ref === undefined || ref === null ? null : ref;
    let hit = null;
    if (typeof key === "number") hit = comps[key] || null;
    else if (typeof key === "string") {
      const k = key.toLowerCase();
      hit = comps.find((c) => c.matchName === key) || comps.find((c) => String(c.displayName).toLowerCase() === k) || null;
    }
    if (!hit) throw new Error("No effect " + key + " on this clip. Call pp_get_clip_effects (index, matchName or displayName).");
    return hit;
  }

  function findParam(comp, ref) {
    let hit = null;
    if (typeof ref === "number") hit = comp.params[ref] || null;
    else if (typeof ref === "string") {
      const k = ref.toLowerCase();
      hit = comp.params.find((q) => String(q.name).toLowerCase() === k) || null;
    }
    if (!hit) throw new Error("No parameter " + ref + " on " + comp.displayName + ". Parameters: " + comp.params.map((q) => q.name).join(", "));
    return hit;
  }

  // ---- markers -------------------------------------------------------------
  const MARKER_TYPES = {
    comment: () => ppro.Marker.MARKER_TYPE_COMMENT,
    chapter: () => ppro.Marker.MARKER_TYPE_CHAPTER,
    weblink: () => ppro.Marker.MARKER_TYPE_WEBLINK,
    cue: () => ppro.Marker.MARKER_TYPE_FLVCUEPOINT,
  };

  function markerInfo(k) {
    return {
      id: String(k.guid),
      name: k.getName(),
      type: k.getType(),
      startSeconds: sec(k.getStart()),
      durationSeconds: sec(k.getDuration()),
      comments: k.getComments(),
      colorIndex: k.getColorIndex(),
    };
  }

  // ---- command registry ----------------------------------------------------
  const commands = {
    "pp.host_info": async () => {
      const uxp = require("uxp");
      return { app: uxp.host.name, version: uxp.host.version, uxp: uxp.versions ? uxp.versions.uxp : null };
    },

    // ---- read ----
    "pp.project_info": async () => {
      const p = await project();
      const seqs = await p.getSequences();
      const active = await p.getActiveSequence();
      return {
        id: String(p.guid),
        name: p.name,
        path: p.path || null,
        sequences: seqs.length,
        activeSequence: active ? { id: String(active.guid), name: active.name } : null,
      };
    },

    "pp.list_sequences": async () => {
      const p = await project();
      const seqs = await p.getSequences();
      const out = [];
      for (const s of seqs) out.push(await seqSummary(s));
      return out;
    },

    "pp.list_project_items": async () => (await walkItems(await project())).map(pub),

    "pp.get_sequence": async (p) => seqInfo(await sequence(await project(), p.sequenceId)),

    "pp.list_markers": async (p) => {
      const s = await sequence(await project(), p.sequenceId);
      const m = await ppro.Markers.getMarkers(s);
      return m.getMarkers().map(markerInfo);
    },

    "pp.list_transitions": async () => ({ video: await ppro.TransitionFactory.getVideoTransitionMatchNames() }),

    "pp.list_effects": async () => ({
      video: await ppro.VideoFilterFactory.getMatchNames(),
      videoDisplayNames: await ppro.VideoFilterFactory.getDisplayNames(),
      audioDisplayNames: await ppro.AudioFilterFactory.getDisplayNames(),
    }),

    "pp.get_clip_effects": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const it = await clipAt(s, p);
      const chain = await it.getComponentChain();
      const comps = await components(proj, chain);
      const out = [];
      for (const c of comps) {
        const params = [];
        for (const q of c.params) {
          let value = null;
          try {
            value = plainValue(await q.param.getValueAtTime(T.TIME_ZERO));
          } catch (e) {}
          params.push({ index: q.index, name: q.name, value, timeVarying: q.timeVarying, keyframeSeconds: q.keyframes });
        }
        out.push({ index: c.index, matchName: c.matchName, displayName: c.displayName, params });
      }
      return out;
    },

    // ---- project ----
    "pp.open_project": async (p) => {
      const proj = await ppro.Project.open(p.path);
      if (!proj) throw new Error("Premiere could not open " + p.path);
      return { id: String(proj.guid), name: proj.name, path: proj.path || null };
    },

    "pp.save_project": async (p) => {
      const proj = await project();
      const ok = p.path ? await proj.saveAs(p.path) : await proj.save();
      if (!ok) throw new Error("Premiere refused to save the project" + (p.path ? " to " + p.path : ""));
      return { saved: true, path: p.path || proj.path || null };
    },

    "pp.create_project": async (p) => {
      const proj = await ppro.Project.createProject(p.path);
      if (!proj) throw new Error("Premiere could not create a project at " + p.path);
      return { id: String(proj.guid), name: proj.name, path: proj.path || null };
    },

    "pp.import_files": async (p) => {
      const proj = await project();
      const before = new Set((await walkItems(proj)).map((e) => e.id));
      // Windows Premiere wants native separators.
      const paths = p.paths.map((x) => (/^[A-Za-z]:/.test(x) ? x.split("/").join("\\") : x));
      const root = await proj.getRootItem();
      const stills = !!p.asNumberedStills;
      // The importFiles signature has shifted between builds; try the documented
      // shapes in order and report the last host error if none is accepted.
      const attempts = [
        ["paths,suppressUI,rootBin,stills", () => proj.importFiles(paths, true, root, stills)],
        ["paths,suppressUI,undefined,stills", () => proj.importFiles(paths, true, undefined, stills)],
        ["paths,suppressUI", () => proj.importFiles(paths, true)],
        ["paths", () => proj.importFiles(paths)],
      ];
      let ok = false;
      let shape = null;
      let lastErr = null;
      for (const [name, fn] of attempts) {
        try {
          ok = await fn();
          if (ok) {
            shape = name;
            break;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      if (!ok) throw new Error("Premiere refused the import of " + paths.join(", ") + (lastErr ? " (" + (lastErr.message || lastErr) + ")" : " (returned false)"));
      const after = await walkItems(proj);
      return { imported: after.filter((e) => !before.has(e.id)).map(pub), signature: shape };
    },

    "pp.create_sequence": async (p) => {
      const proj = await project();
      let s = null;
      if (p.projectItemIds && p.projectItemIds.length) {
        const clips = [];
        for (const id of p.projectItemIds) {
          const e = await findItem(proj, id);
          if (!e.clip) throw new Error(e.name + " is a bin, not a clip.");
          clips.push(e.clip);
        }
        s = await proj.createSequenceFromMedia(p.name, clips);
      } else if (p.presetPath) {
        s = await proj.createSequenceWithPresetPath(p.name, p.presetPath);
      } else {
        s = await proj.createSequence(p.name);
      }
      if (!s) throw new Error("Premiere did not create the sequence.");
      try {
        await proj.setActiveSequence(s);
      } catch (e) {}
      return await seqSummary(s);
    },

    "pp.set_active_sequence": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      await proj.setActiveSequence(s);
      try {
        await proj.openSequence(s);
      } catch (e) {}
      return await seqSummary(s);
    },

    "pp.set_player_position": async (p) => {
      const s = await sequence(await project(), p.sequenceId);
      await s.setPlayerPosition(secs(p.seconds));
      return { playerPositionSeconds: sec(await s.getPlayerPosition()) };
    },

    // ---- timeline ----
    "pp.insert_clip": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const entry = await findItem(proj, p.projectItemId);
      if (!entry.clip) throw new Error(entry.name + " is a bin, not a clip.");
      const ed = ppro.SequenceEditor.getEditor(s);
      const t = secs(p.seconds);
      const v = p.videoTrackIndex || 0;
      const a = p.audioTrackIndex || 0;
      const overwrite = p.mode === "overwrite";
      tx(proj, overwrite ? "Overwrite clip" : "Insert clip", (ca) => {
        ca.addAction(overwrite ? ed.createOverwriteItemAction(entry.raw, t, v, a) : ed.createInsertProjectItemAction(entry.raw, t, v, a, p.limitShift !== false));
      });
      // Report the clip that now starts at that time.
      let clip = null;
      for (const type of ["video", "audio"]) {
        try {
          const items = await trackClips(await trackOf(s, type, type === "video" ? v : a));
          for (let i = 0; i < items.length; i++) {
            const info = await clipInfo(items[i], i);
            if (Math.abs((info.startSeconds || 0) - (Number(p.seconds) || 0)) < 0.021) {
              clip = Object.assign({ trackType: type, trackIndex: type === "video" ? v : a, clipIndex: i }, info);
              break;
            }
          }
        } catch (e) {}
        if (clip) break;
      }
      return { inserted: true, mode: overwrite ? "overwrite" : "insert", clip, sequence: await seqSummary(s) };
    },

    "pp.remove_clips": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const items = [];
      for (const ref of p.clips) items.push(await clipAt(s, ref));
      const ed = ppro.SequenceEditor.getEditor(s);
      let done = false;
      let err = null;
      ppro.TrackItemSelection.createEmptySelection((sel) => {
        try {
          for (const it of items) sel.addItem(it, true);
          tx(proj, "Remove clips", (ca) => {
            ca.addAction(ed.createRemoveItemsAction(sel, p.ripple !== false, C.MediaType.VIDEO));
          });
          done = true;
        } catch (e) {
          err = e;
        }
      });
      if (err) throw err;
      if (!done) throw new Error("Premiere did not run the selection callback.");
      return { removed: items.length, ripple: p.ripple !== false, sequence: await seqSummary(s) };
    },

    "pp.move_clip": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const it = await clipAt(s, p);
      tx(proj, "Move clip", (ca) => ca.addAction(it.createMoveAction(secs(p.seconds))));
      return { clip: await refreshedClip(s, p) };
    },

    "pp.trim_clip": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const it = await clipAt(s, p);
      tx(proj, "Trim clip", (ca) => {
        if (isNum(p.inSeconds)) ca.addAction(it.createSetInPointAction(secs(p.inSeconds)));
        if (isNum(p.outSeconds)) ca.addAction(it.createSetOutPointAction(secs(p.outSeconds)));
        if (isNum(p.startSeconds)) ca.addAction(it.createSetStartAction(secs(p.startSeconds)));
        if (isNum(p.endSeconds)) ca.addAction(it.createSetEndAction(secs(p.endSeconds)));
      });
      return { clip: await refreshedClip(s, p) };
    },

    "pp.set_clip_props": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const it = await clipAt(s, p);
      tx(proj, "Set clip properties", (ca) => {
        if (typeof p.name === "string") ca.addAction(it.createSetNameAction(p.name));
        if (typeof p.disabled === "boolean") ca.addAction(it.createSetDisabledAction(p.disabled));
      });
      return { clip: await refreshedClip(s, p) };
    },

    "pp.add_transition": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      if (p.trackType === "audio") throw new Error("v1 adds video transitions only.");
      const it = await clipAt(s, p);
      const names = await ppro.TransitionFactory.getVideoTransitionMatchNames();
      const want = p.matchName || "";
      const match =
        names.find((n) => n === want) ||
        names.find((n) => n.toLowerCase() === want.toLowerCase()) ||
        (want ? names.find((n) => n.toLowerCase().indexOf(want.toLowerCase()) >= 0) : null) ||
        (!want ? names.find((n) => /cross ?dissolve/i.test(n)) : null);
      if (!match) throw new Error("No video transition matching " + want + ". Call pp_list_transitions.");
      const tr = await ppro.TransitionFactory.createVideoTransition(match);
      const opts = make(ppro.AddTransitionOptions);
      opts.setApplyToStart(p.position === "start");
      if (isNum(p.durationSeconds) && p.durationSeconds > 0) opts.setDuration(secs(p.durationSeconds));
      if (typeof p.singleSided === "boolean") opts.setForceSingleSided(p.singleSided);
      tx(proj, "Add transition", (ca) => ca.addAction(it.createAddVideoTransitionAction(tr, opts)));
      return { added: match, position: p.position === "start" ? "start" : "end", clip: await refreshedClip(s, p) };
    },

    "pp.apply_effect": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const it = await clipAt(s, p);
      const chain = await it.getComponentChain();
      let comp;
      let applied;
      if (p.trackType === "audio") {
        const names = await ppro.AudioFilterFactory.getDisplayNames();
        applied = names.find((n) => n === p.effect) || names.find((n) => n.toLowerCase() === String(p.effect).toLowerCase());
        if (!applied) throw new Error("No audio effect named " + p.effect + ". Call pp_list_effects (audioDisplayNames).");
        comp = await ppro.AudioFilterFactory.createComponentByDisplayName(applied, it);
      } else {
        const names = await ppro.VideoFilterFactory.getMatchNames();
        const display = await ppro.VideoFilterFactory.getDisplayNames();
        const want = String(p.effect);
        const lw = want.toLowerCase();
        // Prefer Adobe's own effect of that name over third-party packs that
        // reuse the display name (e.g. "Gaussian Blur" → "PR.ADBE Gaussian Blur",
        // not "AE.Impact_Blur_FX").
        let idx = names.indexOf(want);
        if (idx < 0) idx = names.findIndex((n) => n.toLowerCase() === "pr.adbe " + lw || n.toLowerCase() === "ae.adbe " + lw || n.toLowerCase() === "adbe " + lw);
        if (idx < 0) idx = names.findIndex((n) => n.toLowerCase().indexOf("adbe ") >= 0 && n.toLowerCase().endsWith(" " + lw));
        if (idx < 0) {
          // Display-name match: among all rows with that display name, prefer an ADBE one.
          const rows = [];
          display.forEach((n, i) => {
            if (String(n).toLowerCase() === lw) rows.push(i);
          });
          idx = rows.find((i) => /ADBE/.test(names[i] || "")) !== undefined ? rows.find((i) => /ADBE/.test(names[i] || "")) : rows.length ? rows[0] : -1;
        }
        if (idx < 0) idx = names.findIndex((n) => n.toLowerCase().indexOf(lw) >= 0);
        if (idx < 0) throw new Error("No video effect matching " + want + ". Call pp_list_effects.");
        applied = names[idx];
        comp = await ppro.VideoFilterFactory.createComponent(applied);
      }
      if (!comp) throw new Error("Premiere could not create the effect " + applied);
      tx(proj, "Apply effect", (ca) => ca.addAction(chain.createAppendComponentAction(comp)));
      const comps = await components(proj, chain);
      return { applied, components: comps.map((c) => ({ index: c.index, matchName: c.matchName, displayName: c.displayName })) };
    },

    "pp.remove_effect": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const it = await clipAt(s, p);
      const chain = await it.getComponentChain();
      const comp = await findComponent(proj, chain, p.component);
      tx(proj, "Remove effect", (ca) => ca.addAction(chain.createRemoveComponentAction(comp.component)));
      return { removed: comp.matchName };
    },

    "pp.set_effect_param": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const it = await clipAt(s, p);
      const chain = await it.getComponentChain();
      const comp = await findComponent(proj, chain, p.component);
      const q = findParam(comp, p.param);
      const value = hostValue(p.value);
      const keyed = isNum(p.seconds);
      const interp = p.interpolation === "hold" ? C.InterpolationMode.HOLD : p.interpolation === "bezier" ? C.InterpolationMode.BEZIER : p.interpolation === "linear" ? C.InterpolationMode.LINEAR : null;
      tx(proj, keyed ? "Add keyframe" : "Set effect parameter", (ca) => {
        const kf = q.param.createKeyframe(value);
        if (keyed) {
          if (!q.timeVarying) ca.addAction(q.param.createSetTimeVaryingAction(true));
          kf.position = secs(p.seconds);
          ca.addAction(q.param.createAddKeyframeAction(kf));
          if (interp !== null) ca.addAction(q.param.createSetInterpolationAtKeyframeAction(secs(p.seconds), interp));
        } else {
          if (q.timeVarying) ca.addAction(q.param.createSetTimeVaryingAction(false));
          ca.addAction(q.param.createSetValueAction(kf, true));
        }
      });
      let now = null;
      try {
        now = plainValue(await q.param.getValueAtTime(keyed ? secs(p.seconds) : T.TIME_ZERO));
      } catch (e) {}
      return { effect: comp.displayName, param: q.name, value: now, keyframed: keyed };
    },

    // ---- markers ----
    "pp.add_marker": async (p) => {
      const proj = await project();
      const s = await sequence(proj, p.sequenceId);
      const m = await ppro.Markers.getMarkers(s);
      const typeFn = MARKER_TYPES[p.type || "comment"];
      if (!typeFn) throw new Error("Marker type must be comment, chapter, weblink or cue.");
      const type = typeFn();
      tx(proj, "Add marker", (ca) => ca.addAction(m.createAddMarkerAction(p.name || "", type, secs(p.seconds), secs(p.durationSeconds || 0), p.comments || "")));
      const all = m.getMarkers().map(markerInfo);
      return { marker: all.find((k) => k.name === (p.name || "") && Math.abs((k.startSeconds || 0) - (Number(p.seconds) || 0)) < 0.021) || null, markers: all.length };
    },

    // ---- export ----
    "pp.export_frame": async (p) => {
      const s = await sequence(await project(), p.sequenceId);
      const time = isNum(p.seconds) ? secs(p.seconds) : await s.getPlayerPosition();
      const size = await s.getFrameSize();
      let w = size.width;
      let h = size.height;
      const max = p.maxDimension || 1024;
      const longest = Math.max(w, h);
      if (longest > max) {
        const k = max / longest;
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      const ok = await ppro.Exporter.exportSequenceFrame(s, time, p.baseName, p.dir, w, h);
      if (!ok) throw new Error("Premiere refused to export the frame.");
      return { started: true, dir: p.dir, baseName: p.baseName, width: w, height: h, seconds: sec(time) };
    },

    "pp.export_sequence": async (p) => {
      const s = await sequence(await project(), p.sequenceId);
      const em = ppro.EncoderManager.getManager();
      const type = p.mode === "queue_ame" ? C.ExportType.QUEUE_TO_AME : p.mode === "queue_app" ? C.ExportType.QUEUE_TO_APP : C.ExportType.IMMEDIATELY;
      const ok = await em.exportSequence(s, type, p.outputPath, p.presetPath, p.full !== false);
      if (!ok) throw new Error("Premiere refused the export (check the preset path and that the output folder exists).");
      return { started: true, mode: p.mode || "immediately", outputPath: p.outputPath, ameInstalled: !!em.isAMEInstalled };
    },
  };

  global.AcmPremiereCommands = commands;
})(typeof window !== "undefined" ? window : globalThis);
