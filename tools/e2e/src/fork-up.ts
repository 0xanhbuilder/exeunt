import { spawn } from "node:child_process";
import { encodeFunctionData, formatUnits, maxUint256, type Address, type Hex } from "viem";
import { ExeuntClient, NETWORKS, erc20Abi, morphoAbi, parseDeployment, type NetworkKey, type SessionParams } from "@exeunt/sdk";
import { LIQUIDITY_HELPER, bidderKit, borrowerKit, kitContext, refreeze, sellerKit, type KitContext } from "@exeunt/forkkit";
import { deployToFork, FORK_HEADERS, forkSpecs, readDotEnv, toolEnv, type ForkSpec } from "./lib/env.js";
import { makeActors, makeClients, send, ensureAllowance, type Actor } from "./lib/chain.js";
import { Recorder } from "./lib/report.js";
import { bankRun } from "./scenarios/morpho.js";

/**
 * Brings up long-running demo forks for the web app and backend: anvil on 8601-8604, Exeunt deployed
 * (deployments/local/<network>.json), the scenario's frozen state, and seeded sessions, bids and vault capital.
 * Usage: npm run fork:up -w @exeunt/e2e -- --network=all [--reuse]
 * --reuse seeds a fork node that is already running (started by a supervisor) instead of starting one.
 */

const DEMO_PORTS: Record<NetworkKey, number> = {
  "arbitrum-sepolia": 8601,
  "kelp-replay": 8602,
  "robinhood-testnet": 8603,
  "earn-bank-run": 8604,
};

const STEAKHOUSE_HOLDERS: Address[] = [
  "0xf705f15f34be971abc30e2a4c7c9eb18793bb10e",
  "0x5551a6792a318a7e5980dba62604662fd717f515",
  "0x60822b4f00b75d47b847c67011fe13b8027624f0",
];

const log = (line: string) => process.stdout.write(`${line}\n`);

async function rpcUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function startDetached(spec: ForkSpec): void {
  const args = ["--fork-url", spec.forkUrl, "--port", String(spec.port), "--host", "0.0.0.0", "--gas-limit", "100000000", "--silent", ...FORK_HEADERS];
  if (spec.forkBlock) args.push("--fork-block-number", String(spec.forkBlock));
  const child = spawn("anvil", args, { env: toolEnv(), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

const params = (startBps: number, stepBps: number): SessionParams => ({
  startBps,
  stepBps,
  stepInterval: 3600,
  capBps: 2000,
  duration: 14 * 86400,
  payMask: 0b1111,
});

async function seedAave(r: Recorder, sdk: ExeuntClient, kit: KitContext, a: Actor[], leave: bigint) {
  const [seller1, seller2, borrower, bidder, depositor] = a as [Actor, Actor, Actor, Actor, Actor];
  const d = sdk.deployment;
  const E18 = 10n ** 18n;
  const [usdg, usdc, weth] = d.payTokens as [Address, Address, Address];
  const mask = (1 << d.payTokens.length) - 1;
  await r.step("positions: two stuck depositors, one same-asset borrower, funded bidders", async () => {
    await sellerKit(kit, seller1.address, 150n * E18, leave);
    await sellerKit(kit, seller2.address, 40n * E18, leave);
    await borrowerKit(kit, borrower.address, 80n * E18, leave);
    await bidderKit(kit, bidder.address, { [usdg]: 1_000_000n * 10n ** 6n, [usdc]: 1_000_000n * 10n ** 6n });
    await bidderKit(kit, depositor.address, { [weth]: 200n * E18 });
    await refreeze(kit, leave);
  });
  await r.step("sessions: 120 aWETH from 1% rising 0.5%/h, 30 aWETH from 3%", async () => {
    await ensureAllowance(r, sdk, seller1, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller1, sdk.openSession(120n * E18, { ...params(100, 50), payMask: mask }));
    await ensureAllowance(r, sdk, seller2, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller2, sdk.openSession(30n * E18, { ...params(300, 25), payMask: mask }));
  });
  await r.step("limit bids: USDG at 2%, USDC at 4%, deeper USDG at 8%", async () => {
    for (const [token, idx, bps, size] of [[usdg, 0, 200, 10n], [usdc, 1, 400, 25n], [usdg, 0, 800, 60n]] as const) {
      const escrow = await sdk.quote(size * E18, bps, token);
      await ensureAllowance(r, sdk, bidder, token, d.market, escrow);
      await send(r, sdk, bidder, sdk.placeBid(bps, idx, size * E18, escrow));
    }
  });
  await r.step("Exeunt Vault: 200 WETH deposited (bids 3% for up to 20%)", async () => {
    await ensureAllowance(r, sdk, depositor, weth, d.exeuntVault, 200n * E18);
    await send(r, sdk, depositor, sdk.vaultDeposit(200n * E18, depositor.address));
  });
}

async function seedMorpho(r: Recorder, sdk: ExeuntClient, kit: KitContext, a: Actor[], network: NetworkKey) {
  const [seller1, seller2, borrower, bidder, depositor] = a as [Actor, Actor, Actor, Actor, Actor];
  const d = sdk.deployment;
  const USD = 10n ** 6n;
  const usdg = d.underlying;
  if (network === "robinhood-testnet") {
    await r.step("flash liquidity: 500,000 USDG idle in a separate Morpho market", async () => {
      const [loanToken, collateralToken, oracle, irm, lltv] = await kit.client.readContract({
        address: d.morpho as Address,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [d.flashMarketId as Hex],
      });
      await kit.anvil.setBalance(LIQUIDITY_HELPER, 10n ** 18n);
      await kit.anvil.dealErc20(usdg, LIQUIDITY_HELPER, 500_000n * USD);
      await kit.anvil.sendAs(LIQUIDITY_HELPER, usdg, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [d.morpho as Address, maxUint256] }));
      await kit.anvil.sendAs(LIQUIDITY_HELPER, d.morpho as Address, encodeFunctionData({
        abi: morphoAbi,
        functionName: "supply",
        args: [{ loanToken, collateralToken, oracle, irm, lltv }, 500_000n * USD, 0n, LIQUIDITY_HELPER, "0x"],
      }));
    });
  }
  await r.step("positions: two stuck Earn depositors, one USDG borrower, funded bidders", async () => {
    await sellerKit(kit, seller1.address, 300_000n * USD);
    await sellerKit(kit, seller2.address, 80_000n * USD);
    await borrowerKit(kit, borrower.address, 200_000n * USD);
    await bidderKit(kit, bidder.address, { [usdg]: 2_000_000n * USD });
    await bidderKit(kit, depositor.address, { [usdg]: 500_000n * USD });
  });
  if (network === "earn-bank-run") {
    await r.step("bank run: large Steakhouse holders withdraw what they can", async () => {
      const run = await bankRun(sdk, kit, STEAKHOUSE_HOLDERS);
      return { withdrawnUSDG: formatUnits(run.withdrawn, 6) };
    });
  }
  await r.step("freeze: remaining liquidity borrowed out", async () => {
    await refreeze(kit);
    const c = await sdk.capacity();
    return { utilization: `${c.utilizationBps / 100}%` };
  });
  await r.step("sessions, limit bids and Exeunt Vault capital", async () => {
    await ensureAllowance(r, sdk, seller1, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller1, sdk.openSession(await sdk.receiptAmountFor(250_000n * USD), { ...params(100, 50), payMask: 0b11 }));
    await ensureAllowance(r, sdk, seller2, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller2, sdk.openSession(await sdk.receiptAmountFor(60_000n * USD), { ...params(300, 25), payMask: 0b11 }));
    for (const [bps, size] of [[200, 40_000n], [500, 150_000n], [900, 400_000n]] as const) {
      const escrow = await sdk.quote(size * USD, bps, usdg);
      await ensureAllowance(r, sdk, bidder, usdg, d.market, escrow);
      await send(r, sdk, bidder, sdk.placeBid(bps, 0, size * USD, escrow));
    }
    await ensureAllowance(r, sdk, depositor, usdg, d.exeuntVault, 500_000n * USD);
    await send(r, sdk, depositor, sdk.vaultDeposit(500_000n * USD, depositor.address));
  });
}

async function up(network: NetworkKey, base: ForkSpec, reuse: boolean): Promise<void> {
  const spec = { ...base, port: DEMO_PORTS[network] };
  const rpcUrl = `http://127.0.0.1:${spec.port}`;
  log(`\n== ${network} on ${rpcUrl}`);
  if (reuse) {
    // A supervisor (systemd on the demo server) runs the fork node; only deploy and seed it.
    if (!(await rpcUp(rpcUrl))) throw new Error(`--reuse: nothing is serving on port ${spec.port}`);
  } else {
    if (await rpcUp(rpcUrl)) throw new Error(`port ${spec.port} is already serving; stop that node first`);
    startDetached(spec);
  }
  for (let i = 0; i < 120 && !(await rpcUp(rpcUrl)); i++) await new Promise((res) => setTimeout(res, 1000));
  const deployment = parseDeployment(await deployToFork(spec, { outDir: "./deployments/local/" }));
  const chain = { ...NETWORKS[network].chain, rpcUrls: { default: { http: [rpcUrl] } } };
  const { publicClient } = makeClients(rpcUrl, chain);
  const sdk = new ExeuntClient(deployment, publicClient);
  const kit = kitContext(publicClient, deployment);
  const actors = makeActors(["seller1", "seller2", "borrower", "bidder", "depositor"], rpcUrl, chain);
  for (const a of actors) await kit.anvil.setBalance(a.address, 10n ** 20n);
  const r = new Recorder(network, log);
  if (deployment.venue === "aave") await seedAave(r, sdk, kit, actors, network === "kelp-replay" ? 0n : 2n * 10n ** 18n);
  else await seedMorpho(r, sdk, kit, actors, network);
  const c = await sdk.capacity();
  log(`  ready: market ${deployment.market}, utilization ${(c.utilizationBps / 100).toFixed(2)}%, ${(await sdk.sessions(true)).length} sessions, ${(await sdk.bids()).length} bids`);
  if (r.hasFailed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const arg = process.argv.find((x) => x.startsWith("--network="))?.split("=")[1] ?? "all";
  const keys = (arg === "all" ? Object.keys(DEMO_PORTS) : arg.split(",")) as NetworkKey[];
  const reuse = process.argv.includes("--reuse");
  const specs = forkSpecs(readDotEnv());
  for (const k of keys) await up(k, specs[k], reuse);
  log("\nForks keep running in the background. Stop them by ending the anvil processes.");
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
