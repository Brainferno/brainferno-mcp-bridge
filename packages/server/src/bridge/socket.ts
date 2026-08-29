import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import type { AppId } from "@brainferno/mcp-bridge-protocol";
import { APPS } from "@brainferno/mcp-bridge-protocol";
import { log } from "../logging.js";
import { pidAlive, readHandshake, removeHandshake, writeHandshake } from "./handshake.js";
import {
  PROTOCOL_VERSION,
  parsePanelFrame,
  type ServerFrame,
  type TimeoutClass,
} from "@brainferno/mcp-bridge-protocol";
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
/** Even a "render" gets a ceiling so a silent panel cannot wedge its app queue
 * forever; the job registry (a later phase) will own long renders properly. */
const RENDER_CEILING_MS = 30 * 60_000;
/** Cap on concurrent sockets, so a local/web peer cannot exhaust FDs by churn. */
const DEFAULT_MAX_CONNECTIONS = 64;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

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
  /** Extra Origins to accept, beyond loopback origins and the no-Origin case. */
  allowedOrigins?: string[];
  /** Maximum concurrent sockets before new upgrades are refused. */
  maxConnections?: number;
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
  private wss: WebSocketServer;
  private readonly panels = new Map<AppId, WebSocket>();
  private readonly states = new Map<WebSocket, SocketState>();
  /** Serializes commands per app: one script/modal scope per host at a time. */
  private readonly appQueues = new Map<AppId, Promise<unknown>>();
  private readonly token: string;
  private readonly insecure: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly authDeadlineMs: number;
  private readonly allowedOrigins: Set<string>;
  private readonly maxConnections: number;
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
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

    this.wss = this.listen(options.port);
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeat = setInterval(() => this.pingAll(), this.heartbeatIntervalMs);
      this.heartbeat.unref();
    }
  }

  private listen(port: number): WebSocketServer {
    const wss = new WebSocketServer({
      port,
      host: this.options.host ?? "127.0.0.1",
      verifyClient: (info, done) => this.verifyUpgrade(info.req, done),
    });
    wss.on("connection", (socket) => this.onConnection(socket));
    wss.on("listening", () => this.onListening());
    return wss;
  }

  /**
   * Resolves once a listening socket is bound. If the preferred port is taken
   * (typically a stale server instance still holding it), falls back to an
   * OS-assigned port: panels discover the real port from the handshake file,
   * so a fixed port is a preference, not a requirement.
   */
  ready(): Promise<void> {
    return this.waitListening(this.wss).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE" || this.options.port === 0) throw error;
      log.warn(`port ${this.options.port} is in use (a stale server instance?) — falling back to an OS-assigned port`);
      this.wss = this.listen(0);
      return this.waitListening(this.wss);
    });
  }

  private waitListening(wss: WebSocketServer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (wss.address() !== null) {
        resolve();
        return;
      }
      const onError = (error: Error) => reject(error);
      wss.once("listening", () => {
        wss.off("error", onError);
        wss.on("error", (e) => log.error("bridge server error", e));
        resolve();
      });
      wss.once("error", onError);
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
      log.warn(
        "bridge authentication is DISABLED (insecure mode) — with auth off the Origin/Host checks are the only " +
          "gate, so any local process (and a web page via a null-origin frame) could run script in your apps; " +
          "use only for local debugging",
      );
      return;
    }
    if (this.options.handshakeFilePath !== undefined) {
      try {
        // Panels follow whatever the file says, so taking it over from a live server steals them on their next reload.
        const previous = readHandshake(this.options.handshakeFilePath);
        if (previous !== null && pidAlive(previous.pid)) {
          log.warn(
            `another bridge (pid ${previous.pid}, port ${previous.port}) already owns ${this.options.handshakeFilePath}; ` +
              "panels will connect here after they are reloaded, and that server keeps the ones it has",
          );
        }
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
    if (this.states.size >= this.maxConnections) {
      log.warn(`rejecting upgrade: ${this.states.size} connections already open`);
      done(false, 503, "too many connections");
      return;
    }
    // Loopback binding alone does not stop a browser (WebSockets are exempt from
    // the same-origin policy). Allowlist the Origin — an absent one (UXP panels
    // send none) and a loopback one are fine; a web page's Origin is always a
    // real web origin or the literal "null" (sandboxed/file/data documents),
    // neither of which is loopback, so both are rejected.
    if (!this.originAllowed(req.headers.origin)) {
      log.warn(`rejecting upgrade from origin ${JSON.stringify(req.headers.origin)}`);
      done(false, 403, "forbidden origin");
      return;
    }
    // Host must be loopback too (DNS-rebinding guard: a rebinding page sends the
    // attacker hostname here, not the resolved IP).
    const host = req.headers.host;
    if (typeof host === "string" && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      log.warn(`rejecting upgrade with non-loopback host ${host}`);
      done(false, 403, "forbidden host");
      return;
    }
    done(true);
  }

  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true; // UXP panels send no Origin header.
    // UXP panels (Photoshop 2026 on Windows, verified) send the literal
    // "file://". Browsers never send that for a local document — they send the
    // word "null" — so accepting it does not reopen the drive-by hole; the
    // token remains the real gate.
    if (origin === "file://") return true;
    if (this.allowedOrigins.has(origin)) return true;
    try {
      return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
    } catch {
      return false; // "null", "file://", or malformed — reject.
    }
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
    if (!this.insecure && !this.tokenMatches(frame.token)) {
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

  private tokenMatches(provided: string | undefined): boolean {
    if (this.token === "") return true; // insecure mode has no token
    if (provided === undefined) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    // Constant-time, and length-guarded (timingSafeEqual throws on a mismatch).
    return a.length === b.length && timingSafeEqual(a, b);
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
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new EvalTimeoutError(appId, timeoutMs));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      try {
        this.send(socket, { type: "cmd", id, name, params: params ?? null, timeoutClass });
      } catch (error) {
        clearTimeout(timer);
        state.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private resolveTimeout(options: EvalOptions | undefined, timeoutClass: TimeoutClass): number {
    if (options?.timeoutMs !== undefined) return options.timeoutMs;
    switch (timeoutClass) {
      case "fast":
        return FAST_TIMEOUT_MS;
      case "slow":
        return this.options.defaultTimeoutMs;
      case "render":
        // Renders run for minutes, but keep a generous ceiling so a silent panel
        // cannot wedge the app's command queue forever; the job registry (a
        // later phase) will own long-render lifecycles properly.
        return RENDER_CEILING_MS;
    }
  }

  private connectHint(appId: AppId): string {
    const app = APPS[appId];
    if (app.lane === "os-script") {
      return `Open ${app.displayName}; it is driven directly and needs no panel.`;
    }
    const menu = app.panel === "uxp" ? "Plugins" : "Window > Extensions";
    return `Open ${app.displayName} and launch the brainferno-mcp-bridge panel from its ${menu} menu.`;
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
