import { describe, expect, it, vi } from "vitest";

import {
  DelegateUnavailableError,
  IllustratorDelegate,
  type DelegateClient,
} from "../src/drivers/illustrator-delegate.js";

/** A fake downstream MCP client, so tests need no HTTP or real Illustrator. */
function fakeClient(overrides: Partial<DelegateClient> = {}): DelegateClient {
  return {
    listTools: async () => ({ tools: [{ name: "analyze_document", description: "Analyze the open doc" }] }),
    callTool: async ({ name }) => ({ content: [{ type: "text" as const, text: `ran ${name}` }] }),
    close: async () => {},
    ...overrides,
  };
}

describe("IllustratorDelegate", () => {
  it("status reports available with a tool count", async () => {
    const delegate = new IllustratorDelegate({
      url: "http://x/mcp",
      token: "k",
      clientFactory: async () => fakeClient(),
    });
    expect(await delegate.status()).toEqual({ available: true, url: "http://x/mcp", toolCount: 1 });
  });

  it("listTools returns downstream names and descriptions", async () => {
    const delegate = new IllustratorDelegate({ url: "u", token: "k", clientFactory: async () => fakeClient() });
    expect(await delegate.listTools()).toEqual([{ name: "analyze_document", description: "Analyze the open doc" }]);
  });

  it("call forwards the name and arguments and returns the result verbatim", async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => ({
      content: [{ type: "text" as const, text: `ok:${name}` }],
    }));
    const delegate = new IllustratorDelegate({
      url: "u",
      token: "k",
      clientFactory: async () => fakeClient({ callTool }),
    });

    const result = await delegate.call("export_artboards", { format: "png" });

    expect(callTool).toHaveBeenCalledWith({ name: "export_artboards", arguments: { format: "png" } });
    expect(result).toEqual({ content: [{ type: "text", text: "ok:export_artboards" }] });
  });

  it("connects lazily and caches the client across calls", async () => {
    const factory = vi.fn(async () => fakeClient());
    const delegate = new IllustratorDelegate({ url: "u", token: "k", clientFactory: factory });

    await delegate.status();
    await delegate.listTools();
    await delegate.call("analyze_document", undefined);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("status is safe (never throws) when the downstream is unreachable", async () => {
    const delegate = new IllustratorDelegate({
      url: "http://down/mcp",
      token: "k",
      clientFactory: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const status = await delegate.status();
    expect(status.available).toBe(false);
    expect(status.url).toBe("http://down/mcp");
  });

  it("call rejects with an actionable DelegateUnavailableError when unreachable", async () => {
    const delegate = new IllustratorDelegate({
      url: "u",
      token: "k",
      clientFactory: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(delegate.call("analyze_document", undefined)).rejects.toBeInstanceOf(DelegateUnavailableError);
  });

  it("reconnects on the next call after a failure", async () => {
    let attempt = 0;
    const factory = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ECONNREFUSED"); // Illustrator not open yet
      return fakeClient();
    });
    const delegate = new IllustratorDelegate({ url: "u", token: "k", clientFactory: factory });

    expect((await delegate.status()).available).toBe(false);
    expect((await delegate.status()).available).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
