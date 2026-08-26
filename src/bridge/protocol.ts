/**
 * Wire protocol between this server and the companion panel running inside each
 * Creative Cloud application.
 *
 * The panel is the client: it dials in to the bridge port, announces which
 * application it lives in, and then waits for scripts to evaluate. Keeping the
 * panel on the connecting side avoids asking users to open a listening socket
 * inside Photoshop.
 */

import type { AppId } from "../apps.js";

export const PROTOCOL_VERSION = 1;

/** Panel -> server, first frame on every connection. */
export interface HelloFrame {
  type: "hello";
  protocolVersion: number;
  appId: AppId;
  /** Host build string, e.g. "24.6.1" — informational only. */
  hostVersion?: string;
  /** Must match the configured shared secret when one is set. */
  token?: string;
}

/** Server -> panel, accepting or rejecting the hello. */
export interface WelcomeFrame {
  type: "welcome";
  protocolVersion: number;
}

/** Server -> panel, a script to evaluate. */
export interface EvalFrame {
  type: "eval";
  id: string;
  script: string;
}

/** Panel -> server, the outcome of one eval. */
export interface ResultFrame {
  type: "result";
  id: string;
  ok: boolean;
  /** Present when ok is true. JSON-parsed value the script returned. */
  value?: unknown;
  /** Present when ok is false. */
  error?: { message: string; line?: number };
}

export type PanelFrame = HelloFrame | ResultFrame;
export type ServerFrame = WelcomeFrame | EvalFrame;

export function parsePanelFrame(raw: string): PanelFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("frame was not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("frame was not an object");
  }
  const frame = parsed as { type?: unknown };
  if (frame.type !== "hello" && frame.type !== "result") {
    throw new Error(`unknown frame type ${JSON.stringify(frame.type)}`);
  }
  return parsed as PanelFrame;
}
