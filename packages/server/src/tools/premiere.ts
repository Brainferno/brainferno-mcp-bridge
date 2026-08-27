import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppBridge, EvalOptions, JsonValue } from "../bridge/types.js";
import { guard, imageResult, jsonResult } from "./result.js";

/**
 * Premiere Pro is driven through its UXP panel (`require("premierepro")`,
 * Premiere 25.6+). UXP has no script engine there, so — per protocol v2 —
 * these tools send *named* commands and the panel implements them against the
 * action model (`project.lockedAccess` + `executeTransaction`), one undo step
 * per tool call.
 *
 * Times are seconds. Clips are addressed as {trackType, trackIndex, clipIndex}
 * as reported by pp_get_sequence. Project items are addressed by the id from
 * pp_list_project_items (name or media path also work).
 */

const fast = { timeoutClass: "fast" as const };
const slow = { timeoutClass: "slow" as const };
const render = { timeoutClass: "render" as const };

const sequenceId = z.string().optional().describe("Sequence id (or name) from pp_list_sequences. Defaults to the active sequence.");
const clipRef = {
  trackType: z.enum(["video", "audio"]).optional().describe("Track kind. Defaults to video."),
  trackIndex: z.number().int().min(0).optional().describe("Track index, 0 = V1/A1. Defaults to 0."),
  clipIndex: z.number().int().min(0).optional().describe("Clip index on that track (left to right) from pp_get_sequence. Defaults to 0."),
};
const seconds = (what: string) => z.number().min(0).describe(`${what}, in seconds from the start of the sequence.`);

/** Folders Adobe installs encoder presets (.epr) into, plus the user's own. */
export function presetRoots(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  const roots: string[] = [];
  if (platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    roots.push(join(pf, "Adobe"));
  } else if (platform === "darwin") {
    roots.push("/Applications");
  }
  roots.push(join(home, "Documents", "Adobe", "Adobe Media Encoder"));
  return roots;
}

/** Walks a folder for .epr files (bounded depth), returning name/path/category. */
export async function findPresets(roots: string[], filter: string | undefined, limit = 200): Promise<{ name: string; path: string; category: string }[]> {
  const out: { name: string; path: string; category: string }[] = [];
  const needle = filter?.toLowerCase();
  const walk = async (dir: string, root: string, depth: number): Promise<void> => {
    if (depth > 7 || out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // Only descend into Adobe app folders and preset folders; skip everything else under Program Files/Applications.
        if (depth === 0 && !/Adobe (Premiere Pro|Media Encoder)/i.test(e.name) && !/^\d/.test(e.name)) continue;
        await walk(p, root, depth + 1);
      } else if (e.isFile() && /\.epr$/i.test(e.name)) {
        const name = e.name.replace(/\.epr$/i, "");
        if (needle !== undefined && !name.toLowerCase().includes(needle) && !p.toLowerCase().includes(needle)) continue;
        out.push({ name, path: p, category: relative(root, dir) });
      }
    }
  };
  for (const r of roots) await walk(r, r, 0);
  return out;
}

async function waitForAnyFile(paths: string[], timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastSize = -1;
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    for (const p of paths) {
      try {
        const s = await stat(p);
        if (s.size > 0) {
          if (s.size === lastSize) stable++;
          else {
            lastSize = s.size;
            stable = 0;
          }
          if (stable >= 2) return p;
        }
      } catch {
        /* not there yet */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Premiere did not write the frame within ${Math.round(timeoutMs / 1000)}s (looked for ${paths.join(", ")}).`);
}

export function registerPremiereTools(server: McpServer, bridge: AppBridge): void {
  // Params are validated by zod; JSON.stringify drops undefined optionals on the wire.
  const run = (name: string, params: unknown, opts: EvalOptions = slow) =>
    guard(async () => jsonResult(await bridge.execute(name, params as JsonValue, opts)));

  // ---- read ---------------------------------------------------------------
  server.registerTool(
    "pp_project_info",
    {
      title: "Premiere Pro: project info",
      description: "Read the open Premiere Pro project's name, path, sequence count, and active sequence.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("pp.project_info", {}, fast),
  );

  server.registerTool(
    "pp_list_sequences",
    {
      title: "Premiere Pro: list sequences",
      description: "List every sequence in the open project with its id, track counts, and length in seconds.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("pp.list_sequences", {}, fast),
  );

  server.registerTool(
    "pp_list_project_items",
    {
      title: "Premiere Pro: list project items",
      description:
        "List every item in the project panel (clips, sequences, bins) with the id the timeline tools need, " +
        "its bin path, and the media file path for clips.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("pp.list_project_items", {}, fast),
  );

  server.registerTool(
    "pp_get_sequence",
    {
      title: "Premiere Pro: get sequence",
      description:
        "Read a sequence in full: frame size, frame rate, in/out, player position, and every video and audio " +
        "track with its clips (start/end/in/out in seconds, name, disabled, project item). Clip indexes here " +
        "are what the clip tools take.",
      inputSchema: { sequenceId },
      annotations: { readOnlyHint: true },
    },
    async ({ sequenceId }) => run("pp.get_sequence", { sequenceId: sequenceId ?? null }, fast),
  );

  server.registerTool(
    "pp_list_markers",
    {
      title: "Premiere Pro: list sequence markers",
      description: "List the markers of a sequence with name, type, time, duration, comments, and color index.",
      inputSchema: { sequenceId },
      annotations: { readOnlyHint: true },
    },
    async ({ sequenceId }) => run("pp.list_markers", { sequenceId: sequenceId ?? null }, fast),
  );

  server.registerTool(
    "pp_list_transitions",
    {
      title: "Premiere Pro: list video transitions",
      description: "List the installed video transition match names (for pp_add_transition).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("pp.list_transitions", {}, fast),
  );

  server.registerTool(
    "pp_list_effects",
    {
      title: "Premiere Pro: list effects",
      description: "List the installed video effect match names and display names, and audio effect display names (for pp_apply_effect).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("pp.list_effects", {}, fast),
  );

  server.registerTool(
    "pp_get_clip_effects",
    {
      title: "Premiere Pro: get a clip's effects",
      description:
        "List the effect components on a clip (Motion, Opacity, Time Remapping, and any applied effects) with " +
        "their parameters, current values, and keyframe times. Component/parameter indexes and names feed pp_set_effect_param.",
      inputSchema: { sequenceId, ...clipRef },
      annotations: { readOnlyHint: true },
    },
    async (a) => run("pp.get_clip_effects", { sequenceId: a.sequenceId ?? null, trackType: a.trackType ?? "video", trackIndex: a.trackIndex ?? 0, clipIndex: a.clipIndex ?? 0 }, fast),
  );

  // ---- project ------------------------------------------------------------
  server.registerTool(
    "pp_open_project",
    {
      title: "Premiere Pro: open a project",
      description: "Open a .prproj file. It becomes the active project.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to a .prproj file.") },
    },
    async ({ path }) => run("pp.open_project", { path }, slow),
  );

  server.registerTool(
    "pp_save_project",
    {
      title: "Premiere Pro: save the project",
      description: "Save the active project. Pass a path to Save As.",
      inputSchema: { path: z.string().min(1).optional().describe("Absolute .prproj path for Save As. Omit to save in place.") },
    },
    async ({ path }) => run("pp.save_project", { path: path ?? null }, slow),
  );

  server.registerTool(
    "pp_import_files",
    {
      title: "Premiere Pro: import media",
      description:
        "Import media files (video, audio, images, .aep is not supported here) into the project root. " +
        "Returns the new project items with the ids the timeline tools need.",
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).describe("Absolute file paths."),
        asNumberedStills: z.boolean().optional().describe("Treat an image sequence as one clip. Defaults to false."),
      },
    },
    async ({ paths, asNumberedStills }) => run("pp.import_files", { paths, asNumberedStills: asNumberedStills ?? false }, slow),
  );

  server.registerTool(
    "pp_create_sequence",
    {
      title: "Premiere Pro: create a sequence",
      description:
        "Create a sequence and make it active. With projectItemIds the sequence takes its settings from that " +
        "media and the clips are laid in order (Premiere's 'New Sequence From Clip'). Otherwise Premiere's " +
        "default (or the given .sqpreset) settings are used and the sequence starts empty.",
      inputSchema: {
        name: z.string().min(1),
        projectItemIds: z.array(z.string().min(1)).optional().describe("Clip ids from pp_list_project_items / pp_import_files."),
        presetPath: z.string().min(1).optional().describe("Absolute path to a .sqpreset sequence preset."),
      },
    },
    async ({ name, projectItemIds, presetPath }) => run("pp.create_sequence", { name, projectItemIds: projectItemIds ?? null, presetPath: presetPath ?? null }, slow),
  );

  server.registerTool(
    "pp_set_active_sequence",
    {
      title: "Premiere Pro: set the active sequence",
      description: "Make a sequence active and open it in the timeline.",
      inputSchema: { sequenceId: z.string().min(1).describe("Sequence id (or name) from pp_list_sequences.") },
    },
    async ({ sequenceId }) => run("pp.set_active_sequence", { sequenceId }, fast),
  );

  server.registerTool(
    "pp_set_player_position",
    {
      title: "Premiere Pro: move the playhead",
      description: "Move the playhead of a sequence to a time.",
      inputSchema: { sequenceId, seconds: seconds("Playhead time") },
    },
    async ({ sequenceId, seconds }) => run("pp.set_player_position", { sequenceId: sequenceId ?? null, seconds }, fast),
  );

  // ---- timeline -----------------------------------------------------------
  server.registerTool(
    "pp_insert_clip",
    {
      title: "Premiere Pro: insert or overwrite a clip",
      description:
        "Put a project item on the timeline at a time. mode 'insert' pushes later clips right; 'overwrite' " +
        "replaces what is there. Returns the placed clip with its track/clip indexes.",
      inputSchema: {
        sequenceId,
        projectItemId: z.string().min(1).describe("Project item id (or name / media path) from pp_list_project_items."),
        seconds: seconds("Edit point"),
        videoTrackIndex: z.number().int().min(0).optional().describe("Target video track, 0 = V1. Defaults to 0."),
        audioTrackIndex: z.number().int().min(0).optional().describe("Target audio track, 0 = A1. Defaults to 0."),
        mode: z.enum(["insert", "overwrite"]).optional().describe("Defaults to insert."),
        limitShift: z.boolean().optional().describe("Insert only: shift clips on the target tracks only, not every track. Defaults to true."),
      },
    },
    async (a) =>
      run(
        "pp.insert_clip",
        {
          sequenceId: a.sequenceId ?? null,
          projectItemId: a.projectItemId,
          seconds: a.seconds,
          videoTrackIndex: a.videoTrackIndex ?? 0,
          audioTrackIndex: a.audioTrackIndex ?? 0,
          mode: a.mode ?? "insert",
          limitShift: a.limitShift ?? true,
        },
        slow,
      ),
  );

  server.registerTool(
    "pp_remove_clips",
    {
      title: "Premiere Pro: remove clips",
      description: "Remove one or more clips from the timeline. ripple (default) closes the gap.",
      inputSchema: {
        sequenceId,
        clips: z.array(z.object({ trackType: clipRef.trackType, trackIndex: clipRef.trackIndex, clipIndex: clipRef.clipIndex })).min(1),
        ripple: z.boolean().optional().describe("Close the gap. Defaults to true."),
      },
    },
    async ({ sequenceId, clips, ripple }) =>
      run(
        "pp.remove_clips",
        { sequenceId: sequenceId ?? null, clips: clips.map((c) => ({ trackType: c.trackType ?? "video", trackIndex: c.trackIndex ?? 0, clipIndex: c.clipIndex ?? 0 })), ripple: ripple ?? true },
        slow,
      ),
  );

  server.registerTool(
    "pp_move_clip",
    {
      title: "Premiere Pro: move a clip",
      description: "Move a clip so it starts at a new time on its track.",
      inputSchema: { sequenceId, ...clipRef, seconds: seconds("New start time") },
    },
    async (a) => run("pp.move_clip", { sequenceId: a.sequenceId ?? null, trackType: a.trackType ?? "video", trackIndex: a.trackIndex ?? 0, clipIndex: a.clipIndex ?? 0, seconds: a.seconds }, slow),
  );

  server.registerTool(
    "pp_trim_clip",
    {
      title: "Premiere Pro: trim a clip",
      description:
        "Trim a clip. startSeconds/endSeconds move its edges on the timeline; inSeconds/outSeconds set the " +
        "source in/out points. Give only the values you want to change.",
      inputSchema: {
        sequenceId,
        ...clipRef,
        startSeconds: z.number().min(0).optional().describe("New timeline start (left edge)."),
        endSeconds: z.number().min(0).optional().describe("New timeline end (right edge)."),
        inSeconds: z.number().min(0).optional().describe("New source in point."),
        outSeconds: z.number().min(0).optional().describe("New source out point."),
      },
    },
    async (a) =>
      run(
        "pp.trim_clip",
        {
          sequenceId: a.sequenceId ?? null,
          trackType: a.trackType ?? "video",
          trackIndex: a.trackIndex ?? 0,
          clipIndex: a.clipIndex ?? 0,
          startSeconds: a.startSeconds ?? null,
          endSeconds: a.endSeconds ?? null,
          inSeconds: a.inSeconds ?? null,
          outSeconds: a.outSeconds ?? null,
        },
        slow,
      ),
  );

  server.registerTool(
    "pp_set_clip_props",
    {
      title: "Premiere Pro: rename or disable a clip",
      description: "Rename a clip on the timeline and/or enable/disable it.",
      inputSchema: { sequenceId, ...clipRef, name: z.string().optional(), disabled: z.boolean().optional() },
    },
    async (a) =>
      run("pp.set_clip_props", { sequenceId: a.sequenceId ?? null, trackType: a.trackType ?? "video", trackIndex: a.trackIndex ?? 0, clipIndex: a.clipIndex ?? 0, name: a.name ?? null, disabled: a.disabled ?? null }, slow),
  );

  server.registerTool(
    "pp_add_transition",
    {
      title: "Premiere Pro: add a video transition",
      description: "Add a video transition (default Cross Dissolve) to the start or end of a clip.",
      inputSchema: {
        sequenceId,
        ...clipRef,
        matchName: z.string().min(1).optional().describe("Transition match name from pp_list_transitions (substring ok). Defaults to Cross Dissolve."),
        position: z.enum(["start", "end"]).optional().describe("Which edge of the clip. Defaults to end."),
        durationSeconds: z.number().positive().optional().describe("Transition length. Defaults to Premiere's preference."),
        singleSided: z.boolean().optional().describe("Force a single-sided transition even when a neighbor exists."),
      },
    },
    async (a) =>
      run(
        "pp.add_transition",
        {
          sequenceId: a.sequenceId ?? null,
          trackType: a.trackType ?? "video",
          trackIndex: a.trackIndex ?? 0,
          clipIndex: a.clipIndex ?? 0,
          matchName: a.matchName ?? null,
          position: a.position ?? "end",
          durationSeconds: a.durationSeconds ?? null,
          singleSided: a.singleSided ?? null,
        },
        slow,
      ),
  );

  server.registerTool(
    "pp_apply_effect",
    {
      title: "Premiere Pro: apply an effect",
      description:
        "Append an effect to a clip. Video: a match name or display name from pp_list_effects (e.g. 'PR.ADBE Gaussian Blur' or 'Gaussian Blur'). " +
        "Audio clips: a display name from audioDisplayNames. Then set its parameters with pp_set_effect_param.",
      inputSchema: { sequenceId, ...clipRef, effect: z.string().min(1) },
    },
    async (a) => run("pp.apply_effect", { sequenceId: a.sequenceId ?? null, trackType: a.trackType ?? "video", trackIndex: a.trackIndex ?? 0, clipIndex: a.clipIndex ?? 0, effect: a.effect }, slow),
  );

  server.registerTool(
    "pp_remove_effect",
    {
      title: "Premiere Pro: remove an effect",
      description: "Remove an effect component from a clip by index, match name, or display name (see pp_get_clip_effects).",
      inputSchema: { sequenceId, ...clipRef, component: z.union([z.number().int().min(0), z.string().min(1)]) },
    },
    async (a) => run("pp.remove_effect", { sequenceId: a.sequenceId ?? null, trackType: a.trackType ?? "video", trackIndex: a.trackIndex ?? 0, clipIndex: a.clipIndex ?? 0, component: a.component }, slow),
  );

  server.registerTool(
    "pp_set_effect_param",
    {
      title: "Premiere Pro: set an effect parameter or keyframe",
      description:
        "Set a parameter of an effect component on a clip (Motion's Position/Scale/Rotation, Opacity, or any applied effect). " +
        "Without seconds the value is static; with seconds a keyframe is added at that time. Values: number, boolean, " +
        "[x, y] for points, or a #rrggbb color.",
      inputSchema: {
        sequenceId,
        ...clipRef,
        component: z.union([z.number().int().min(0), z.string().min(1)]).describe("Component index, match name, or display name (e.g. 'Motion') from pp_get_clip_effects."),
        param: z.union([z.number().int().min(0), z.string().min(1)]).describe("Parameter index or display name (e.g. 'Scale')."),
        value: z.union([z.number(), z.boolean(), z.string(), z.tuple([z.number(), z.number()])]),
        seconds: z.number().min(0).optional().describe("Keyframe time. Omit for a static value."),
        interpolation: z.enum(["linear", "bezier", "hold"]).optional().describe("Keyframe interpolation (with seconds)."),
      },
    },
    async (a) =>
      run(
        "pp.set_effect_param",
        {
          sequenceId: a.sequenceId ?? null,
          trackType: a.trackType ?? "video",
          trackIndex: a.trackIndex ?? 0,
          clipIndex: a.clipIndex ?? 0,
          component: a.component,
          param: a.param,
          value: a.value,
          seconds: a.seconds ?? null,
          interpolation: a.interpolation ?? null,
        },
        slow,
      ),
  );

  server.registerTool(
    "pp_add_marker",
    {
      title: "Premiere Pro: add a sequence marker",
      description: "Add a marker to a sequence at a time.",
      inputSchema: {
        sequenceId,
        name: z.string().describe("Marker name."),
        seconds: seconds("Marker time"),
        durationSeconds: z.number().min(0).optional().describe("Defaults to 0."),
        comments: z.string().optional(),
        type: z.enum(["comment", "chapter", "weblink", "cue"]).optional().describe("Defaults to comment."),
      },
    },
    async (a) => run("pp.add_marker", { sequenceId: a.sequenceId ?? null, name: a.name, seconds: a.seconds, durationSeconds: a.durationSeconds ?? 0, comments: a.comments ?? "", type: a.type ?? "comment" }, slow),
  );

  // ---- export -------------------------------------------------------------
  server.registerTool(
    "pp_export_frame",
    {
      title: "Premiere Pro: export a frame",
      description: "Render one frame of a sequence to a small PNG and return it as an image so you can see the timeline. Also returns the path.",
      inputSchema: {
        sequenceId,
        seconds: z.number().min(0).optional().describe("Frame time. Defaults to the playhead."),
        maxDimension: z.number().int().min(64).max(2048).optional().describe("Longest edge in pixels. Defaults to 1024."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sequenceId, seconds, maxDimension }) =>
      guard(async () => {
        const dir = join(tmpdir(), "adobe-cc-mcp", "previews");
        await mkdir(dir, { recursive: true });
        const baseName = randomUUID();
        await bridge.execute("pp.export_frame", { sequenceId: sequenceId ?? null, seconds: seconds ?? null, dir, baseName, maxDimension: maxDimension ?? 1024 }, slow);
        // Premiere appends the extension itself; older builds doubled it.
        const written = await waitForAnyFile([join(dir, `${baseName}.png`), join(dir, `${baseName}.png.png`), join(dir, baseName)], 30_000);
        return imageResult(written, "image/png", `Frame${seconds === undefined ? " at playhead" : ` at ${seconds}s`}`);
      }),
  );

  server.registerTool(
    "pp_list_export_presets",
    {
      title: "Premiere Pro: find export presets",
      description:
        "Find encoder presets (.epr) installed with Premiere / Media Encoder and in the user's Documents, filtered " +
        "by a substring (e.g. 'Match Source - Adaptive High' for H.264, 'ProRes', 'PNG Sequence'). Feed the path to pp_export_sequence.",
      inputSchema: { filter: z.string().optional().describe("Case-insensitive substring of the preset name or folder."), limit: z.number().int().min(1).max(500).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ filter, limit }) => guard(async () => jsonResult(await findPresets(presetRoots(), filter, limit ?? 100))),
  );

  server.registerTool(
    "pp_export_sequence",
    {
      title: "Premiere Pro: export a sequence",
      description:
        "Export a sequence with an encoder preset (.epr from pp_list_export_presets). mode 'immediately' renders inside " +
        "Premiere and waits (up to 30 minutes); 'queue_ame' hands it to Media Encoder and returns at once.",
      inputSchema: {
        sequenceId,
        outputPath: z.string().min(1).describe("Absolute output path; the preset decides the format, so match the extension (e.g. .mp4 for H.264)."),
        presetPath: z.string().min(1).describe("Absolute .epr path."),
        mode: z.enum(["immediately", "queue_ame", "queue_app"]).optional().describe("Defaults to immediately."),
        full: z.boolean().optional().describe("Export the whole sequence (true, default) or only the in/out range."),
      },
    },
    async (a) =>
      guard(async () => {
        const mode = a.mode ?? "immediately";
        const info = await bridge.execute(
          "pp.export_sequence",
          { sequenceId: a.sequenceId ?? null, outputPath: a.outputPath, presetPath: a.presetPath, mode, full: a.full ?? true },
          mode === "immediately" ? { ...render, timeoutMs: 30 * 60_000 } : slow,
        );
        if (mode === "immediately") {
          // exportSequence may resolve before the file is fully flushed.
          await waitForAnyFile([a.outputPath], 120_000).catch(() => undefined);
        }
        return jsonResult(info);
      }),
  );
}
