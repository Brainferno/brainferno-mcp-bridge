import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import type { AppId } from "../apps.js";
import { APPS } from "../apps.js";
import { log } from "../logging.js";
import { removeHandshake, writeHandshake } from "./handshake.js";
import {
  PROTOCOL_VERSION,
  parsePanelFrame,
  type ServerFrame,
  type TimeoutClass,
} from "./protocol.js";
import {
  AppDisconnectedError,
  AppNotConnectedError,
  EvalTimeoutError,
  ScriptError,
  type AppBridge,
  type EvalOptions,
  type JsonValue,
} from "./types.js";

const SERVER_VERSION = "0.1.0";
const DEFAULT_AUTH_DEADLINE_MS = 3_000;
const FAST_TIMEOUT_MS = 10_000;
const MAX_MISSED_PINGS = 2;

interface Pending {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** Per-connection state. Pending calls live here, not in a shared map, so a
 * result frame can only settle a call that was issued on the *same* socket. */
interface SocketState {
  appId?: AppId;
  authed: boolean;
  authTimer: NodeJS.Timeout;
  pending: Map<string, Pending>;
  missedPings: number;
}

export interface BridgeServerOptions {
  port: number;
  /** Explicit shared secret. Ignored when `insecure` is set. */
  token: string;
  /** Disable authentication and skip the handshake file (debug/tests only). */
  insecure?: boolean;
  defaultTimeoutMs: number;
  /** Ping cadence; 0 disables the heartbeat (tests). */
  heartbeatIntervalMs?: number;
  /** How long a fresh socket has to send a valid hello before it is closed. */
  authDeadlineMs?: number;
  /** Where to write the port+token handshake file. Skipped when `insecure`. */
  handshakeFilePath?: string;
  /** Loopback only by default — this port evaluates arbitrary script. */
  host?: string;
}

/**
 * Accepts panel connections and routes commands to whichever application each
 * panel authenticated as. One panel per application; a second authenticated
 * connection for the same application replaces the first.
 *
 * Security posture (a localhost WebSocket is reachable by any local process and,
 * because browsers exempt WebSockets from the same-origin policy, by any web
 * page the user visits): the upgrade is Origin/Host-validated; every socket must
 * present a valid token in its hello within a short deadline before any other
 * frame is honored; and results are matched per-socket so one panel can never
 * settle another's in-flight call.
 */
export class BridgeServer {
  private readonly wss: WebSocketServer;
  private readonly panels = new Map<AppId, WebSocket>();
  private readonly states = new Map<WebSocket, SocketState>();
  /** Serializes commands per app: one script/modal scope per host at a time. */
  private readonly appQueues = new Map<AppId, Promise<unknown>>();
  private readonly token: string;
  private readonly insecure: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly authDeadlineMs: number;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly options: BridgeServerOptions) {
    this.insecure = options.insecure === true;
    // Resolve the effective token: an explicit one wins; otherwise generate a
    // per-process secret so the bridge is never unauthenticated by default.
    this.token = this.insecure
      ? ""
      : options.token !== ""
        ? options.token
        : randomBytes(32).toString("hex");
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.authDeadlineMs = options.authDeadlineMs ?? DEFAULT_AUTH_DEADLINE_MS;

    this.wss = new WebSocketServer({
      port: options.port,
      host: options.host ?? "127.0.0.1",
      verifyClient: (info, done) => this.verifyUpgrade(info.req, done),
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.wss.on("listening", () => this.onListening());
    this.wss.on("error", (error) => log.error("bridge server error", error));
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeat = setInterval(() => this.pingAll(), this.heartbeatIntervalMs);
      this.heartbeat.unref();
    }
  }

  /** Resolves once the listening socket is bound, or rejects if the port is taken. */
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wss.address() !== null) {
        resolve();
        return;
      }
      const onError = (error: Error) => reject(error);
      this.wss.once("listening", () => {
        this.wss.off("error", onError);
        resolve();
      });
      this.wss.once("error", onError);
    });
  }

  /** The bound port, or 0 before the server is listening. */
  port(): number {
    const address = this.wss.address();
    return address !== null && typeof address === "object" ? address.port : 0;
  }

  bridgeFor(appId: AppId): AppBridge {
    return {
      appId,
      isConnected: () => this.panels.has(appId),
      execute: (name, params, options) => this.execute(appId, name, params, options),
      evaluate: (script, options) => this.execute(appId, "eval", { script }, options),
      close: async () => {
        this.panels.get(appId)?.close();
        this.panels.delete(appId);
      },
    };
  }

  connectedApps(): AppId[] {
    return [...this.panels.keys()];
  }

  private onListening(): void {
    const host = this.options.host ?? "127.0.0.1";
    log.info(`bridge listening on ${host}:${this.port()}`);
    if (this.insecure) {
      log.warn("bridge authentication is DISABLED (insecure mode) — do not use on a shared machine");
      return;
    }
    if (this.options.handshakeFilePath !== undefined) {
      try {
        writeHandshake(this.options.handshakeFilePath, {
          protocolVersion: PROTOCOL_VERSION,
          port: this.port(),
          token: this.token,
          pid: process.pid,
        });
        log.info(`handshake written to ${this.options.handshakeFilePath}`);
      } catch (error) {
        log.error("failed to write handshake file", error);
      }
    }
  }

  private verifyUpgrade(
    req: IncomingMessage,
    done: (ok: boolean, code?: number, message?: string) => void,
  ): void {
    // Loopback binding alone does not stop a browser: reject any web Origin, and
    // any Host that is not loopback (DNS-rebinding guard).
    const origin = req.headers.origin;
    if (typeof origin === "string" && /^https?:\/\//i.test(origin)) {
      log.warn(`rejecting upgrade from web origin ${origin}`);
      done(false, 403, "forbidden origin");
      return;
    }
    const host = req.headers.host;
    if (typeof host === "string" && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      log.warn(`rejecting upgrade with non-loopback host ${host}`);
      done(false, 403, "forbidden host");
      return;
    }
    done(true);
  }

  private onConnection(socket: WebSocket): void {
    const state: SocketState = {
      authed: false,
      pending: new Map(),
      missedPings: 0,
      authTimer: setTimeout(() => {
        if (!state.authed) {
          log.warn("closing socket that did not authenticate in time");
          socket.close(4001, "authentication timeout");
        }
      }, this.authDeadlineMs),
    };
    state.authTimer.unref?.();
    this.states.set(socket, state);

    socket.on("message", (data) => this.onMessage(socket, state, data.toString()));
    socket.on("close", () => this.onClose(socket, state));
    socket.on("error", (error) => log.warn("panel socket error", error));
  }

  private onMessage(socket: WebSocket, state: SocketState, raw: string): void {
    let frame;
    try {
      frame = parsePanelFrame(raw);
    } catch (error) {
      log.warn("dropping malformed frame from panel", error);
      return;
    }

    // Any inbound frame is a sign of life.
    state.missedPings = 0;

    if (!state.authed) {
      if (frame.type !== "hello") {
        log.warn(`dropping ${frame.type} frame from unauthenticated socket`);
        socket.close(4001, "expected hello");
        return;
      }
      this.handleHello(socket, state, frame);
      return;
    }

    switch (frame.type) {
      case "result":
        this.settle(state, frame.id, frame.ok, frame.value, frame.error);
        return;
      case "progress":
        log.debug(`progress ${frame.id}: ${frame.message ?? ""} ${frame.progress ?? ""}`);
        return;
      case "ping":
        this.send(socket, { type: "ping", ts: Date.now() });
        return;
      case "pong":
        return;
      case "bye":
        log.info(`panel for "${state.appId}" said bye: ${frame.reason ?? ""}`);
        socket.close(1000, "bye");
        return;
      case "hello":
        // Already authenticated; a second hello is ignored.
        return;
    }
  }

  private handleHello(
    socket: WebSocket,
    state: SocketState,
    frame: Extract<ReturnType<typeof parsePanelFrame>, { type: "hello" }>,
  ): void {
    if (!this.insecure && this.token !== "" && frame.token !== this.token) {
      log.warn(`rejecting panel for "${frame.appId}": bad or missing token`);
      socket.close(4001, "unauthorized");
      return;
    }
    if (!(frame.appId in APPS)) {
      socket.close(4002, "unknown appId");
      return;
    }
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      log.warn(
        `panel for "${frame.appId}" speaks protocol v${frame.protocolVersion}, ` +
          `this server speaks v${PROTOCOL_VERSION}`,
      );
      socket.close(4003, "protocol version mismatch");
      return;
    }

    clearTimeout(state.authTimer);
    state.authed = true;
    state.appId = frame.appId;

    // Replace any earlier panel for this app (reconnect after a restart).
    const existing = this.panels.get(frame.appId);
    if (existing !== undefined && existing !== socket) {
      existing.close(4004, "replaced by newer connection");
    }
    this.panels.set(frame.appId, socket);

    this.send(socket, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    });
    const version = frame.hostVersion ? ` (${frame.hostVersion})` : "";
    log.info(`panel connected: ${frame.appId}${version}`);
  }

  private settle(
    state: SocketState,
    id: string,
    ok: boolean,
    value: unknown,
    error: { message: string; line?: number } | undefined,
  ): void {
    const waiting = state.pending.get(id);
    if (waiting === undefined) {
      log.debug(`result for unknown or already-settled call ${id}`);
      return;
    }
    state.pending.delete(id);
    if (waiting.timer !== undefined) clearTimeout(waiting.timer);
    if (ok) {
      waiting.resolve((value ?? null) as JsonValue);
    } else {
      const appId = state.appId ?? "after_effects";
      waiting.reject(new ScriptError(appId, error?.message ?? "script failed without a message", error?.line));
    }
  }

  private onClose(socket: WebSocket, state: SocketState): void {
    clearTimeout(state.authTimer);
    if (state.appId !== undefined && this.panels.get(state.appId) === socket) {
      this.panels.delete(state.appId);
      log.info(`panel disconnected: ${state.appId}`);
    }
    // Fail any in-flight calls rather than letting them hang to their timeout.
    for (const [, pending] of state.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new AppDisconnectedError(state.appId ?? "after_effects", "socket closed"));
    }
    state.pending.clear();
    this.states.delete(socket);
  }

  private pingAll(): void {
    for (const [socket, state] of this.states) {
      if (!state.authed) continue;
      if (state.missedPings >= MAX_MISSED_PINGS) {
        log.warn(`panel for "${state.appId}" missed ${state.missedPings} pings — terminating`);
        socket.terminate();
        continue;
      }
      state.missedPings += 1;
      this.send(socket, { type: "ping", ts: Date.now() });
    }
  }

  private execute(
    appId: AppId,
    name: string,
    params: JsonValue | undefined,
    options?: EvalOptions,
  ): Promise<JsonValue> {
    if (!this.panels.has(appId)) {
      return Promise.reject(new AppNotConnectedError(appId, this.connectHint(appId)));
    }
    // Chain behind any in-flight command for this app; look the socket up when
    // the task actually runs, so a mid-queue reconnect is handled correctly.
    const prior = this.appQueues.get(appId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.dispatch(appId, name, params, options));
    this.appQueues.set(appId, run.catch(() => {}));
    return run;
  }

  private dispatch(
    appId: AppId,
    name: string,
    params: JsonValue | undefined,
    options?: EvalOptions,
  ): Promise<JsonValue> {
    const socket = this.panels.get(appId);
    const state = socket ? this.states.get(socket) : undefined;
    if (socket === undefined || state === undefined) {
      return Promise.reject(new AppNotConnectedError(appId, this.connectHint(appId)));
    }

    const id = randomUUID();
    const timeoutClass: TimeoutClass = options?.timeoutClass ?? "slow";
    const timeoutMs = this.resolveTimeout(options, timeoutClass);

    return new Promise<JsonValue>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          state.pending.delete(id);
          reject(new EvalTimeoutError(appId, timeoutMs));
        }, timeoutMs);
      }
      state.pending.set(id, { resolve, reject, timer });
      this.send(socket, { type: "cmd", id, name, params: params ?? null, timeoutClass });
    });
  }

  private resolveTimeout(options: EvalOptions | undefined, timeoutClass: TimeoutClass): number | null {
    if (options?.timeoutMs !== undefined) return options.timeoutMs;
    switch (timeoutClass) {
      case "fast":
        return FAST_TIMEOUT_MS;
      case "slow":
        return this.options.defaultTimeoutMs;
      case "render":
        // Renders run for minutes; they rely on disconnect/heartbeat cleanup
        // until the job registry (a later phase) owns their lifecycle.
        return null;
    }
  }

  private connectHint(appId: AppId): string {
    const app = APPS[appId];
    if (app.lane === "os-script") {
      return `Open ${app.displayName}; it is driven directly and needs no panel.`;
    }
    const menu = app.panel === "uxp" ? "Plugins" : "Window > Extensions";
    return `Open ${app.displayName} and launch the adobe-cc-mcp panel from its ${menu} menu.`;
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    socket.send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    for (const state of this.states.values()) {
      clearTimeout(state.authTimer);
      for (const [, pending] of state.pending) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.reject(new AppDisconnectedError(state.appId ?? "after_effects", "bridge shutting down"));
      }
      state.pending.clear();
    }
    for (const socket of this.panels.values()) socket.close();
    this.panels.clear();
    this.states.clear();
    if (!this.insecure && this.options.handshakeFilePath !== undefined) {
      removeHandshake(this.options.handshakeFilePath);
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
