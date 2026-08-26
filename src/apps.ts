/**
 * The five Creative Cloud hosts this server drives, and which scripting engine
 * each one exposes.
 *
 * The split matters: Photoshop and Illustrator are driven through UXP (modern
 * JS, actively supported), while After Effects, Premiere Pro, and Audition are
 * only reachable through ExtendScript (ES3 — no let/const, no arrow functions,
 * no JSON global). Scripts written for one engine will not run on the other.
 */

export const APP_IDS = ["after_effects", "premiere", "photoshop", "illustrator", "audition"] as const;

export type AppId = (typeof APP_IDS)[number];

export type ScriptEngine = "uxp" | "extendscript";

export interface AppInfo {
  id: AppId;
  /** Human-readable name, used in tool descriptions and error messages. */
  displayName: string;
  engine: ScriptEngine;
  /**
   * Application name as AppleScript sees it, for the macOS `do script` fallback.
   * Undefined where no such fallback exists.
   */
  appleScriptName?: string;
}

export const APPS: Record<AppId, AppInfo> = {
  after_effects: {
    id: "after_effects",
    displayName: "After Effects",
    engine: "extendscript",
    appleScriptName: "Adobe After Effects",
  },
  premiere: {
    id: "premiere",
    displayName: "Premiere Pro",
    engine: "extendscript",
    appleScriptName: "Adobe Premiere Pro",
  },
  audition: {
    id: "audition",
    displayName: "Audition",
    engine: "extendscript",
    appleScriptName: "Adobe Audition",
  },
  photoshop: {
    id: "photoshop",
    displayName: "Photoshop",
    engine: "uxp",
  },
  illustrator: {
    id: "illustrator",
    displayName: "Illustrator",
    engine: "uxp",
  },
};

export function appInfo(id: AppId): AppInfo {
  return APPS[id];
}
