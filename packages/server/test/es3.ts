/**
 * The ES3 gate for generated ExtendScript, shared by the per-app tests.
 *
 * Not a test file (no `.test.ts`), so vitest does not collect it on its own, and a test file
 * that imports it does not re-run another file's tests (importing a `.test.ts` file would).
 */

/** The ES3 rules from CONTRIBUTING.md, as a regex gate: the names of the rules `source` breaks. */
export function es3Violations(source: string): string[] {
  const rules: [string, RegExp][] = [
    ["arrow function", /=>/],
    ["const", /\bconst\b/],
    ["let", /\blet\b/],
    ["template literal", /`/],
    ["JSON global", /\bJSON\./],
  ];
  return rules.filter(([, re]) => re.test(source)).map(([name]) => name);
}
