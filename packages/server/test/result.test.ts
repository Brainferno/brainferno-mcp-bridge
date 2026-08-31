import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { imageResult, setPreviewMode } from "../src/tools/result.js";

// The smallest valid PNG: 1×1 transparent pixel.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("imageResult preview modes (BRAINFERNO_MCP_PREVIEW)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "bf-preview-")), "p.png");
  writeFileSync(file, PNG);

  afterEach(() => setPreviewMode("both"));

  it("both (default): image block plus the file path as text", async () => {
    const r = await imageResult(file, "image/png", "Preview");
    expect(r.content.map((c) => c.type)).toEqual(["image", "text"]);
    expect((r.content[1] as { text: string }).text).toBe(`Preview\n${file}`);
    expect((r.content[0] as { data: string }).data).toBe(PNG.toString("base64"));
  });

  it("path: text only, for clients that cannot show the model images", async () => {
    setPreviewMode("path");
    const r = await imageResult(file, "image/png", "Preview");
    expect(r.content.map((c) => c.type)).toEqual(["text"]);
    expect((r.content[0] as { text: string }).text).toContain(file);
  });

  it("inline: image only", async () => {
    setPreviewMode("inline");
    const r = await imageResult(file, "image/png");
    expect(r.content.map((c) => c.type)).toEqual(["image"]);
  });
});
