// Test-only stand-in for "node:sqlite": Vitest 2 strips the "node:" prefix and cannot load the
// prefix-only builtin, so vitest.config.ts points imports here and Node's own require loads it.
import { createRequire } from "node:module";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
