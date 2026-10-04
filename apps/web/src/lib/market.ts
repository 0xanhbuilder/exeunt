import type { Address } from "viem";
import { aaveExitMarketAbi, exeuntVaultAbi, type ExeuntClient, type TokenInfo, type Venue } from "@exeunt/sdk";
import { aaveFlashPayIndices } from "./paymask";

export class NotDeployedAtRpcError extends Error {}

export interface VaultMeta {
  address: Address;
  asset: TokenInfo;
  name: string;
  symbol: string;
  decimals: number;
  minDiscountBps: number;
  maxShareBps: number;
  payIdx: number;
}

/** Static facts about one deployment, read once per network. */
export interface MarketMeta {
  venue: Venue;
  underlying: TokenInfo;
  receipt: TokenInfo;
  payTokens: TokenInfo[];
  vault: VaultMeta;
  maxDiscountBps: number;
  maxSessionDuration: number;
  /** Aave: payment tokens a buyer can pay with from freed collateral. Morpho decides this per buyer. */
  aaveFlashPayIdx: number[];
}

export async function loadMarketMeta(exeunt: ExeuntClient, rpcHint: string): Promise<MarketMeta> {
  const d = exeunt.deployment;
  const pc = exeunt.client;
  const code = await pc.getCode({ address: d.market });
  if (!code || code === "0x") {
    throw new NotDeployedAtRpcError(`No Exeunt market at ${d.market} on this RPC. ${rpcHint}`);
  }
  const v = d.exeuntVault;
  const [underlying, receipt, payTokens, maxDiscountBps, maxSessionDuration, vaultAsset, name, symbol, decimals, strategy] =
    await Promise.all([
      exeunt.token(d.underlying),
      exeunt.token(d.receipt),
      exeunt.payTokens(),
      pc.readContract({ address: d.market, abi: aaveExitMarketAbi, functionName: "MAX_DISCOUNT_BPS" }),
      pc.readContract({ address: d.market, abi: aaveExitMarketAbi, functionName: "MAX_SESSION_DURATION" }),
      pc.readContract({ address: v, abi: exeuntVaultAbi, functionName: "asset" }),
      pc.readContract({ address: v, abi: exeuntVaultAbi, functionName: "name" }),
      pc.readContract({ address: v, abi: exeuntVaultAbi, functionName: "symbol" }),
      pc.readContract({ address: v, abi: exeuntVaultAbi, functionName: "decimals" }),
      pc.readContract({ address: v, abi: exeuntVaultAbi, functionName: "strategy", args: [0n] }),
    ]);
  const asset = await exeunt.token(vaultAsset);
  return {
    venue: d.venue,
    underlying,
    receipt,
    payTokens,
    vault: {
      address: v,
      asset,
      name,
      symbol,
      decimals,
      minDiscountBps: strategy.minDiscountBps,
      maxShareBps: strategy.maxShareBps,
      payIdx: strategy.payIdx,
    },
    maxDiscountBps,
    maxSessionDuration,
    aaveFlashPayIdx: d.venue === "aave" ? aaveFlashPayIndices(d) : [],
  };
}

/** "WETH" on Aave, "USDG Earn vault" on Morpho. */
export function poolTitle(meta: MarketMeta): string {
  return meta.venue === "aave" ? meta.underlying.symbol : `${meta.underlying.symbol} Earn vault`;
}

export function poolSubtitle(meta: MarketMeta): string {
  return meta.venue === "aave" ? `Aave V3 · ${meta.receipt.symbol}` : `Morpho Vault · ${meta.receipt.symbol} shares`;
}

/** What a depositor holds: the aToken, or the vault's shares. */
export function receiptNoun(meta: MarketMeta): string {
  return meta.venue === "aave" ? meta.receipt.symbol : `${meta.receipt.symbol} vault shares`;
}

/** Known yield-bearing vault assets; anything else waits idle. */
export function baseYieldLine(asset: TokenInfo): string {
  if (/^wsteth$/i.test(asset.symbol)) return "wstETH staking yield: the vault holds wstETH and never lends it";
  return `none on this deployment: ${asset.symbol} waits idle in the vault, outside the pool it protects, so it is never frozen with it`;
}
