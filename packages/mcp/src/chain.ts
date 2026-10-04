import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import {
  ExeuntClient,
  NETWORKS,
  exeuntVaultAbi,
  morphoAbi,
  parseDeployment,
  type Deployment,
  type NetworkInfo,
  type NetworkKey,
} from "@exeunt/sdk";
import { defaultDeploymentsDir, NETWORK_KEYS, type ChainLayerOptions } from "./config.js";
import { ToolError } from "./errors.js";

/** The SDK surface the tools use. ExeuntClient satisfies it; tests stub its reads. */
export type MarketSdk = Pick<
  ExeuntClient,
  | "deployment"
  | "token"
  | "payTokens"
  | "capacity"
  | "bidCapacityAt"
  | "session"
  | "sessions"
  | "bids"
  | "quote"
  | "balanceOf"
  | "receiptAmountFor"
  | "allowance"
  | "position"
  | "venueData"
  | "planSellNow"
  | "approve"
  | "openSession"
  | "withdrawUnsold"
  | "buyAndRepay"
  | "buyAndRepayWithCollateral"
  | "placeBid"
  | "cancelBid"
  | "sellNow"
  | "vaultDeposit"
  | "vaultRedeem"
  | "routeRepayWithFrozenCollateral"
>;

export type CallOutcome = { ok: true; returnData: Hex } | { ok: false; revertData?: Hex; message: string };

/** Chain reads the SDK does not expose. */
export interface ChainReads {
  vaultAsset(): Promise<Address>;
  vaultPreviewRedeem(shares: bigint): Promise<{ assets: bigint; receipts: readonly bigint[] }>;
  morphoNonce(account: Address): Promise<bigint>;
  latestTimestamp(): Promise<bigint>;
  call(tx: { from: Address; to: Address; data: Hex; value: bigint }): Promise<CallOutcome>;
}

export interface NetworkHandle {
  info: NetworkInfo;
  deployment: Deployment;
  sdk: MarketSdk;
  reads: ChainReads;
}

export interface NetworkListing {
  info: NetworkInfo;
  deployment: Deployment | null;
}

export interface ExeuntChain {
  list(): NetworkListing[];
  /** Throws a ToolError when the network has no deployment. */
  get(key: NetworkKey): NetworkHandle;
}

/** First non-empty `data` hex string along an error's cause chain (viem nests the RPC error). */
export function findRevertData(err: unknown): Hex | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 10; depth++) {
    if (typeof current !== "object") break;
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x") && data.length > 2) return data as Hex;
    if (data && typeof data === "object") {
      const nested = (data as { data?: unknown }).data;
      if (typeof nested === "string" && nested.startsWith("0x") && nested.length > 2) return nested as Hex;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

class RpcReads implements ChainReads {
  constructor(
    private readonly client: PublicClient,
    private readonly deployment: Deployment,
  ) {}

  vaultAsset(): Promise<Address> {
    return this.client.readContract({ address: this.deployment.exeuntVault, abi: exeuntVaultAbi, functionName: "asset" });
  }

  async vaultPreviewRedeem(shares: bigint): Promise<{ assets: bigint; receipts: readonly bigint[] }> {
    const [assets, receipts] = await this.client.readContract({
      address: this.deployment.exeuntVault,
      abi: exeuntVaultAbi,
      functionName: "previewRedeem",
      args: [shares],
    });
    return { assets, receipts };
  }

  morphoNonce(account: Address): Promise<bigint> {
    const morpho = this.deployment.morpho;
    if (!morpho) throw new ToolError("this network has no Morpho deployment");
    return this.client.readContract({ address: morpho, abi: morphoAbi, functionName: "nonce", args: [account] });
  }

  async latestTimestamp(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp;
  }

  async call(tx: { from: Address; to: Address; data: Hex; value: bigint }): Promise<CallOutcome> {
    try {
      const res = await this.client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value });
      return { ok: true, returnData: res.data ?? "0x" };
    } catch (err) {
      const short = (err as { shortMessage?: unknown }).shortMessage;
      const message = typeof short === "string" ? short : err instanceof Error ? err.message : "call failed";
      return { ok: false, revertData: findRevertData(err), message };
    }
  }
}

interface LoadedDeployment {
  deployment: Deployment;
  path: string;
  mtimeMs: number;
}

/** Network access over JSON-RPC, with deployments read from disk (re-read when the file changes). */
export class RpcChainLayer implements ExeuntChain {
  private readonly deploymentsDir: string;
  private readonly handles = new Map<NetworkKey, { mtimeMs: number; path: string; handle: NetworkHandle }>();

  constructor(private readonly options: ChainLayerOptions = {}) {
    this.deploymentsDir = options.deploymentsDir ?? defaultDeploymentsDir();
  }

  rpcUrl(key: NetworkKey): string {
    return this.options.rpcUrls?.[key] ?? NETWORKS[key].defaultRpcUrl;
  }

  private load(key: NetworkKey): LoadedDeployment | null {
    // Local fork deployments only stand in for a live network when its RPC is overridden (pointed at a fork).
    const allowLocal = NETWORKS[key].isFork || this.options.rpcUrls?.[key] !== undefined;
    const candidates = [
      join(this.deploymentsDir, `${key}.json`),
      ...(allowLocal ? [join(this.deploymentsDir, "local", `${key}.json`)] : []),
    ];
    const path = candidates.find((p) => existsSync(p));
    if (!path) return null;
    const deployment = parseDeployment(JSON.parse(readFileSync(path, "utf8")));
    if (deployment.network !== key) throw new ToolError(`${path} describes ${deployment.network}, not ${key}`);
    return { deployment, path, mtimeMs: statSync(path).mtimeMs };
  }

  list(): NetworkListing[] {
    return NETWORK_KEYS.map((key) => {
      let deployment: Deployment | null = null;
      try {
        deployment = this.load(key)?.deployment ?? null;
      } catch {
        deployment = null;
      }
      return { info: NETWORKS[key], deployment };
    });
  }

  get(key: NetworkKey): NetworkHandle {
    const loaded = this.load(key);
    if (!loaded) {
      throw new ToolError(`No Exeunt deployment found for ${key}. Use list_networks to see deployed networks.`);
    }
    const cached = this.handles.get(key);
    if (cached && cached.mtimeMs === loaded.mtimeMs && cached.path === loaded.path) return cached.handle;
    const info = NETWORKS[key];
    const client = createPublicClient({ chain: info.chain, transport: http(this.rpcUrl(key), { timeout: 20_000 }) });
    const handle: NetworkHandle = {
      info,
      deployment: loaded.deployment,
      sdk: new ExeuntClient(loaded.deployment, client),
      reads: new RpcReads(client, loaded.deployment),
    };
    this.handles.set(key, { mtimeMs: loaded.mtimeMs, path: loaded.path, handle });
    return handle;
  }
}

export function createChainLayer(options: ChainLayerOptions = {}): ExeuntChain {
  return new RpcChainLayer(options);
}
