import { describe, expect, it } from "vitest";

import { API_DUMP, APP_STATE, DOCUMENT_INFO, invokeCommandScript, listCommandsScript, openDocumentScript, saveDocumentScript, setPlayheadScript } from "../src/tools/audition.js";
import { es3Violations } from "./osscript.test.js";

const SAMPLES: Record<string, string> = {
  APP_STATE,
  DOCUMENT_INFO,
  API_DUMP,
  list: listCommandsScript(undefined, false),
  listFiltered: listCommandsScript("Normalize", true),
  invoke: invokeCommandScript("Effects.AmplitudeAndCompression.Normalize", false),
  playhead: setPlayheadScript(2.5),
  open: openDocumentScript("C:/a/b.wav"),
  save: saveDocumentScript(undefined),
  saveAs: saveDocumentScript("C:/a/c \"q\".wav"),
};

describe("Audition tool scripts", () => {
  it("are all ES3-clean", () => {
    for (const [name, src] of Object.entries(SAMPLES)) expect(es3Violations(src), name).toEqual([]);
  });

  it("escape strings and lower-case the filter", () => {
    expect(SAMPLES["listFiltered"]).toContain('var f = "normalize";');
    expect(SAMPLES["saveAs"]).toContain('"C:/a/c \\"q\\".wav"');
    expect(SAMPLES["invoke"]).toContain('var id = "Effects.AmplitudeAndCompression.Normalize";');
  });

  it("gates invoke on isCommandEnabled unless forced", () => {
    expect(SAMPLES["invoke"]).toContain("app.isCommandEnabled(id)");
    expect(SAMPLES["invoke"]).toContain("app.invokeCommand(id)");
    expect(invokeCommandScript("x", true)).toContain("if (enabled === false && !true)");
  });

  it("converts playhead seconds to samples", () => {
    expect(SAMPLES["playhead"]).toContain("Math.round(2.5 * sr)");
  });
});
