import { describe, expect, it } from "vitest";

import { closestNames, editDistance, fold, rank, stripAeVendor, suggestionThreshold } from "../src/tools/suggest.js";
import { AE_EFFECTS, AE_EFFECT_ITEMS } from "./ae-effects-fixture.js";

const EMOJI = String.fromCodePoint(0x1f600);
const effectKeys = (e: { matchName: string; displayName: string }) => [e.matchName, e.displayName];
const rankEffects = (query: string, limit = 3) =>
  rank(query, AE_EFFECT_ITEMS, effectKeys, { limit, normalize: stripAeVendor }).map((r) => r.item.matchName);

describe("editDistance", () => {
  it("counts insertions, deletions and substitutions", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });

  it("works over code points, so an emoji is one edit", () => {
    expect(editDistance(`a${EMOJI}b`, "ab")).toBe(1);
    expect(editDistance(EMOJI, "x")).toBe(1);
  });

  it("stops early and returns max + 1 once the result must exceed max", () => {
    expect(editDistance("kitten", "sitting", 2)).toBe(3);
    expect(editDistance("abcdefgh", "zzzzzzzzzzzzzz", 3)).toBe(4);
    expect(editDistance("kitten", "sitting", 3)).toBe(3);
  });
});

describe("suggestionThreshold", () => {
  it("is max(2, 30 % of the name's code points)", () => {
    expect(suggestionThreshold("abcde")).toBe(2);
    expect(suggestionThreshold("gausian blur 2")).toBe(4);
    expect(suggestionThreshold("a".repeat(19))).toBe(5);
    expect(suggestionThreshold("a".repeat(30))).toBe(9);
    expect(suggestionThreshold("ab")).toBe(2);
    expect(suggestionThreshold(EMOJI.repeat(10))).toBe(3);
  });
});

describe("fold and stripAeVendor", () => {
  it("folds case and normalizes to NFC", () => {
    expect(fold("ADBE Gaussian")).toBe("adbe gaussian");
    expect(fold("Cafe\u0301")).toBe("caf\u00e9");
  });

  it("drops one leading vendor tag followed by a space or an underscore", () => {
    expect(stripAeVendor("adbe gaussian blur 2")).toBe("gaussian blur 2");
    expect(stripAeVendor("cc radial blur")).toBe("radial blur");
    expect(stripAeVendor("apc colorama")).toBe("colorama");
    expect(stripAeVendor("bcc glow")).toBe("glow");
    expect(stripAeVendor("visinf_x")).toBe("x");
    for (const kept of ["pt sans", "adbex", "gaussian blur", "ccx", "keylight 906"]) expect(stripAeVendor(kept)).toBe(kept);
  });
});

describe("rank with the After Effects vendor strip, over a realistic installed-effects list", () => {
  it("uses a fixture of at least 200 effects", () => {
    expect(AE_EFFECTS.length).toBeGreaterThanOrEqual(200);
  });

  it("suggests the current blur first, then the legacy one, for a match-name typo", () => {
    expect(rankEffects("ADBE Gausian Blur 2")).toEqual(["ADBE Gaussian Blur 2", "ADBE Gaussian Blur"]);
    expect(rankEffects("adbe gausian blur 2")).toEqual(["ADBE Gaussian Blur 2", "ADBE Gaussian Blur"]);
  });

  it("breaks a tie on the unnormalized distance (a display-name typo prefers the current blur)", () => {
    const r = rank("Gausian Blur", AE_EFFECT_ITEMS, effectKeys, { normalize: stripAeVendor });
    expect(r[0]!.item.matchName).toBe("ADBE Gaussian Blur 2");
    expect(r[0]!.distance).toBe(1);
    expect(r[0]!.key).toBe("Gaussian Blur");
    expect(r.map((x) => x.item.matchName)).toContain("ADBE Gaussian Blur");
  });

  it("finds an effect through its display name when the match name differs", () => {
    expect(rankEffects("ADBE Gradient Ramp")[0]).toBe("ADBE Ramp");
    expect(rankEffects("ADBE Motion Tile")[0]).toBe("ADBE Tile");
    expect(rankEffects("ADBE Lumetri Color")[0]).toBe("ADBE Lumetri");
    const ramp = rank("ADBE Gradient Ramp", AE_EFFECT_ITEMS, effectKeys, { normalize: stripAeVendor })[0]!;
    expect(ramp.distance).toBe(0);
    expect(ramp.key).toBe("Gradient Ramp");
  });

  it("suggests nothing when no name is close", () => {
    expect(rankEffects("ADBE Fill Color")).toEqual([]);
    expect(rankEffects("Optical Flares")).toEqual([]);
  });

  it("keeps both effects whose stripped names collide (dedupe is per item, not per key)", () => {
    const got = rankEffects("Radial Blr");
    expect(got).toContain("ADBE Radial Blur");
    expect(got).toContain("CC Radial Blur");
  });

  it("returns the original, unnormalized key", () => {
    const r = rank("ADBE Gausian Blur 2", AE_EFFECT_ITEMS, effectKeys, { normalize: stripAeVendor });
    expect(r[0]!.key).toBe("ADBE Gaussian Blur 2");
    expect(r[0]!.distance).toBe(1);
  });

  it("honours limit 3 (the default) and 5", () => {
    const dense = Array.from({ length: 9 }, (_, i) => `ADBE Blur ${i + 1}`);
    expect(rank("ADBE Blur 0", dense, (n) => [n])).toHaveLength(3);
    expect(rank("ADBE Blur 0", dense, (n) => [n], { limit: 5 }).map((r) => r.item)).toEqual(dense.slice(0, 5));
    expect(rank("ADBE Blur 0", dense, (n) => [n], { limit: 5, normalize: stripAeVendor })).toHaveLength(5);
  });

  it("is deterministic on ties: input order breaks them last", () => {
    const items = ["beta", "alfa", "alfa"].map((name, i) => ({ name, i }));
    const r = rank("alfz", items, (x) => [x.name]);
    expect(r.map((x) => x.item.i)).toEqual([1, 2]);
    const again = rank("alfz", items, (x) => [x.name]);
    expect(again).toEqual(r);
  });

  it("an explicit threshold overrides the default", () => {
    expect(rank("abcdefgh", [{ n: "abcdzzzz" }], (x) => [x.n])).toEqual([]);
    expect(rank("abcdefgh", [{ n: "abcdzzzz" }], (x) => [x.n], { threshold: 4 }).map((x) => x.distance)).toEqual([4]);
  });
});

describe("rank without normalize (fonts keep their prefixes)", () => {
  it("finds PT Sans by family name, with no vendor stripping", () => {
    const fonts = [
      { postScriptName: "PTSans-Regular", familyName: "PT Sans", styleName: "Regular" },
      { postScriptName: "Arial-BoldMT", familyName: "Arial", styleName: "Bold" },
      { postScriptName: "SourceSansPro-Regular", familyName: "Source Sans Pro", styleName: "Regular" },
    ];
    const r = rank("PT Sans", fonts, (f) => [f.postScriptName, `${f.familyName} ${f.styleName}`, f.familyName]);
    expect(r[0]!.item.familyName).toBe("PT Sans");
    expect(r[0]!.distance).toBe(0);
  });
});

describe("closestNames (host-listed names)", () => {
  const TEXT = ["ADBE Text Document", "ADBE Text Path Options", "ADBE Text More Options", "ADBE Text Animators"];
  const TRANSFORM = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Orientation", "ADBE Rotate X", "ADBE Rotate Y", "ADBE Rotate Z", "ADBE Opacity"];
  const TOP = ["ADBE Marker", "ADBE Time Remapping", "ADBE MTrackers", "ADBE Mask Parade", "ADBE Effect Parade", "ADBE Transform Group", "ADBE Layer Styles", "ADBE Audio Group"];
  const SHAPE_TOP = ["ADBE Marker", "ADBE Root Vectors Group", "ADBE Mask Parade", "ADBE Effect Parade", "ADBE Transform Group", "ADBE Layer Styles", "ADBE Audio Group"];
  const opts = { limit: 3, normalize: stripAeVendor };

  it("suggests the one close child", () => {
    expect(closestNames("ADBE Text Documnt", TEXT, opts)).toEqual(["ADBE Text Document"]);
    expect(closestNames("ADBE Positon", TRANSFORM, opts)).toEqual(["ADBE Position"]);
    expect(closestNames("ADBE Effects Parade", TOP, opts)).toEqual(["ADBE Effect Parade"]);
  });

  it("suggests nothing for a name that is not close to any child", () => {
    expect(closestNames("ADBE Rotation", TRANSFORM, opts)).toEqual([]);
    // AE-03's case: a text-only group asked for on a shape layer (the kind message pre-empts it anyway).
    expect(closestNames("ADBE Text Properties", SHAPE_TOP, opts)).toEqual([]);
  });

  it("drops a name identical to the query and collapses exact duplicates", () => {
    expect(closestNames("ADBE Position", TRANSFORM, opts)).toEqual([]);
    expect(closestNames("ADBE Vector Grp", ["ADBE Vector Group", "ADBE Vector Group", "ADBE Vector Group"], opts)).toEqual(["ADBE Vector Group"]);
  });

  it("matches display names case-insensitively, as distance 0", () => {
    expect(closestNames("blurriness", ["Blurriness", "Blur Dimensions", "Repeat Edge Pixels"], opts)).toEqual(["Blurriness"]);
    expect(closestNames("Bluriness", ["Blurriness", "Blur Dimensions", "Repeat Edge Pixels"], opts)).toEqual(["Blurriness"]);
  });
});
