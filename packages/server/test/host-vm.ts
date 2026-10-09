/**
 * node:vm standing in for an ExtendScript host, serializing results with the hosts' own
 * ES3 serializer (`__acmJson` from the os-script prelude — the same code host.jsx defines
 * for the CEP panel), so tests see exactly what a host would put on the wire. V8's
 * JSON.stringify differs in the way that matters here: it writes own properties only,
 * while `__acmJson` uses a plain `for (k in v)` and also writes inherited ones.
 *
 * Not a test file (no `.test.ts`), so vitest does not collect it on its own.
 */

import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

import { JSX_PRELUDE } from "../src/drivers/osscript.js";

/** A fresh context with the prelude (`__acmStr`, `__acmJson`, `__acmWrite`) loaded. */
export function hostContext(globals: Record<string, unknown> = {}): vm.Context {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(JSX_PRELUDE, ctx);
  return ctx;
}

/**
 * Evaluates a script expression (typically the raw-script wrapper) the way a host does and
 * returns what crosses the wire: `__acmJson(value)`, parsed back. Throws whatever the
 * serializer throws (an inherited cycle is a RangeError), as a host would.
 */
export function hostEval(script: string, ctx: vm.Context = hostContext()): any {
  return JSON.parse(vm.runInContext(`__acmJson(${script})`, ctx) as string);
}

/** ExtendScript's File, reduced to what the prelude's __acmWrite uses; writes on close(). */
class HostFile {
  encoding = "";
  private text = "";
  constructor(readonly path: string) {}
  open(): boolean {
    this.text = "";
    return true;
  }
  write(text: string): boolean {
    this.text += String(text);
    return true;
  }
  close(): boolean {
    writeFileSync(this.path, this.text, "utf8");
    return true;
  }
}

/**
 * Runs a generated os-script `.jsx` (prelude + script + __acmWrite) end to end, the way
 * Illustrator's `$.evalFile` would: whatever the prelude writes lands in the result file.
 */
export function runJsxFile(jsxPath: string): void {
  vm.runInContext(readFileSync(jsxPath, "utf8"), vm.createContext({ File: HostFile }));
}
