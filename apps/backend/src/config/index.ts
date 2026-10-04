import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { NETWORKS, type NetworkKey } from "@exeunt/sdk";
import { z } from "zod";

const BACKEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const DEFAULT_DB_PATH = `${BACKEND_ROOT}data/exeunt.db`;
export const DEFAULT_DEPLOYMENTS_DIR = `${REPO_ROOT}contracts/deployments`;

const NETWORK_KEYS = Object.keys(NETWORKS) as NetworkKey[];

/** "kelp-replay" -> "RPC_KELP_REPLAY". */
export function rpcEnvName(key: NetworkKey): string {
  return `RPC_${key.toUpperCase().replace(/-/g, "_")}`;
}

// Empty env values count as unset.
const blankAsUnset = (v: unknown) => (v === "" ? undefined : v);
const env = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankAsUnset, schema);

const envSchema = z.object({
  PORT: env(z.coerce.number().int().min(1).max(65_535).default(8787)),
  DB_PATH: env(z.string().min(1).default(DEFAULT_DB_PATH)),
  POLL_INTERVAL_MS: env(z.coerce.number().int().min(1_000).default(60_000)),
  WEBHOOK_SECRET: env(z.string().min(1).optional()),
  CORS_ORIGIN: env(z.string().min(1).default("*")),
  DEPLOYMENTS_DIR: env(z.string().min(1).default(DEFAULT_DEPLOYMENTS_DIR)),
  NODE_ID: env(z.string().min(1).default(hostname())),
  LOG_LEVEL: env(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")),
});

export interface AppConfig {
  port: number;
  dbPath: string;
  pollIntervalMs: number;
  webhookSecret?: string;
  corsOrigin: string;
  deploymentsDir: string;
  rpcUrls: Partial<Record<NetworkKey, string>>;
  nodeId: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

/** Validates the environment once at startup; throws with every problem listed. */
export function loadConfig(vars: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const parsed = envSchema.safeParse(vars);
  if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

  const rpcSchema = env(z.string().url().optional());
  const rpcUrls: Partial<Record<NetworkKey, string>> = {};
  for (const key of NETWORK_KEYS) {
    const name = rpcEnvName(key);
    const url = rpcSchema.safeParse(vars[name]);
    if (!url.success) problems.push(`${name}: must be a URL`);
    else if (typeof url.data === "string") rpcUrls[key] = url.data;
  }

  if (!parsed.success || problems.length > 0) throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  const e = parsed.data;
  const config: AppConfig = {
    port: e.PORT,
    dbPath: e.DB_PATH,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    corsOrigin: e.CORS_ORIGIN,
    deploymentsDir: e.DEPLOYMENTS_DIR,
    rpcUrls,
    nodeId: e.NODE_ID,
    logLevel: e.LOG_LEVEL,
  };
  if (e.WEBHOOK_SECRET !== undefined) config.webhookSecret = e.WEBHOOK_SECRET;
  return config;
}
