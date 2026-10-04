import { NETWORKS, type NetworkKey } from "@exeunt/sdk";

const DEFAULT_API_URL = "http://127.0.0.1:8787";

/** "arbitrum-sepolia" -> "VITE_RPC_ARBITRUM_SEPOLIA". */
export function rpcEnvName(key: NetworkKey): string {
  return `VITE_RPC_${key.toUpperCase().replace(/-/g, "_")}`;
}

function readEnv(env: Record<string, unknown>, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function resolveRpcUrl(key: NetworkKey, env: Record<string, unknown>): string {
  return readEnv(env, rpcEnvName(key)) ?? NETWORKS[key].defaultRpcUrl;
}

export function resolveApiUrl(env: Record<string, unknown>): string {
  return (readEnv(env, "VITE_API_URL") ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

const viteEnv = import.meta.env as Record<string, unknown>;

export function rpcUrlFor(key: NetworkKey): string {
  return resolveRpcUrl(key, viteEnv);
}

export function apiBaseUrl(): string {
  return resolveApiUrl(viteEnv);
}
