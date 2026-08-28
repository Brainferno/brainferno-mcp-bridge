import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { startHttpServer, type RunningHttpServer } from "../src/http.js";

const TOKEN = "test-token-0123456789abcdef";

function sessionServer(): McpServer {
  const s = new McpServer({ name: "t", version: "0" });
  s.registerTool("ping", { title: "ping", description: "pong", inputSchema: { n: z.number() } }, async ({ n }) => ({ content: [{ type: "text", text: String(n + 1) }] }));
  return s;
}

describe("remote mode (Streamable HTTP + bearer token)", () => {
  let running: RunningHttpServer;
  let url: URL;

  beforeAll(async () => {
    running = await startHttpServer(sessionServer, { host: "127.0.0.1", port: 0, token: TOKEN });
    url = new URL(`http://127.0.0.1:${running.port}${running.path}`);
  });

  afterAll(async () => {
    await running.close();
  });

  it("refuses to start without a real token", async () => {
    await expect(startHttpServer(sessionServer, { host: "127.0.0.1", port: 0, token: "short" })).rejects.toThrow(/token/);
  });

  it("rejects requests without the token", async () => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }) });
    expect(res.status).toBe(401);
    const wrong = await fetch(url, { method: "POST", headers: { authorization: "Bearer nope-nope-nope-nope-nope", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(wrong.status).toBe(401);
    expect((await fetch(new URL("/other", url), { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it("serves a full MCP session to a client that presents the token", async () => {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } });
    const client = new Client({ name: "remote-test", version: "0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("ping");
    const r = await client.callTool({ name: "ping", arguments: { n: 41 } });
    expect((r.content as { type: string; text: string }[])[0]?.text).toBe("42");
    expect(running.sessions()).toBe(1);
    await client.close();
  });
});
