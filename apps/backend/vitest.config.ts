import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const SQLITE_SHIM = fileURLToPath(new URL("./src/testing/node-sqlite-shim.ts", import.meta.url));

// Vitest 2 (vite-node) rewrites "node:sqlite" to "sqlite", which does not exist; serve a shim instead.
export default defineConfig({
  plugins: [
    {
      name: "node-sqlite-shim",
      enforce: "pre",
      resolveId(id) {
        return id === "node:sqlite" || id === "sqlite" ? SQLITE_SHIM : null;
      },
    },
  ],
  test: {
    environment: "node",
  },
});
