import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppDisconnectedError, ScriptError } from "../src/bridge/types.js";
import { log } from "../src/logging.js";
import { setRedactionSecrets } from "../src/tools/echo.js";
import { guard, imageResult, jobErrorMessage, scriptErrorText, setPreviewMode } from "../src/tools/result.js";

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

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const NEXT_BODY = "check the values the line marked >>> uses (ae_get_comp and ae_get_layer show what exists), then retry";

describe("scriptErrorText (AE-16)", () => {
  afterEach(() => {
    setRedactionSecrets([]);
    vi.restoreAllMocks();
  });

  it("legacy: a ScriptError without details reads exactly as before, wire code or not", () => {
    expect(scriptErrorText(new ScriptError("illustrator", "x"))).toBe("Script failed in illustrator: x");
    expect(scriptErrorText(new ScriptError("photoshop", "No open document", 3, { code: "HOST_ERROR" }))).toBe(
      "Script failed in photoshop (line 3): No open document",
    );
  });

  it("legacy: the text is not redacted or reflowed (byte-identical)", () => {
    setRedactionSecrets(["configured-secret-value"]);
    const message = "has configured-secret-value\nand a newline";
    expect(scriptErrorText(new ScriptError("premiere", message, 2))).toBe(`Script failed in premiere (line 2): ${message}`);
  });

  it("UNKNOWN_COMMAND says the panel is older than the server, for any app", () => {
    expect(
      scriptErrorText(new ScriptError("photoshop", "panel does not implement ps.list_layer_comps", undefined, { code: "UNKNOWN_COMMAND" })),
    ).toBe(
      "The Photoshop panel does not support this command (panel does not implement ps.list_layer_comps) \u2014 it is older than this server; " +
        "update the brainferno-mcp-bridge panel (or reload it after updating), then retry.",
    );
  });

  it("UNKNOWN_COMMAND keeps the panel's text on one line and redacts it first (F9)", () => {
    const secret = "abc \tDEF\r\nghijkl";
    setRedactionSecrets([secret]);
    const e = new ScriptError("premiere", `panel does not implement\r\npp.x\u001b[2J‮ (${secret})`, undefined, { code: "UNKNOWN_COMMAND" });
    expect(scriptErrorText(e)).toBe(
      "The Premiere Pro panel does not support this command (panel does not implement pp.x [2J ([redacted])) — it is older than this server; " +
        "update the brainferno-mcp-bridge panel (or reload it after updating), then retry.",
    );
  });

  it("enriched body: tool, where, message, next step, code excerpt", () => {
    const e = new ScriptError("after_effects", "boom", 352, {
      code: "HOST_ERROR",
      where: "body",
      bodyLine: 3,
      tool: "ae_list_compositions",
      args: "{}",
      excerpt: [
        "2: for (var i = 1; i <= app.project.numItems; i++) {",
        ">>> 3: var item = app.project.item(i);",
        "4: if (item instanceof CompItem) { comps.push(__compInfo(item)); }",
      ],
      next: NEXT_BODY,
    });
    expect(scriptErrorText(e)).toBe(
      `Script failed in After Effects (ae_list_compositions) at body line 3 (script line 352): boom \u2014 ${NEXT_BODY}. ` +
        "Code: 2: for (var i = 1; i <= app.project.numItems; i++) { | >>> 3: var item = app.project.item(i); | 4: if (item instanceof CompItem) { comps.push(__compInfo(item)); }",
    );
  });

  it("enriched helper: args echo, no next step when the message already has one", () => {
    const message =
      'Layer index 9 is out of range (1..3) in "Main" (id 12): 1 "Title" (text), 2 "Logo" (shape), 3 "BG" (solid) \u2014 pass one of these indexes (ae_get_comp lists every layer).';
    const e = new ScriptError("after_effects", message, 186, { where: "helper", helper: "__layer", tool: "ae_get_layer", args: "{compId: 12, layerIndex: 9}" });
    expect(scriptErrorText(e)).toBe(`Script failed in After Effects (ae_get_layer, args {compId: 12, layerIndex: 9}) in helper __layer (script line 186): ${message}`);
  });

  it("enriched outside and unknown, and no tool context (pipelines)", () => {
    const outside = new ScriptError("after_effects", "After Effects error: Text document not of Box document type", 40, {
      where: "outside",
      tool: "ae_get_keyframes",
      args: "{compId: 32}",
      next: "read it another way",
    });
    expect(scriptErrorText(outside)).toBe(
      "Script failed in After Effects (ae_get_keyframes, args {compId: 32}) at script line 40, outside this tool's own code " +
        "(most likely while the panel converted the result to JSON): After Effects error: Text document not of Box document type \u2014 read it another way.",
    );
    expect(scriptErrorText(new ScriptError("after_effects", "odd", undefined, { where: "unknown", next: "retry" }))).toBe(
      "Script failed in After Effects: odd \u2014 retry.",
    );
    expect(scriptErrorText(new ScriptError("after_effects", "No file at C:\\x.png \u2014 pass a path.", 350, { where: "body", bodyLine: 2 }))).toBe(
      "Script failed in After Effects at body line 2 (script line 350): No file at C:\\x.png \u2014 pass a path.",
    );
  });

  it("keeps one paragraph: line breaks in the message collapse; a trailing period gives way to the next step", () => {
    const e = new ScriptError("after_effects", "first\nsecond\u2028third.", 5, { where: "unknown", next: "do this" });
    expect(scriptErrorText(e)).toBe("Script failed in After Effects: first second third \u2014 do this.");
  });

  it("orders message, next step, suggestions, note, code; lists 1, 2 or 3 suggestions", () => {
    const base = { where: "body" as const, bodyLine: 5, excerpt: [">>> 5: x;"], note: "Names must match exactly, case included.", next: "n" };
    const one = new ScriptError("after_effects", "m", 9, { ...base, suggestions: [{ name: "A" }] });
    expect(scriptErrorText(one)).toBe(
      'Script failed in After Effects at body line 5 (script line 9): m \u2014 n. Did you mean "A"? Names must match exactly, case included. Code: >>> 5: x;',
    );
    const two = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "A", label: "Alpha" }, { name: "B" }] });
    expect(scriptErrorText(two)).toBe('Script failed in After Effects: m Did you mean "A" (Alpha) or "B"?');
    const three = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "A" }, { name: "B" }, { name: "C" }] });
    expect(scriptErrorText(three)).toBe('Script failed in After Effects: m Did you mean "A", "B" or "C"?');
  });

  it("redacts known secrets in the host message but keeps project names (M13), and caps it", () => {
    setRedactionSecrets(["configured-secret-value"]);
    const message =
      'No composition with id 9; the project has 1: 12 "Instagram_Story_1080x1920_v02_FINAL" configured-secret-value \u2014 pass one of these compIds.';
    const text = scriptErrorText(new ScriptError("after_effects", message, 171, { where: "helper", helper: "__comp" }));
    expect(text).toContain('"Instagram_Story_1080x1920_v02_FINAL"');
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("configured-secret-value");
    const long = scriptErrorText(new ScriptError("after_effects", "x".repeat(2000), 5, { where: "unknown" }));
    expect(long).toBe(`Script failed in After Effects: ${"x".repeat(1500)}\u2026(+500 chars)`);
  });

  it("redacts before it reflows: a secret holding a tab is still found in the message, note and suggestions (R8)", () => {
    // A lone tab reflows to exactly the registered blanked form (one space), so this case passes in
    // either order; the next test is the one that pins the order.
    const secret = "abc\tDEFghijkl";
    setRedactionSecrets([secret]);
    const e = new ScriptError("after_effects", `Unable to find "${secret}" here`, 5, {
      where: "unknown",
      suggestions: [{ name: secret, label: `the ${secret} one` }],
      note: `note ${secret}`,
    });
    const text = scriptErrorText(e);
    expect(text).not.toContain("DEFghijkl");
    expect(text).toBe('Script failed in After Effects: Unable to find "[redacted]" here Did you mean "[redacted]" (the [redacted] one)? note [redacted]');
  });

  it("redacts before it reflows, where reflowing would change the secret: whitespace beside a control character, CRLF, a bidi override (R8, F3)", () => {
    // oneLine turns " \t" and "\r\n" into one space each and drops U+202E; the registered forms keep
    // a space per control character and keep U+202E. So only redact-then-reflow finds these, in each
    // of the message, the note, a suggestion's name and its label.
    for (const [secret, tail] of [
      ["abc \tDEF\r\nghijkl", "ghijkl"],
      ["abc‮DEFghijkl", "DEFghijkl"],
    ] as const) {
      setRedactionSecrets([secret]);
      const parts = {
        message: new ScriptError("after_effects", `x ${secret} y`, 5, { where: "unknown" }),
        note: new ScriptError("after_effects", "m", 5, { where: "unknown", note: `note ${secret}` }),
        name: new ScriptError("after_effects", "m", 5, { where: "unknown", suggestions: [{ name: secret }] }),
        label: new ScriptError("after_effects", "m", 5, { where: "unknown", suggestions: [{ name: "A", label: `the ${secret} one` }] }),
      };
      const expected = {
        message: "Script failed in After Effects: x [redacted] y",
        note: "Script failed in After Effects: m note [redacted]",
        name: 'Script failed in After Effects: m Did you mean "[redacted]"?',
        label: 'Script failed in After Effects: m Did you mean "A" (the [redacted] one)?',
      };
      for (const part of ["message", "note", "name", "label"] as const) {
        const text = scriptErrorText(parts[part]);
        expect(text, `${part}: ${JSON.stringify(secret)}`).not.toContain(tail);
        expect(text, `${part}: ${JSON.stringify(secret)}`).toBe(expected[part]);
      }
    }
  });

  it("escapes a suggestion name the way the host lists do, so a quote in it cannot fake another name (R9)", () => {
    const vinyl = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: 'Vinyl 12" Label' }] });
    expect(scriptErrorText(vinyl)).toBe('Script failed in After Effects: m Did you mean "Vinyl 12\\" Label"?');
    const fake = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: 'Lower Third Background" or "Box' }] });
    expect(scriptErrorText(fake)).toBe('Script failed in After Effects: m Did you mean "Lower Third Background\\" or \\"Box"?');
    const slash = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "a\\b\nc" }] });
    expect(scriptErrorText(slash)).toBe('Script failed in After Effects: m Did you mean "a\\\\b c"?');
  });

  it("keeps a label in parentheses when it nests cleanly, quotes it when it does not, and caps it (R9)", () => {
    const legacy = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "ADBE Gaussian Blur", label: "Gaussian Blur (Legacy)" }] });
    expect(scriptErrorText(legacy)).toBe('Script failed in After Effects: m Did you mean "ADBE Gaussian Blur" (Gaussian Blur (Legacy))?');
    const breakout = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "A", label: 'Blur) or "Fake" (x' }] });
    expect(scriptErrorText(breakout)).toBe('Script failed in After Effects: m Did you mean "A" ("Blur) or \\"Fake\\" (x")?');
    const quote = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "A", label: '12" Vinyl' }] });
    expect(scriptErrorText(quote)).toBe('Script failed in After Effects: m Did you mean "A" ("12\\" Vinyl")?');
    const long = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "A", label: "L".repeat(200) }] });
    expect(scriptErrorText(long)).toBe(`Script failed in After Effects: m Did you mean "A" (${"L".repeat(80)}\u2026(+120 chars))?`);
  });

  it("redacts a suggestion's label (K3)", () => {
    setRedactionSecrets(["configured-secret-value"]);
    const e = new ScriptError("after_effects", "m", 9, { where: "unknown", suggestions: [{ name: "A", label: "x configured-secret-value y" }] });
    expect(scriptErrorText(e)).toBe('Script failed in After Effects: m Did you mean "A" (x [redacted] y)?');
  });
});

describe("guard and jobErrorMessage (AE-16)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("guard: an enriched ScriptError reads through scriptErrorText", async () => {
    const r = await guard(async () => {
      throw new ScriptError("after_effects", "m", 9, { where: "helper", helper: "__comp" });
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Script failed in After Effects in helper __comp (script line 9): m");
  });

  it("guard: a panel that dropped mid-call says it may have partly run, logged at warn (D12)", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const r = await guard(async () => {
      throw new AppDisconnectedError("after_effects", "socket closed");
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      'The "after_effects" panel disconnected before the command completed (socket closed) \u2014 it may have partly run; check After Effects, ' +
        "reconnect the brainferno-mcp-bridge panel (cc_connected_apps shows when it is back), then retry.",
    );
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("jobErrorMessage: plain and non-enriched errors keep their message; enriched and UNKNOWN_COMMAND use the formatter", () => {
    expect(jobErrorMessage(new Error("nope"))).toBe("nope");
    expect(jobErrorMessage("text")).toBe("text");
    expect(jobErrorMessage(new ScriptError("premiere", "x", 4))).toBe("x");
    expect(jobErrorMessage(new ScriptError("premiere", "x", 4, { code: "HOST_ERROR" }))).toBe("x");
    expect(jobErrorMessage(new ScriptError("after_effects", "m", 9, { where: "helper", helper: "__comp" }))).toBe(
      "Script failed in After Effects in helper __comp (script line 9): m",
    );
    expect(jobErrorMessage(new ScriptError("premiere", "panel does not implement pp.x", undefined, { code: "UNKNOWN_COMMAND" }))).toMatch(
      /^The Premiere Pro panel does not support this command \(panel does not implement pp\.x\) \u2014 it is older than this server/,
    );
  });

  it("jobErrorMessage: a panel that dropped during a step reads as guard() says it (R5)", () => {
    expect(jobErrorMessage(new AppDisconnectedError("premiere", "socket closed"))).toBe(
      'The "premiere" panel disconnected before the command completed (socket closed) \u2014 it may have partly run; check Premiere Pro, ' +
        "reconnect the brainferno-mcp-bridge panel (cc_connected_apps shows when it is back), then retry.",
    );
  });
});
