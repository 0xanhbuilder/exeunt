import { fileURLToPath } from "node:url";
import { NETWORKS, type NetworkKey } from "@exeunt/sdk";

export interface ChainLayerOptions {
  /** Folder holding `<network>.json`; `<dir>/local/<network>.json` is the fallback for forks and RPC-overridden networks. */
  deploymentsDir?: string;
  /** RPC URL per network; networks without one use NETWORKS[key].defaultRpcUrl. */
  rpcUrls?: Partial<Record<NetworkKey, string>>;
}

export const NETWORK_KEYS = Object.keys(NETWORKS) as [NetworkKey, ...NetworkKey[]];

/** "kelp-replay" -> "KELP_REPLAY". */
export function envSuffix(key: NetworkKey): string {
  return key.toUpperCase().replace(/-/g, "_");
}

/** <repo>/contracts/deployments, resolved from this file (src/ or dist/ of packages/mcp). */
export function defaultDeploymentsDir(): string {
  return fileURLToPath(new URL("../../../contracts/deployments", import.meta.url));
}

/** Reads EXEUNT_DEPLOYMENTS_DIR and EXEUNT_RPC_<KEY>. */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): Required<ChainLayerOptions> {
  const rpcUrls: Partial<Record<NetworkKey, string>> = {};
  for (const key of NETWORK_KEYS) {
    const url = env[`EXEUNT_RPC_${envSuffix(key)}`];
    if (url) rpcUrls[key] = url;
  }
  return { deploymentsDir: env.EXEUNT_DEPLOYMENTS_DIR || defaultDeploymentsDir(), rpcUrls };
}
