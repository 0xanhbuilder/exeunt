// Copies deployment address files into public/deployments so the app can fetch them at runtime.
// Live testnets use their real deployment (contracts/deployments/<network>.json). Scenario forks use
// the local fork deployment (contracts/deployments/local/<network>.json). Set EXEUNT_LOCAL_TESTNETS=1
// to also let live testnets fall back to a local fork deployment (pair it with VITE_RPC_<NETWORK>).
// Networks without a usable file are left out; the app then shows "not deployed yet" for them.
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
  const allowLocal = NETWORKS[key].isFork || process.env.EXEUNT_LOCAL_TESTNETS === "1";
  const from = existsSync(live) ? live : allowLocal && existsSync(local) ? local : null;
  if (!from) {
    process.stdout.write(`[deployments] ${key}: none found, the app will show "not deployed yet"\n`);
    continue;
  }
  copyFileSync(from, join(target, `${key}.json`));
  process.stdout.write(`[deployments] ${key}: ${relative(repo, from)}\n`);
}
