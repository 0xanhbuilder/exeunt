import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ExeuntClient, NETWORKS, parseDeployment, type NetworkKey } from "@exeunt/sdk";
import { kitContext } from "@exeunt/forkkit";
import { CONTRACTS_DIR, deployToFork, forkSpecs, readDotEnv, REPO_ROOT, startAnvil, type ForkSpec } from "./lib/env.js";
import { makeActors, makeClients } from "./lib/chain.js";
import { privateKeyToAddress } from "viem/accounts";
import { Anvil } from "@exeunt/forkkit";
import { Recorder, toMarkdown, type ScenarioResult } from "./lib/report.js";
import { aaveScenario } from "./scenarios/aave.js";
import { liveAaveScenario } from "./scenarios/live-aave.js";
import { liveMorphoScenario } from "./scenarios/live-morpho.js";
import { morphoScenario } from "./scenarios/morpho.js";

// Top Steakhouse USDG share holders on Robinhood Chain, found by scanning the vault's Transfer logs.
const STEAKHOUSE_HOLDERS = [
  "0xf705f15f34be971abc30e2a4c7c9eb18793bb10e",
  "0x5551a6792a318a7e5980dba62604662fd717f515",
  "0x60822b4f00b75d47b847c67011fe13b8027624f0",
  "0x6795805f0ca3a670d1e8aae2db406c3cf47b477f",
  "0xd12514b63ddd0d10de684f5afe7997c41bf58010",
  "0x62ed63d2ddfed6a43bae34e9d562e7e7ee9331fb",
  "0xc2bc6fa09aa750c00db343c1273e290ebc6d4b63",
  "0x4e37a2a0f65bb6f26a69ac0ddc6d70f5768941eb",
] as const;

const ALL: NetworkKey[] = ["arbitrum-sepolia", "kelp-replay", "robinhood-testnet", "earn-bank-run"];

type Mode = "fork" | "live" | "rehearse";

function parseArgs(): { networks: NetworkKey[]; mode: Mode } {
  const arg = process.argv.find((a) => a.startsWith("--network="))?.split("=")[1] ?? "all";
  const mode: Mode = process.argv.includes("--live") ? "live" : process.argv.includes("--rehearse") ? "rehearse" : "fork";
  const networks = arg === "all" ? ALL : (arg.split(",") as NetworkKey[]);
  for (const n of networks) if (!ALL.includes(n)) throw new Error(`unknown network ${n}`);
  return { networks, mode };
}

const log = (line: string) => process.stdout.write(`${line}
`);

async function waitForRpc(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`anvil at ${url} did not start`);
}

const LIVE_RPC_ENV: Partial<Record<NetworkKey, string>> = {
  "arbitrum-sepolia": "ARB_SEPOLIA_RPC",
  "robinhood-testnet": "ROBINHOOD_TESTNET_RPC",
};

/**
 * Live testnet run with the funded deployer key and the second test key from .env.
 * In rehearse mode the same scenario runs on a fresh anvil fork with those real accounts (gas topped up),
 * deployed by the real deployer key, so a live run is proven before it spends anything.
 */
async function runLive(network: NetworkKey, env: Record<string, string>, rehearse: boolean, spec: ForkSpec): Promise<ScenarioResult> {
  const t0 = Date.now();
  const r = new Recorder(network, log);
  const mode = rehearse ? "fork" : "live";
  const result: ScenarioResult = { network, mode, steps: r.steps, startedAt: new Date().toISOString(), ms: 0 };
  log(`
== ${network} (${rehearse ? "rehearsal of the live run on a fork" : "live"})`);
  let anvil: ChildProcess | undefined;
  try {
    const rpcEnv = LIVE_RPC_ENV[network];
    if (!rpcEnv) throw new Error(`live runs exist for live testnets only`);
    const keys = [env.PRIVATE_KEY, env.E2E_BUYER_KEY] as Hex[];
    if (!keys[0] || !keys[1]) throw new Error("PRIVATE_KEY and E2E_BUYER_KEY must be set in .env");
    let rpcUrl = env[rpcEnv] ?? NETWORKS[network].defaultRpcUrl;
    let raw: unknown;
    if (rehearse) {
      anvil = startAnvil(spec, log);
      rpcUrl = `http://127.0.0.1:${spec.port}`;
      await waitForRpc(rpcUrl);
      const probe = makeClients(rpcUrl, { ...NETWORKS[network].chain, rpcUrls: { default: { http: [rpcUrl] } } });
      const cheats = new Anvil(probe.publicClient);
      for (const k of keys) await cheats.setBalance(privateKeyToAddress(k), 10n ** 17n);
      raw = await deployToFork(spec, { key: keys[0], outDir: "./deployments/local/rehearse/" });
    } else {
      const file = join(CONTRACTS_DIR, "deployments", `${network}.json`);
      if (!existsSync(file)) throw new Error(`no live deployment at ${file}`);
      raw = JSON.parse(readFileSync(file, "utf8"));
    }
    const deployment = parseDeployment(raw);
    result.deployment = deployment as unknown as Record<string, unknown>;
    const chain = { ...NETWORKS[network].chain, rpcUrls: { default: { http: [rpcUrl] } } };
    const { publicClient } = makeClients(rpcUrl, chain);
    result.forkBlock = String(await publicClient.getBlockNumber());
    const [seller, buyer] = makeActors(["seller", "buyer"], rpcUrl, chain, keys);
    if (!seller || !buyer) throw new Error("actors");
    const sdk = new ExeuntClient(deployment, publicClient);
    if (deployment.venue === "aave") await liveAaveScenario(r, sdk, { seller, buyer });
    else await liveMorphoScenario(r, sdk, { seller, buyer });
  } catch (e) {
    r.steps.push({ name: "runner", ok: false, ms: 0, details: {}, txs: [], error: e instanceof Error ? e.message : String(e) });
    log(`  ✗ runner: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    anvil?.kill();
    result.ms = Date.now() - t0;
  }
  return result;
}

async function runFork(spec: ForkSpec): Promise<ScenarioResult> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const r = new Recorder(spec.network, log);
  const result: ScenarioResult = { network: spec.network, mode: "fork", steps: r.steps, startedAt, ms: 0 };
  const rpcUrl = `http://127.0.0.1:${spec.port}`;
  let anvil: ChildProcess | undefined;
  log(`\n== ${spec.network} (fork)`);
  try {
    anvil = startAnvil(spec, log);
    await waitForRpc(rpcUrl);
    const info = NETWORKS[spec.network];
    const chain = { ...info.chain, rpcUrls: { default: { http: [rpcUrl] } } };
    const { publicClient } = makeClients(rpcUrl, chain);
    result.forkBlock = String(await publicClient.getBlockNumber());

    let sdk: ExeuntClient | undefined;
    await r.step("deploy Exeunt contracts to the fork with the Foundry script", async () => {
      const deployment = parseDeployment(await deployToFork(spec));
      result.deployment = deployment as unknown as Record<string, unknown>;
      sdk = new ExeuntClient(deployment, publicClient);
      return { market: deployment.market, exeuntVault: deployment.exeuntVault };
    });
    if (!sdk) return result;
    const kit = kitContext(publicClient, sdk.deployment);
    if (info.venue === "aave") {
      const [seller, buyer, bidder, depositor, borrower, keeper] = makeActors(
        ["seller", "buyer", "bidder", "depositor", "borrower", "keeper"],
        rpcUrl,
        chain,
      );
      if (!seller || !buyer || !bidder || !depositor || !borrower || !keeper) throw new Error("actors");
      for (const a of [seller, buyer, bidder, depositor, borrower, keeper]) await kit.anvil.setBalance(a.address, 10n ** 19n);
      await aaveScenario(r, sdk, kit, { seller, buyer, bidder, depositor, borrower, keeper }, {
        leave: spec.network === "kelp-replay" ? 0n : 2n * 10n ** 18n,
      });
    } else {
      const [seller, buyer, bidder, depositor, keeper] = makeActors(["seller", "buyer", "bidder", "depositor", "keeper"], rpcUrl, chain);
      if (!seller || !buyer || !bidder || !depositor || !keeper) throw new Error("actors");
      for (const a of [seller, buyer, bidder, depositor, keeper]) await kit.anvil.setBalance(a.address, 10n ** 19n);
      await morphoScenario(r, sdk, kit, { seller, buyer, bidder, depositor, keeper }, {
        seedFlashLiquidity: spec.network === "robinhood-testnet" ? 50_000n * 10n ** 6n : undefined,
        bankRunHolders: spec.network === "earn-bank-run" ? [...STEAKHOUSE_HOLDERS] : undefined,
      });
    }
  } catch (e) {
    r.steps.push({ name: "runner", ok: false, ms: 0, details: {}, txs: [], error: e instanceof Error ? e.message : String(e) });
    log(`  ✗ runner: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    anvil?.kill();
    result.ms = Date.now() - t0;
  }
  return result;
}

async function main(): Promise<void> {
  const { networks, mode } = parseArgs();
  const env = readDotEnv();
  const specs = forkSpecs(env);
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  for (const n of networks) {
    results.push(mode === "fork" ? await runFork(specs[n]) : await runLive(n, env, mode === "rehearse", specs[n]));
  }

  const dir = join(REPO_ROOT, "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const json = JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(join(dir, `e2e-${mode}-${stamp}.json`), json);
  writeFileSync(join(dir, `e2e-${mode}-${stamp}.md`), toMarkdown(results, startedAt));
  writeFileSync(join(dir, `e2e-${mode}-latest.md`), toMarkdown(results, startedAt));
  const steps = results.flatMap((x) => x.steps);
  const failed = steps.filter((s) => !s.ok).length;
  log(`\n${steps.length - failed}/${steps.length} steps passed. Report: reports/e2e-${mode}-${stamp}.md`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
