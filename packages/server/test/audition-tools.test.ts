import { describe, expect, it } from "vitest";

import {
  API_DUMP,
  APP_STATE,
  DOCUMENT_INFO,
  addMarkerScript,
  applyFavoriteScript,
  closeDocumentScript,
  invokeCommandScript,
  listCommandsScript,
  openDocumentScript,
  saveDocumentScript,
  setPlayheadScript,
  transportScript,
} from "../src/tools/audition.js";
import { es3Violations } from "./osscript.test.js";

const SAMPLES: Record<string, string> = {
  APP_STATE,
  DOCUMENT_INFO,
  API_DUMP,
  list: listCommandsScript(undefined, false),
  listFiltered: listCommandsScript("Normalize", true),
  invoke: invokeCommandScript("Effects.Normalize", false),
  playhead: setPlayheadScript(2.5),
  open: openDocumentScript("C:/a/b.wav"),
  save: saveDocumentScript(undefined, false),
  saveAs: saveDocumentScript('C:/a/c "q".wav', false),
  exportAs: saveDocumentScript("C:/a/d.mp3", true),
  close: closeDocumentScript(),
  favorite: applyFavoriteScript("Normalize to -0.1 dB"),
  marker: addMarkerScript(1.5, 0, "hit", "Cue", "first beat"),
  play: transportScript("play", true),
  state: transportScript("state", undefined),
};

describe("Audition tool scripts", () => {
  it("are all ES3-clean", () => {
    for (const [name, src] of Object.entries(SAMPLES)) expect(es3Violations(src), name).toEqual([]);
  });

  it("escape strings and lower-case the filter", () => {
    expect(SAMPLES["listFiltered"]).toContain('var f = "normalize";');
    expect(SAMPLES["saveAs"]).toContain('"C:/a/c \\"q\\".wav"');
    expect(SAMPLES["invoke"]).toContain('var id = "Effects.Normalize";');
  });

  it("uses the 26.3 API shapes found by the live dump", () => {
    expect(SAMPLES["open"]).toContain("app.openDocument(new DocumentOpenParameter(f.fsName))");
    expect(SAMPLES["saveAs"]).toContain("d.saveAs(f.fsName, false)");
    expect(SAMPLES["exportAs"]).toContain("d.saveAs(f.fsName, true)");
    expect(SAMPLES["save"]).toContain("d.saveDocument(null)");
    expect(SAMPLES["favorite"]).toContain('d.applyFavorite("Normalize to -0.1 dB")');
    expect(SAMPLES["marker"]).toContain('d.addMarker(Math.round(1.5 * d.sampleRate), Math.round(0 * d.sampleRate), "hit", "Cue", "first beat")');
    expect(SAMPLES["play"]).toContain("t.loop = true;");
    expect(SAMPLES["play"]).toContain("ok = t.play();");
    expect(SAMPLES["state"]).not.toContain("t.loop =");
  });

  it("gates invoke on isCommandEnabled unless forced", () => {
    expect(SAMPLES["invoke"]).toContain("app.isCommandEnabled(id)");
    expect(SAMPLES["invoke"]).toContain("app.invokeCommand(id)");
    expect(invokeCommandScript("x", true)).toContain("if (enabled === false && !true)");
  });

  it("converts playhead seconds to samples", () => {
    expect(SAMPLES["playhead"]).toContain("Math.round(2.5 * d.sampleRate)");
  });
});
