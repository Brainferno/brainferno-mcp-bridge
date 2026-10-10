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

/**
 * Built-ins that ES5 added and an ES3 engine lacks. The syntax gate above cannot see them, and
 * node:vm (the test stand-in for the host) has them all, so a call slips through every other test
 * and fails only in the real app. `indexOf` / `lastIndexOf` are not listed: they are ES3 on strings
 * (`$.os.indexOf`) and ES5 only on arrays, which a text scan cannot tell apart.
 */
export const ES5_CALLS: readonly string[] = [
  ".map(",
  ".filter(",
  ".forEach(",
  ".some(",
  ".every(",
  ".reduce(",
  ".reduceRight(",
  ".bind(",
  ".trim(",
  ".toISOString(",
  ".toJSON(",
  "Object.keys",
  "Object.create",
  "Object.defineProperty",
  "Object.defineProperties",
  "Object.getPrototypeOf",
  "Object.getOwnPropertyNames",
  "Object.freeze",
  "Array.isArray",
  "Date.now",
];

/** The ES5_CALLS entries `source` contains, in list order. */
export function es5Calls(source: string): string[] {
  return ES5_CALLS.filter((call) => source.includes(call));
}
