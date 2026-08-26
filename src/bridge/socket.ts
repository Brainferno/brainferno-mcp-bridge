import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import type { AppId } from "../apps.js";
import { APPS } from "../apps.js";
import { log } from "../logging.js";
import { PROTOCOL_VERSION, parsePanelFrame, type ServerFrame } from "./protocol.js";
import {
  AppNotConnectedError,
  EvalTimeoutError,
  ScriptError,
  type AppBridge,
  type EvalOptions,
  type JsonValue,
} from "./types.js";

interface Pending {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeServerOptions {
  port: number;
  /** Shared secret panels must present. Empty string disables the check. */
  token: string;
  defaultTimeoutMs: number;
  /** Loopback only by default — this port evaluates arbitrary script in the host. */
  host?: string;
}

/**
 * Accepts panel connections and routes scripts to whichever application each
 * panel reported. One panel per application; a second connection for the same
 * application replaces the first, since a reconnect after an app restart is far
 * more common than genuinely wanting two.
 */
export class BridgeServer {
  private readonly wss: WebSocketServer;
  private readonly panels = new Map<AppId, WebSocket>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: BridgeServerOptions) {
    this.wss = new WebSocketServer({
      port: options.port,
      host: options.host ?? "127.0.0.1",
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.wss.on("listening", () => {
      log.info(`bridge listening on ${options.host ?? "127.0.0.1"}:${options.port}`);
    });
    this.wss.on("error", (error) => log.error("bridge server error", error));
  }

  /** Resolves once the listening socket is bound, or rejects if the port is taken. */
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.wss.address() !== null) {
        resolve();
        return;
      }
      this.wss.once("listening", () => resolve());
      this.wss.once("error", reject);
    });
  }

  bridgeFor(appId: AppId): AppBridge {
    return {
      appId,
      isConnected: () => this.panels.has(appId),
      evaluate: (script, evalOptions) => this.evaluate(appId, script, evalOptions),
      close: async () => {
        this.panels.get(appId)?.close();
        this.panels.delete(appId);
      },
    };
  }

  connectedApps(): AppId[] {
    return [...this.panels.keys()];
  }

  private onConnection(socket: WebSocket): void {
    let appId: AppId | undefined;

    socket.on("message", (data) => {
      let frame;
      try {
        frame = parsePanelFrame(data.toString());
      } catch (error) {
        log.warn("dropping malformed frame from panel", error);
        return;
      }

      if (frame.type === "hello") {
        if (this.options.token !== "" && frame.token !== this.options.token) {
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
        appId = frame.appId;
        this.panels.get(appId)?.close(4004, "replaced by newer connection");
        this.panels.set(appId, socket);
        this.send(socket, { type: "welcome", protocolVersion: PROTOCOL_VERSION });
        log.info(`panel connected: ${appId}${frame.hostVersion ? ` (${frame.hostVersion})` : ""}`);
        return;
      }

      // frame.type === "result"
      const waiting = this.pending.get(frame.id);
      if (waiting === undefined) {
        log.debug(`result for unknown or already-timed-out call ${frame.id}`);
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(waiting.timer);
      if (frame.ok) {
        waiting.resolve((frame.value ?? null) as JsonValue);
      } else {
        waiting.reject(
          new ScriptError(
            appId ?? "after_effects",
            frame.error?.message ?? "script failed without a message",
            frame.error?.line,
          ),
        );
      }
    });

    socket.on("close", () => {
      if (appId !== undefined && this.panels.get(appId) === socket) {
        this.panels.delete(appId);
        log.info(`panel disconnected: ${appId}`);
      }
    });

    socket.on("error", (error) => log.warn("panel socket error", error));
  }

  private evaluate(appId: AppId, script: string, evalOptions?: EvalOptions): Promise<JsonValue> {
    const socket = this.panels.get(appId);
    if (socket === undefined) {
      return Promise.reject(
        new AppNotConnectedError(
          appId,
          `Open ${APPS[appId].displayName} and launch the adobe-cc-mcp panel from its Window > Extensions menu.`,
        ),
      );
    }

    const id = randomUUID();
    const timeoutMs = evalOptions?.timeoutMs ?? this.options.defaultTimeoutMs;

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EvalTimeoutError(appId, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(socket, { type: "eval", id, script });
    });
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    socket.send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("bridge shutting down"));
    }
    this.pending.clear();
    for (const socket of this.panels.values()) socket.close();
    this.panels.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
