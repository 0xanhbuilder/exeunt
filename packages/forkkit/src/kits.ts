import { encodeFunctionData, maxUint256, type Address, type PublicClient } from "viem";
import { aavePoolAbi, erc20Abi, ExeuntClient, morphoAbi, vaultV2Abi, type Deployment, type MorphoMarketParams } from "@exeunt/sdk";
import { Anvil } from "./anvil.js";

/** Fixed fork-only helper accounts. They hold no keys; anvil impersonation signs for them. */
export const FREEZER: Address = "0x00000000000000000000000000000000f12ee2e1";
export const LIQUIDITY_HELPER: Address = "0x00000000000000000000000000000000110a1d01";

const ETH = 10n ** 18n;

export interface KitContext {
  anvil: Anvil;
  client: PublicClient;
  deployment: Deployment;
  sdk: ExeuntClient;
}

export function kitContext(client: PublicClient, deployment: Deployment): KitContext {
  return { anvil: new Anvil(client), client, deployment, sdk: new ExeuntClient(deployment, client) };
}

async function send(ctx: KitContext, from: Address, to: Address, data: `0x${string}`) {
  return ctx.anvil.sendAs(from, to, data);
}

async function approve(ctx: KitContext, from: Address, token: Address, spender: Address) {
  await send(ctx, from, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }));
}

export async function fundGas(ctx: KitContext, user: Address, eth = 10n * ETH): Promise<void> {
  await ctx.anvil.setBalance(user, eth);
}

/* ------------------------------------------------------------------ */
/*                               Aave                                  */
/* ------------------------------------------------------------------ */

function aave(ctx: KitContext) {
  const d = ctx.deployment;
  if (d.venue !== "aave" || !d.aavePool || !d.debtToken) throw new Error("not an Aave deployment");
  const usdc = d.payTokens[1];
  if (!usdc) throw new Error("Aave deployment needs USDC as pay token 1");
  return { pool: d.aavePool, weth: d.underlying, usdc, debtToken: d.debtToken, aToken: d.receipt };
}

/** USDC collateral generous enough to borrow `wethDebt` (at up to $8,000 per ETH and 50% LTV). */
function usdcCollateralFor(wethDebt: bigint): bigint {
  return (wethDebt * 16_000n) / 10n ** 12n + 1_000n * 10n ** 6n;
}

async function aaveSupply(ctx: KitContext, from: Address, asset: Address, amount: bigint, onBehalf: Address) {
  const { pool } = aave(ctx);
  await ctx.anvil.dealErc20(asset, from, amount);
  await approve(ctx, from, asset, pool);
  await send(ctx, from, pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [asset, amount, onBehalf, 0] }));
}

async function aaveBorrow(ctx: KitContext, who: Address, asset: Address, amount: bigint) {
  const { pool } = aave(ctx);
  await send(ctx, who, pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [asset, amount, 2n, 0, who] }));
}

async function aaveLiquidity(ctx: KitContext): Promise<bigint> {
  const { weth, aToken } = aave(ctx);
  return ctx.sdk.balanceOf(weth, aToken);
}

/** Borrows WETH from FREEZER until at most `leave` is withdrawable, restoring the frozen state. */
async function aaveRefreeze(ctx: KitContext, leave: bigint): Promise<void> {
  const { usdc, weth } = aave(ctx);
  const liquidity = await aaveLiquidity(ctx);
  if (liquidity <= leave) return;
  const amount = liquidity - leave;
  await aaveSupply(ctx, FREEZER, usdc, usdcCollateralFor(amount), FREEZER);
  await aaveBorrow(ctx, FREEZER, weth, amount);
}

/* ------------------------------------------------------------------ */
/*                              Morpho                                 */
/* ------------------------------------------------------------------ */

function morpho(ctx: KitContext) {
  const d = ctx.deployment;
  if (d.venue !== "morpho" || !d.morpho || !d.earnVault || !d.collateral) throw new Error("not a Morpho deployment");
  return { morpho: d.morpho, vault: d.earnVault, usdg: d.underlying, collateral: d.collateral };
}

/** Adapter market whose collateral is the deployment's collateral token (the Earn liquidity market). */
async function borrowMarket(ctx: KitContext): Promise<MorphoMarketParams> {
  const { collateral } = morpho(ctx);
  const markets = await ctx.sdk.morphoMarkets();
  const m = markets.find((x) => x.params.collateralToken.toLowerCase() === collateral.toLowerCase());
  if (!m) throw new Error("no adapter market with the deployment's collateral");
  return m.params;
}

/** Collateral amount (18 decimals assumed for priceable stable collateral) for borrowing `usdgDebt` (6 decimals). */
async function collateralFor(ctx: KitContext, market: MorphoMarketParams, usdgDebt: bigint): Promise<bigint> {
  const price = await ctx.client.readContract({
    address: market.oracle,
    abi: [{ type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "price",
  });
  // collateral * price / 1e36 * lltv >= debt, with a 2x margin
  return (usdgDebt * 10n ** 36n * 2n * ETH) / (price * market.lltv) + 1n;
}

async function morphoSupplyCollateralAndBorrow(ctx: KitContext, who: Address, market: MorphoMarketParams, debt: bigint) {
  const m = morpho(ctx);
  const coll = await collateralFor(ctx, market, debt);
  await ctx.anvil.dealErc20(market.collateralToken, who, coll);
  await approve(ctx, who, market.collateralToken, m.morpho);
  await send(ctx, who, m.morpho, encodeFunctionData({
    abi: morphoAbi,
    functionName: "supplyCollateral",
    args: [market, coll, who, "0x"],
  }));
  await send(ctx, who, m.morpho, encodeFunctionData({
    abi: morphoAbi,
    functionName: "borrow",
    args: [market, debt, 0n, who, who],
  }));
}

async function marketLiquidity(ctx: KitContext, id: `0x${string}`): Promise<bigint> {
  const { morpho: mo } = morpho(ctx);
  const m = await ctx.client.readContract({ address: mo, abi: morphoAbi, functionName: "market", args: [id] });
  return m[0] - m[2];
}

/** Borrows every adapter market's free liquidity from FREEZER (keeps `leave` per market). */
async function morphoRefreeze(ctx: KitContext, leave: bigint): Promise<void> {
  const markets = await ctx.sdk.morphoMarkets();
  for (const { id, params } of markets) {
    const liq = await marketLiquidity(ctx, id);
    if (liq <= leave) continue;
    await morphoSupplyCollateralAndBorrow(ctx, FREEZER, params, liq - leave);
  }
}

async function morphoDeposit(ctx: KitContext, who: Address, amount: bigint) {
  const { vault, usdg } = morpho(ctx);
  await ctx.anvil.dealErc20(usdg, who, amount);
  await approve(ctx, who, usdg, vault);
  await send(ctx, who, vault, encodeFunctionData({ abi: vaultV2Abi, functionName: "deposit", args: [amount, who] }));
}

/* ------------------------------------------------------------------ */
/*                          Venue-agnostic kits                        */
/* ------------------------------------------------------------------ */

/** Restores the frozen state: at most `leave` withdrawable (per market on Morpho). */
export async function refreeze(ctx: KitContext, leave = 0n): Promise<void> {
  if (ctx.deployment.venue === "aave") return aaveRefreeze(ctx, leave);
  return morphoRefreeze(ctx, leave);
}

/** Gives `user` deposit receipts worth about `amount` of the underlying, then re-freezes the pool. */
export async function sellerKit(ctx: KitContext, user: Address, amount: bigint, leave = 0n): Promise<void> {
  await fundGas(ctx, user);
  if (ctx.deployment.venue === "aave") {
    await aaveSupply(ctx, LIQUIDITY_HELPER, aave(ctx).weth, amount, user);
  } else {
    await morphoDeposit(ctx, user, amount);
  }
  await refreeze(ctx, leave);
}

/** Gives `user` a same-asset debt of `debt` with ample collateral, leaving the pool frozen. */
export async function borrowerKit(ctx: KitContext, user: Address, debt: bigint, leave = 0n): Promise<void> {
  await fundGas(ctx, user);
  if (ctx.deployment.venue === "aave") {
    const { weth, usdc } = aave(ctx);
    // Add exactly the liquidity the borrower takes, so the pool stays frozen.
    await aaveSupply(ctx, LIQUIDITY_HELPER, weth, debt, LIQUIDITY_HELPER);
    await aaveSupply(ctx, user, usdc, usdcCollateralFor(debt), user);
    await aaveBorrow(ctx, user, weth, debt);
  } else {
    await morphoDeposit(ctx, LIQUIDITY_HELPER, debt);
    await morphoSupplyCollateralAndBorrow(ctx, user, await borrowMarket(ctx), debt);
  }
  await refreeze(ctx, leave);
}

/** Gives `user` every payment token so they can place bids or deposit into the Exeunt Vault. */
export async function bidderKit(ctx: KitContext, user: Address, perToken: Record<Address, bigint>): Promise<void> {
  await fundGas(ctx, user);
  for (const [token, amount] of Object.entries(perToken) as [Address, bigint][]) {
    await ctx.anvil.dealErc20(token, user, amount);
  }
}

/** Default bidder amounts: 100k of each stable, 50 of each ETH-like token. */
export async function defaultBidderAmounts(ctx: KitContext): Promise<Record<Address, bigint>> {
  const out: Record<Address, bigint> = {};
  for (const t of await ctx.sdk.payTokens()) {
    out[t.address] = t.decimals === 6 ? 100_000n * 10n ** 6n : 50n * 10n ** BigInt(t.decimals);
  }
  return out;
}

export { maxUint256 };
