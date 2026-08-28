import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { log } from "./logging.js";

/**
 * Remote mode: the same tools over MCP's Streamable HTTP transport, for a
 * Claude on another computer. Every request must carry
 * `Authorization: Bearer <token>`; there is no anonymous path. One McpServer
 * per session, all sharing the process-wide runtime (hub, jobs, drivers).
 *
 * The wire is plain HTTP: run it on a trusted LAN, a VPN/Tailscale, or behind
 * a TLS tunnel. The Adobe panels never use this listener — they keep dialing
 * the loopback hub.
 */

export interface HttpServerOptions {
  host: string;
  port: number;
  token: string;
  /** URL path; defaults to /mcp. */
  path?: string;
}

export interface RunningHttpServer {
  host: string;
  port: number;
  path: string;
  sessions(): number;
  close(): Promise<void>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1] ?? "", "utf8");
  const want = Buffer.from(token, "utf8");
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => {
      data += d;
      if (data.length > limit) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startHttpServer(createSession: () => McpServer, o: HttpServerOptions): Promise<RunningHttpServer> {
  if (!o.token || o.token.length < 16) throw new Error("Remote mode needs a token of at least 16 characters (ADOBE_CC_MCP_HTTP_TOKEN or httpToken in ~/.adobe-cc-mcp/config.json).");
  const path = o.path ?? "/mcp";
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) return reply(res, 404, { error: "not found" });
    if (!tokenMatches(req.headers["authorization"], o.token)) {
      res.setHeader("www-authenticate", 'Bearer realm="adobe-cc-mcp"');
      return reply(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or wrong bearer token" }, id: null });
    }
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      let parsed: unknown = undefined;
      if (body !== undefined && body !== "") {
        try {
          parsed = JSON.parse(body);
        } catch {
          return reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
        }
      }
      await existing.transport.handleRequest(req, res, parsed);
      return;
    }
    if (req.method !== "POST") return reply(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "No session: send an initialize request first" }, id: null });
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    if (!isInitializeRequest(parsed)) return reply(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Unknown session id; send initialize to start one" }, id: null });
    const server = createSession();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        log.info(`remote session ${id.slice(0, 8)} opened from ${req.socket.remoteAddress ?? "?"} (${sessions.size} open)`);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) log.info(`remote session ${id.slice(0, 8)} closed (${sessions.size} open)`);
      void server.close().catch(() => undefined);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log.warn("remote request failed", e);
      if (!res.headersSent) reply(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: e instanceof Error ? e.message : String(e) }, id: null });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(o.port, o.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  log.info(`remote MCP listening on http://${o.host}:${port}${path} (bearer token required)`);

  return {
    host: o.host,
    port,
    path,
    sessions: () => sessions.size,
    close: async () => {
      for (const [id, s] of sessions) {
        sessions.delete(id);
        await s.transport.close().catch(() => undefined);
        await s.server.close().catch(() => undefined);
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
