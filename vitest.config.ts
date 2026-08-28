import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against protocol sources, so no build step is needed first.
    alias: { "@brainferno/mcp-bridge-protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)) },
  },
  test: { include: ["packages/*/test/**/*.test.ts"], testTimeout: 10_000 },
});
