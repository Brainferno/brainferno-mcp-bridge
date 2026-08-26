/**
 * Wire protocol (v2) between this server's hub and the companion panel running
 * inside each Creative Cloud application.
 *
 * The panel is the client: it dials in to the bridge port, announces which
 * application it lives in (and authenticates), then waits for commands. Keeping
 * the panel on the connecting side is not a preference — UXP plugins cannot
 * listen on a socket, only dial out — and it keeps the one listener the whole
 * system trusts on the server side, where it can be hardened.
 *
 * Commands are *named*, not raw script: the server sends `{name, params}` and
 * the panel maps the name to a local function. UXP restricts `eval`, and the
 * Premiere UXP API has no script engine at all, so shipping script strings does
 * not work there. The generic `eval` command (params `{script}`) is the escape
 * hatch panels on an ExtendScript engine implement via `evalScript`, which is a
 * host API rather than JS `eval`.
 *
 * Every panel->server frame is validated against a zod schema before use; the
 * hub never trusts the shape of a frame from the wire.
 */

import { z } from "zod";

import { APP_IDS } from "../apps.js";

export const PROTOCOL_VERSION = 2;

/** How long the server will wait for a command result, by command weight. */
export type TimeoutClass = "fast" | "slow" | "render";

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  line: z.number().int().optional(),
});

const appStateSchema = z.object({
  activeDocument: z.string().nullable().optional(),
  selection: z.unknown().optional(),
  dirty: z.boolean().optional(),
});

/** Panel -> server, the first frame on every connection (within the deadline). */
export const helloFrameSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  appId: z.enum(APP_IDS),
  /** Host build string, e.g. "24.6.1" — informational. */
  hostVersion: z.string().optional(),
  /** Panel plugin version, so the server can detect version drift. */
  panelVersion: z.string().optional(),
  /** Shared secret; may instead ride the upgrade URL as `?token=`. */
  token: z.string().optional(),
  /** Command names this panel implements, for capability gating. */
  capabilities: z.array(z.string()).optional(),
});

/** Panel -> server, the outcome of one command. */
export const resultFrameSchema = z.object({
  type: z.literal("result"),
  id: z.string(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: errorSchema.optional(),
  /** Cheap state snapshot returned on mutations, to keep the agent oriented. */
  appState: appStateSchema.optional(),
});

/** Panel -> server, incremental progress for a long-running command. */
export const progressFrameSchema = z.object({
  type: z.literal("progress"),
  id: z.string(),
  progress: z.number().optional(),
  total: z.number().optional(),
  message: z.string().optional(),
});

/** Panel -> server, liveness. */
export const pongFrameSchema = z.object({ type: z.literal("pong"), ts: z.number().optional() });
export const pingFrameSchema = z.object({ type: z.literal("ping"), ts: z.number().optional() });

/** Panel -> server, graceful shutdown (e.g. the kill switch was engaged). */
export const byeFrameSchema = z.object({ type: z.literal("bye"), reason: z.string().optional() });

const panelFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  resultFrameSchema,
  progressFrameSchema,
  pongFrameSchema,
  pingFrameSchema,
  byeFrameSchema,
]);

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type ResultFrame = z.infer<typeof resultFrameSchema>;
export type ProgressFrame = z.infer<typeof progressFrameSchema>;
export type PanelFrame = z.infer<typeof panelFrameSchema>;

/** Server -> panel, accepting the hello. */
export interface WelcomeFrame {
  type: "welcome";
  protocolVersion: number;
  serverVersion: string;
  heartbeatIntervalMs: number;
}

/** Server -> panel, a named command to run. */
export interface CmdFrame {
  type: "cmd";
  id: string;
  name: string;
  params: unknown;
  timeoutClass: TimeoutClass;
}

export interface ServerPingFrame {
  type: "ping";
  ts: number;
}

export interface ServerByeFrame {
  type: "bye";
  reason: string;
}

export type ServerFrame = WelcomeFrame | CmdFrame | ServerPingFrame | ServerByeFrame;

/**
 * Parses and validates a raw text frame from a panel. Throws a descriptive
 * Error on anything that is not a well-formed panel frame — callers drop the
 * frame rather than trusting a partially-shaped object.
 */
export function parsePanelFrame(raw: string): PanelFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("frame was not valid JSON");
  }
  const result = panelFrameSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid panel frame: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}
