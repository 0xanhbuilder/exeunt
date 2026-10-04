import { decodeAbiParameters, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import {
  aaveExitMarketAbi,
  aavePoolAbi,
  erc20Abi,
  morphoMarketId,
  priceRouterAbi,
  vaultV2Abi,
  type ExeuntClient,
  type MorphoMarketParams,
} from "@exeunt/sdk";

/*
 * Venue reads the SDK does not cover yet (candidates for the SDK): Aave account data and per-asset debt,
 * oracle prices, and whether a Morpho buyer's market needs forced deallocation.
 */

const aaveReserveAbi = parseAbi([
  "struct ReserveConfigurationMap { uint256 data; }",
  "struct ReserveData { ReserveConfigurationMap configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }",
  "function getReserveData(address asset) view returns (ReserveData)",
]);

const vaultLiquidityAbi = parseAbi([
  "function liquidityAdapter() view returns (address)",
  "function liquidityData() view returns (bytes)",
]);

const MARKET_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
  },
] as const;

export interface AaveAccount {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: bigint;
  healthFactor: bigint;
}

export async function aaveAccount(exeunt: ExeuntClient, user: Address): Promise<AaveAccount> {
  const pool = exeunt.deployment.aavePool;
  if (!pool) throw new Error("not an Aave deployment");
  const r = await exeunt.client.readContract({
    address: pool,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [user],
  });
  return { totalCollateralBase: r[0], totalDebtBase: r[1], liquidationThresholdBps: r[3], healthFactor: r[5] };
}

/** The user's variable debt in `asset` on the deployment's Aave pool. */
export async function aaveVariableDebt(exeunt: ExeuntClient, asset: Address, user: Address): Promise<bigint> {
  const pool = exeunt.deployment.aavePool;
  if (!pool) throw new Error("not an Aave deployment");
  const reserve = await exeunt.client.readContract({
    address: pool,
    abi: aaveReserveAbi,
    functionName: "getReserveData",
    args: [asset],
  });
  // Not an Aave reserve on this chain (e.g. USDG on Arbitrum): nothing can be owed in it.
  if (isAddressEqual(reserve.variableDebtTokenAddress, zeroAddress)) return 0n;
  return exeunt.client.readContract({
    address: reserve.variableDebtTokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [user],
  });
}

export async function aaveFlashTerms(exeunt: ExeuntClient): Promise<{
  aaveChunk: bigint;
  externalChunk: bigint;
  premiumBps: bigint;
  maxLoops: bigint;
}> {
  const d = exeunt.deployment;
  if (!d.aavePool) throw new Error("not an Aave deployment");
  const [cap, premium, maxLoops] = await Promise.all([
    exeunt.client.readContract({ address: d.market, abi: aaveExitMarketAbi, functionName: "flashCapacity" }),
    exeunt.client.readContract({ address: d.aavePool, abi: aavePoolAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" }),
    exeunt.client.readContract({ address: d.market, abi: aaveExitMarketAbi, functionName: "MAX_LOOPS" }),
  ]);
  return { aaveChunk: cap[0], externalChunk: cap[1], premiumBps: BigInt(premium), maxLoops };
}

export async function aavePoolPremiumBps(exeunt: ExeuntClient): Promise<bigint> {
  const pool = exeunt.deployment.aavePool;
  if (!pool) throw new Error("not an Aave deployment");
  return BigInt(await exeunt.client.readContract({ address: pool, abi: aavePoolAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" }));
}


/** USD price with 8 decimals from the market's price router. */
export async function priceOf(exeunt: ExeuntClient, token: Address): Promise<bigint> {
  return exeunt.client.readContract({
    address: exeunt.deployment.priceRouter,
    abi: priceRouterAbi,
    functionName: "priceOf",
    args: [token],
  });
}

/**
 * Vault V2 withdrawals pull from its liquidity market. When the buyer borrows in another market, the
 * liquidity their repayment frees sits there, so the market must force-deallocate it (at a penalty).
 */
export async function morphoForceTerms(
  exeunt: ExeuntClient,
  market: MorphoMarketParams,
): Promise<{ force: boolean; penaltyWad: bigint }> {
  const d = exeunt.deployment;
  if (!d.earnVault || !d.adapter) throw new Error("not a Morpho deployment");
  const [adapter, data, penaltyWad] = await Promise.all([
    exeunt.client.readContract({ address: d.earnVault, abi: vaultLiquidityAbi, functionName: "liquidityAdapter" }),
    exeunt.client.readContract({ address: d.earnVault, abi: vaultLiquidityAbi, functionName: "liquidityData" }),
    exeunt.client.readContract({
      address: d.earnVault,
      abi: vaultV2Abi,
      functionName: "forceDeallocatePenalty",
      args: [d.adapter],
    }),
  ]);
  return { force: !isLiquidityMarket(adapter, data, d.adapter, market), penaltyWad };
}

export function isLiquidityMarket(
  liquidityAdapter: Address,
  liquidityData: Hex,
  marketAdapter: Address,
  market: MorphoMarketParams,
): boolean {
  if (!isAddressEqual(liquidityAdapter, marketAdapter) || liquidityData === "0x") return false;
  try {
    const [mp] = decodeAbiParameters(MARKET_PARAMS, liquidityData);
    return morphoMarketId(mp) === morphoMarketId(market);
  } catch {
    return false;
  }
}
