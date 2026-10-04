// Copies deployment address files into public/deployments so the app can fetch them at runtime.
// A real testnet deployment (contracts/deployments/<network>.json) wins over a local fork one
// (contracts/deployments/local/<network>.json). Networks with neither are left out; the app then
// shows "not deployed yet" for them.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "@exeunt/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const source = join(repo, "contracts", "deployments");
const target = resolve(here, "../public/deployments");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const key of Object.keys(NETWORKS)) {
  const live = join(source, `${key}.json`);
  const local = join(source, "local", `${key}.json`);
  const from = existsSync(live) ? live : existsSync(local) ? local : null;
  if (!from) {
    process.stdout.write(`[deployments] ${key}: none found, the app will show "not deployed yet"\n`);
    continue;
  }
  copyFileSync(from, join(target, `${key}.json`));
  process.stdout.write(`[deployments] ${key}: ${relative(repo, from)}\n`);
}
