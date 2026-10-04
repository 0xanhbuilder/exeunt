import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { ExeuntClient, NETWORKS, parseDeployment, type Deployment, type NetworkKey, type TokenInfo } from "@exeunt/sdk";
import { AppError, ErrorCode } from "../../errors/AppError.js";

export interface ChainGatewayOptions {
  /** Folder with `<network>.json`; `<dir>/local/<network>.json` is the fallback for forks and RPC-overridden networks. */
  deploymentsDir: string;
  rpcUrls: Partial<Record<NetworkKey, string>>;
  rpcTimeoutMs?: number;
}

export interface CapacityReading {
  withdrawable: bigint;
  supplied: bigint;
  utilizationBps: number;
  debtorCapacity: bigint;
  sessionAssets: bigint;
  bidCapacity: { discountBps: number; assets: bigint }[];
  underlying: TokenInfo;
}

interface LoadedDeployment {
  deployment: Deployment;
  path: string;
  mtimeMs: number;
}

function upstream(err: unknown, what: string): AppError {
  const short = (err as { shortMessage?: unknown } | null)?.shortMessage;
  const reason = typeof short === "string" ? short : err instanceof Error ? err.message : "unknown error";
  return new AppError(502, ErrorCode.UPSTREAM_ERROR, `${what}: ${reason}`);
}

/** On-chain access for every module: deployments on disk, one RPC client per network, SDK reads. */
export class ChainGateway {
  private readonly clients = new Map<NetworkKey, PublicClient>();
  private readonly sdks = new Map<NetworkKey, { mtimeMs: number; path: string; sdk: ExeuntClient }>();

  constructor(private readonly options: ChainGatewayOptions) {}

  rpcUrl(key: NetworkKey): string {
    return this.options.rpcUrls[key] ?? NETWORKS[key].defaultRpcUrl;
  }

  private load(key: NetworkKey): LoadedDeployment | null {
    const dir = this.options.deploymentsDir;
    // Local fork deployments only stand in for a live network when its RPC is overridden (pointed at a fork).
    const allowLocal = NETWORKS[key].isFork || this.options.rpcUrls[key] !== undefined;
    const candidates = [join(dir, `${key}.json`), ...(allowLocal ? [join(dir, "local", `${key}.json`)] : [])];
    const path = candidates.find((p) => existsSync(p));
    if (!path) return null;
    try {
      const deployment = parseDeployment(JSON.parse(readFileSync(path, "utf8")));
      if (deployment.network !== key) return null;
      return { deployment, path, mtimeMs: statSync(path).mtimeMs };
    } catch {
      return null;
    }
  }

  /** The network's deployment, or null when no valid deployment file exists. */
  deployment(key: NetworkKey): Deployment | null {
    return this.load(key)?.deployment ?? null;
  }

  requireDeployment(key: NetworkKey): Deployment {
    const d = this.deployment(key);
    if (!d) throw new AppError(404, ErrorCode.DEPLOYMENT_NOT_FOUND, `No Exeunt deployment for ${key}`);
    return d;
  }

  deployedNetworks(): NetworkKey[] {
    return (Object.keys(NETWORKS) as NetworkKey[]).filter((k) => this.deployment(k) !== null);
  }

  publicClient(key: NetworkKey): PublicClient {
    const existing = this.clients.get(key);
    if (existing) return existing;
    const client = createPublicClient({
      chain: NETWORKS[key].chain,
      transport: http(this.rpcUrl(key), { timeout: this.options.rpcTimeoutMs ?? 15_000 }),
    });
    this.clients.set(key, client);
    return client;
  }

  private sdk(key: NetworkKey): ExeuntClient {
    const loaded = this.load(key);
    if (!loaded) throw new AppError(404, ErrorCode.DEPLOYMENT_NOT_FOUND, `No Exeunt deployment for ${key}`);
    const cached = this.sdks.get(key);
    if (cached && cached.mtimeMs === loaded.mtimeMs && cached.path === loaded.path) return cached.sdk;
    const sdk = new ExeuntClient(loaded.deployment, this.publicClient(key));
    this.sdks.set(key, { mtimeMs: loaded.mtimeMs, path: loaded.path, sdk });
    return sdk;
  }

  /** True when the RPC answers eth_chainId within `timeoutMs`. */
  async isReachable(key: NetworkKey, timeoutMs = 3_000): Promise<boolean> {
    const probe = createPublicClient({ transport: http(this.rpcUrl(key), { timeout: timeoutMs, retryCount: 0 }) });
    try {
      await probe.getChainId();
      return true;
    } catch {
      return false;
    }
  }

  /** Exit capacity from the market contract, plus escrowed bid capacity at each discount level. */
  async readCapacity(key: NetworkKey, discountLevelsBps: readonly number[]): Promise<CapacityReading> {
    const sdk = this.sdk(key);
    try {
      const [cap, underlying, levels] = await Promise.all([
        sdk.capacity(),
        sdk.token(sdk.deployment.underlying),
        Promise.all(discountLevelsBps.map((d) => sdk.bidCapacityAt(d))),
      ]);
      return {
        ...cap,
        bidCapacity: discountLevelsBps.map((discountBps, i) => ({ discountBps, assets: levels[i] ?? 0n })),
        underlying,
      };
    } catch (err) {
      throw upstream(err, `Reading capacity on ${key} failed`);
    }
  }
}
