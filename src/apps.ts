/**
 * The five Creative Cloud hosts this server drives: which *lane* reaches each
 * one, which in-app *panel* (if any) it needs, and which scripting *engine*
 * runs the work.
 *
 * There is no single automation surface across all five, so the server routes
 * each app down one of three lanes:
 *   - "socket":    an in-app panel dials out to the bridge hub. Photoshop and
 *                  Premiere Pro use a UXP panel; After Effects and Audition use
 *                  a CEP panel. UXP plugins cannot listen on a socket, so the
 *                  panel is always the client and the hub the server.
 *   - "os-script": no panel — the server injects ExtendScript from outside via
 *                  `osascript 'do javascript'` (macOS) or COM `DoJavaScript`
 *                  (Windows). Illustrator has no public UXP, so this is its only
 *                  complete surface.
 *
 * This mapping is deliberate and current (2026): Illustrator UXP is Adobe
 * internal-only, and Premiere's ExtendScript/CEP surface is being removed in
 * favor of UXP — so Premiere is UXP and Illustrator is os-script ExtendScript,
 * not the other way around.
 */

export const APP_IDS = ["after_effects", "premiere", "photoshop", "illustrator", "audition"] as const;

export type AppId = (typeof APP_IDS)[number];

/** How the server reaches a host. */
export type Lane = "socket" | "os-script";
/** Which in-app panel technology hosts the bridge client, when there is one. */
export type PanelKind = "uxp" | "cep";
/** Which scripting engine the host's commands ultimately run in. */
export type ScriptEngine = "uxp-batchplay" | "premierepro-api" | "extendscript";

export interface AppInfo {
  id: AppId;
  /** Human-readable name, used in tool descriptions and error messages. */
  displayName: string;
  lane: Lane;
  /** The panel that dials into the hub, for socket-lane apps. */
  panel?: PanelKind;
  engine: ScriptEngine;
  /**
   * Application name as AppleScript sees it, for the macOS os-script lane.
   * Undefined where no such lane exists.
   */
  appleScriptName?: string;
  /**
   * Windows COM ProgID for the os-script lane. Bind a versioned ProgID at
   * runtime (e.g. "Illustrator.Application.30") when multiple versions coexist.
   */
  winProgId?: string;
}

export const APPS: Record<AppId, AppInfo> = {
  after_effects: {
    id: "after_effects",
    displayName: "After Effects",
    lane: "socket",
    panel: "cep",
    engine: "extendscript",
    // os-script is a documented emergency fallback, not the primary lane.
    appleScriptName: "Adobe After Effects",
  },
  premiere: {
    id: "premiere",
    displayName: "Premiere Pro",
    lane: "socket",
    panel: "uxp",
    engine: "premierepro-api",
    // No appleScriptName / winProgId: Premiere has no AppleScript or COM DOM.
  },
  audition: {
    id: "audition",
    displayName: "Audition",
    lane: "socket",
    panel: "cep",
    engine: "extendscript",
    // No appleScriptName / winProgId: Audition has no AppleScript or COM DOM.
  },
  photoshop: {
    id: "photoshop",
    displayName: "Photoshop",
    lane: "socket",
    panel: "uxp",
    engine: "uxp-batchplay",
    // COM/AppleScript ExtendScript is a possible fallback lane, not primary.
    appleScriptName: "Adobe Photoshop",
    winProgId: "Photoshop.Application",
  },
  illustrator: {
    id: "illustrator",
    displayName: "Illustrator",
    lane: "os-script",
    engine: "extendscript",
    appleScriptName: "Adobe Illustrator",
    winProgId: "Illustrator.Application",
  },
};

export function appInfo(id: AppId): AppInfo {
  return APPS[id];
}
