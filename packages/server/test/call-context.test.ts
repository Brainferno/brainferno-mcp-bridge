import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { currentToolCall, runAsToolCall, withToolContext, type ToolCall } from "../src/tools/call-context.js";

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function connect(mcp: McpServer): Promise<{ client: Client; close: () => Promise<void> }> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([client.connect(ct), mcp.connect(st)]);
  return {
    client,
    close: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("withToolContext", () => {
  it("gives two concurrent calls their own tool name and arguments", async () => {
    const mcp = new McpServer({ name: "t", version: "0" });
    const server = withToolContext(mcp);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: Record<string, ToolCall | undefined> = {};
    for (const name of ["tool_a", "tool_b"]) {
      server.registerTool(name, { description: name, inputSchema: { n: z.number().describe("n") } }, async ({ n }) => {
        await gate; // both calls are in flight here at once
        await new Promise((r) => setTimeout(r, n));
        seen[name] = currentToolCall();
        return { content: [{ type: "text", text: `${name}:${n}` }] };
      });
    }
    const c = await connect(mcp);
    close = c.close;
    const a = c.client.callTool({ name: "tool_a", arguments: { n: 15 } });
    const b = c.client.callTool({ name: "tool_b", arguments: { n: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect(textOf(await a)).toBe("tool_a:15");
    expect(textOf(await b)).toBe("tool_b:1");
    expect(seen["tool_a"]).toEqual({ tool: "tool_a", args: { n: 15 } });
    expect(seen["tool_b"]).toEqual({ tool: "tool_b", args: { n: 1 } });
  });

  it("leaves args undefined for a no-echo tool and for a tool without an input schema", async () => {
    const mcp = new McpServer({ name: "t", version: "0" });
    const server = withToolContext(mcp, { noArgs: new Set(["secretive"]) });
    const seen: Record<string, ToolCall | undefined> = {};
    server.registerTool("secretive", { inputSchema: { script: z.string().describe("s") } }, async () => {
      seen["secretive"] = currentToolCall();
      return { content: [{ type: "text", text: "ok" }] };
    });
    server.registerTool("bare", { description: "no schema" }, async () => {
      seen["bare"] = currentToolCall();
      return { content: [{ type: "text", text: "ok" }] };
    });
    const c = await connect(mcp);
    close = c.close;
    await c.client.callTool({ name: "secretive", arguments: { script: "app.quit()" } });
    await c.client.callTool({ name: "bare", arguments: {} });
    expect(seen["secretive"]).toEqual({ tool: "secretive", args: undefined });
    expect(seen["bare"]).toEqual({ tool: "bare", args: undefined });
  });

  it("passes the callback's result and thrown errors through, and has no context outside a call", async () => {
    expect(currentToolCall()).toBeUndefined();
    const mcp = new McpServer({ name: "t", version: "0" });
    const server = withToolContext(mcp);
    server.registerTool("ok", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "fine" }], isError: false }));
    server.registerTool("boom", { inputSchema: {} }, async () => {
      throw new Error("kaput");
    });
    const c = await connect(mcp);
    close = c.close;
    const ok = await c.client.callTool({ name: "ok", arguments: {} });
    expect(textOf(ok)).toBe("fine");
    const boom = await c.client.callTool({ name: "boom", arguments: {} });
    expect(boom.isError).toBe(true);
    expect(textOf(boom)).toContain("kaput");
    expect(currentToolCall()).toBeUndefined();
  });

  it("echoes the validated arguments: a misspelled key never reaches the callback (M15)", async () => {
    const mcp = new McpServer({ name: "t", version: "0" });
    const server = withToolContext(mcp);
    let seen: ToolCall | undefined;
    server.registerTool(
      "typed",
      { inputSchema: { compId: z.number().describe("c"), propertyPath: z.array(z.string()).optional().describe("p") } },
      async () => {
        seen = currentToolCall();
        return { content: [{ type: "text", text: "ok" }] };
      },
    );
    const c = await connect(mcp);
    close = c.close;
    await c.client.callTool({ name: "typed", arguments: { compId: 3, propertypath: ["x"] } });
    expect(seen).toEqual({ tool: "typed", args: { compId: 3 } });
  });
});

describe("runAsToolCall", () => {
  it("scopes a context to a function and its awaits", async () => {
    const got = await runAsToolCall({ tool: "ae_batch", args: { i: 1 } }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentToolCall();
    });
    expect(got).toEqual({ tool: "ae_batch", args: { i: 1 } });
    expect(currentToolCall()).toBeUndefined();
  });
});
