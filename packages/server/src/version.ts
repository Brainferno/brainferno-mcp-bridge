/**
 * The one place the product version comes from.
 *
 * It used to be typed out in four files, so a release bumped package.json and left every
 * client — MCP `serverInfo`, the panels' welcome frame — being told 0.1.0 by a 0.2.1 build.
 * Reading package.json at runtime cannot drift: `src/version.ts` and `dist/version.js` are
 * both one level below the package root, so the same relative path works in the repo and in
 * the published tarball.
 */
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };

export const SERVER_VERSION: string = typeof pkg.version === "string" ? pkg.version : "0.0.0";
