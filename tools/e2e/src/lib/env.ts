import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkKey } from "@exeunt/sdk";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const CONTRACTS_DIR = join(REPO_ROOT, "contracts");

/** Well-known anvil test key #0, used only on local forks. */
export const ANVIL_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** Reads KEY=VALUE pairs from the repo's .env without exporting secrets to the parent process. */
export function readDotEnv(): Record<string, string> {
  const file = join(REPO_ROOT, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export interface ForkSpec {
  network: NetworkKey;
  port: number;
  forkUrl: string;
  forkBlock?: number;
}

export function forkSpecs(env: Record<string, string>): Record<NetworkKey, ForkSpec> {
  return {
    "arbitrum-sepolia": {
      network: "arbitrum-sepolia",
      port: 8701,
      forkUrl: env.ARB_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
    },
    "kelp-replay": {
      network: "kelp-replay",
      port: 8702,
      forkUrl: env.ARB_ONE_ARCHIVE_RPC ?? "https://arbitrum.gateway.tenderly.co",
      forkBlock: 453_918_025, // 2026-04-18 21:51 UTC: Aave WETH 0.0001 withdrawable of 148,194 supplied
    },
    "robinhood-testnet": {
      network: "robinhood-testnet",
      port: 8703,
      forkUrl: env.ROBINHOOD_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
    },
    "earn-bank-run": {
      network: "earn-bank-run",
      port: 8704,
      forkUrl: env.ROBINHOOD_MAINNET_RPC ?? "https://rpc.mainnet.chain.robinhood.com",
    },
  };
}

export function toolEnv(): NodeJS.ProcessEnv {
  const foundryBin = join(homedir(), ".foundry", "bin");
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, PATH: `${foundryBin}${sep}${process.env.PATH ?? ""}` };
}

export function startAnvil(spec: ForkSpec, log: (l: string) => void): ChildProcess {
  const args = ["--fork-url", spec.forkUrl, "--port", String(spec.port), "--silent", "--gas-limit", "100000000"];
  if (spec.forkBlock) args.push("--fork-block-number", String(spec.forkBlock));
  log(`  starting anvil on :${spec.port}${spec.forkBlock ? ` at block ${spec.forkBlock}` : ""}`);
  return spawn("anvil", args, { env: toolEnv(), stdio: "ignore" });
}

export function run(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...toolEnv(), ...extraEnv } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`${cmd} exited ${code}: ${out.slice(-2000)}`))));
  });
}

/** Deploys Exeunt to the fork with forge and returns the written deployment JSON. */
export async function deployToFork(spec: ForkSpec): Promise<unknown> {
  const outDir = "./deployments/local/e2e/";
  mkdirSync(join(CONTRACTS_DIR, outDir), { recursive: true });
  await run(
    "forge",
    ["script", "script/Deploy.s.sol", "--rpc-url", `http://127.0.0.1:${spec.port}`, "--broadcast", "--slow"],
    CONTRACTS_DIR,
    { DEPLOY_NETWORK: spec.network, PRIVATE_KEY: ANVIL_DEPLOYER_KEY, DEPLOY_OUT_DIR: outDir },
  );
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, outDir, `${spec.network}.json`), "utf8"));
}
