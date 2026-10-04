import { encodeFunctionData, formatUnits, maxUint256, parseEther, type Address, type Hex } from "viem";
import { morphoAbi, testTokenAbi, vaultV2Abi, type ExeuntClient, type MorphoMarketParams, type SessionParams, type UnsignedTx } from "@exeunt/sdk";
import { ensureAllowance, send, type Actor } from "../lib/chain.js";
import { check, type Recorder } from "../lib/report.js";

const USD = 10n ** 6n;
const fmt = (v: bigint, d = 6) => Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 6 });

function raw(to: Address, data: Hex, description: string, value = 0n): UnsignedTx {
  return { to, data, value, description };
}

async function marketParams(sdk: ExeuntClient, id: Hex): Promise<MorphoMarketParams> {
  const [loanToken, collateralToken, oracle, irm, lltv] = await sdk.client.readContract({
    address: sdk.deployment.morpho as Address,
    abi: morphoAbi,
    functionName: "idToMarketParams",
    args: [id],
  });
  return { loanToken, collateralToken, oracle, irm, lltv };
}

async function liquidity(sdk: ExeuntClient, id: Hex): Promise<bigint> {
  const m = await sdk.client.readContract({ address: sdk.deployment.morpho as Address, abi: morphoAbi, functionName: "market", args: [id] });
  return m[0] - m[2];
}

/**
 * Live Robinhood Testnet run on the self-deployed Morpho Earn stack with real Paxos testnet USDG.
 * The deployer seeds the Earn vault and borrows its liquidity out so it is frozen; the second account borrows and buys.
 */
export async function liveMorphoScenario(
  r: Recorder,
  sdk: ExeuntClient,
  actors: { seller: Actor; buyer: Actor },
): Promise<void> {
  const d = sdk.deployment;
  const { seller, buyer } = actors;
  const usdg = d.underlying;
  const coll = d.collateral as Address;
  const morpho = d.morpho as Address;
  const vault = d.earnVault as Address;
  const earn = await marketParams(sdk, d.earnMarketId as Hex);
  const flash = await marketParams(sdk, d.flashMarketId as Hex);
  const params = (startBps: number): SessionParams => ({ startBps, stepBps: 50, stepInterval: 3600, capBps: 1500, duration: 3 * 86400, payMask: 0b11 });

  const borrow = async (who: Actor, amount: bigint) => {
    const collateral = amount * 2n * 10n ** 12n; // sim-USDe has 18 decimals, priced 1:1 with USDG
    await send(r, sdk, who, raw(coll, encodeFunctionData({ abi: testTokenAbi, functionName: "mint", args: [who.address, collateral] }), "Mint test collateral"));
    await ensureAllowance(r, sdk, who, coll, morpho, collateral);
    await send(r, sdk, who, raw(morpho, encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [earn, collateral, who.address, "0x"] }), "Supply collateral"));
    await send(r, sdk, who, raw(morpho, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [earn, amount, 0n, who.address, who.address] }), "Borrow USDG"));
  };

  await r.step("fund the buyer with gas", async () => {
    if ((await sdk.client.getBalance({ address: buyer.address })) < parseEther("0.002")) {
      const hash = await seller.wallet.sendTransaction({ account: seller.account, chain: seller.wallet.chain, to: buyer.address, value: parseEther("0.003") });
      r.noteTx(hash);
      await sdk.client.waitForTransactionReceipt({ hash });
    }
    return { buyerETH: fmt(await sdk.client.getBalance({ address: buyer.address }), 18) };
  });

  await r.step("seed: 15 USDG of flash liquidity in a separate Morpho market", async () => {
    const have = await liquidity(sdk, d.flashMarketId as Hex);
    if (have < 10n * USD) {
      await ensureAllowance(r, sdk, seller, usdg, morpho, 15n * USD);
      await send(r, sdk, seller, raw(morpho, encodeFunctionData({ abi: morphoAbi, functionName: "supply", args: [flash, 15n * USD, 0n, seller.address, "0x"] }), "Supply flash liquidity"));
    }
    return { flashLiquidityUSDG: fmt(await liquidity(sdk, d.flashMarketId as Hex)) };
  });

  await r.step("seed: seller deposits 50 USDG into the Earn vault", async () => {
    if ((await sdk.receiptValueOf(seller.address)) < 20n * USD) {
      await ensureAllowance(r, sdk, seller, usdg, vault, 50n * USD);
      await send(r, sdk, seller, raw(vault, encodeFunctionData({ abi: vaultV2Abi, functionName: "deposit", args: [50n * USD, seller.address] }), "Deposit into Earn"));
    }
    return { sellerPositionUSDG: fmt(await sdk.receiptValueOf(seller.address)) };
  });

  await r.step("seed: buyer borrows 20 USDG; the seller borrows what is left so the vault is frozen", async () => {
    if ((await sdk.position(buyer.address)).debt < 10n * USD) await borrow(buyer, 20n * USD);
    const left = await liquidity(sdk, d.earnMarketId as Hex);
    if (left > 0n) await borrow(seller, left);
    const c = await sdk.capacity();
    check(c.utilizationBps >= 9_990, `utilization ${c.utilizationBps}`);
    return { utilization: `${c.utilizationBps / 100}%`, withdrawableUSDG: fmt(c.withdrawable), buyerDebtUSDG: fmt((await sdk.position(buyer.address)).debt) };
  });

  await r.step("seller takes back unsold shares from earlier runs", async () => {
    const mine = (await sdk.sessions(true)).filter((x) => x.seller === seller.address);
    for (const s of mine) await send(r, sdk, seller, sdk.withdrawUnsold(s.id));
    return { reclaimed: String(mine.length) };
  });

  let sessionId = 0n;
  await r.step("seller opens a Dutch auction for 10 USDG of Earn shares", async () => {
    const amount = await sdk.receiptAmountFor(10n * USD);
    await ensureAllowance(r, sdk, seller, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller, sdk.openSession(amount, params(100)));
    const s = (await sdk.sessions(true)).find((x) => x.seller === seller.address);
    check(!!s, "session missing");
    sessionId = s.id;
    return { sessionId: String(s.id) };
  });

  await r.step("buyer buys 3 USDG of shares with USDG; debt repaid in the same tx; liquidity unchanged", async () => {
    const assets = 3n * USD;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdg);
    const [pos, cap] = await Promise.all([sdk.position(buyer.address), sdk.capacity()]);
    await ensureAllowance(r, sdk, buyer, usdg, d.market, price);
    const { hash } = await send(r, sdk, buyer, sdk.buyAndRepay(sessionId, assets, 0, price, await sdk.venueData(buyer.address)));
    const [pos2, cap2] = await Promise.all([sdk.position(buyer.address), sdk.capacity()]);
    check(pos.debt - pos2.debt >= assets - 1_000n, "debt not repaid");
    return { tx: hash, paidUSDG: fmt(price), debtRepaidUSDG: fmt(pos.debt - pos2.debt), withdrawableBefore: fmt(cap.withdrawable), withdrawableAfter: fmt(cap2.withdrawable) };
  });

  await r.step("buyer buys 2 USDG in flash mode with two signatures; collateral to seller; authorization revoked", async () => {
    const assets = 2n * USD;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, coll);
    const auth = await sdk.signMorphoAuthorization(buyer.wallet, buyer.address);
    const { hash } = await send(r, sdk, buyer, sdk.buyAndRepayWithCollateral(sessionId, assets, 1, price, await sdk.venueData(buyer.address, { auth })));
    const still = await sdk.client.readContract({ address: morpho, abi: morphoAbi, functionName: "isAuthorized", args: [buyer.address, d.market] });
    check(!still, "authorization survived");
    return { tx: hash, paidSimUSDe: fmt(price, 18) };
  });

  let bidId = 0n;
  await r.step("buyer places a 5% USDG limit bid for up to 3 USDG", async () => {
    const escrow = await sdk.quote(3n * USD, 500, usdg);
    await ensureAllowance(r, sdk, buyer, usdg, d.market, escrow);
    await send(r, sdk, buyer, sdk.placeBid(500, 0, 3n * USD, escrow));
    const b = (await sdk.bids()).filter((x) => x.bidder === buyer.address).pop();
    check(!!b, "bid missing");
    bidId = b.id;
    return { bidId: String(b.id), escrowUSDG: fmt(escrow) };
  });

  await r.step("seller sells 1 USDG of shares now into the bid", async () => {
    const plan = await sdk.planSellNow(1n * USD, 500, 0b01);
    const { hash } = await send(r, sdk, seller, sdk.sellNow(plan, 500, 0b01, plan.filledAssets));
    return { tx: hash, proceedsUSDG: fmt(plan.proceeds[usdg] ?? 0n) };
  });

  await r.step("a session already at 6% is matched with the 5% bid", async () => {
    await send(r, sdk, seller, sdk.openSession(await sdk.receiptAmountFor(1n * USD), params(600)));
    const s = (await sdk.sessions(true)).find((x) => x.seller === seller.address && x.startBps === 600);
    check(!!s, "second session missing");
    const { hash } = await send(r, sdk, seller, sdk.matchBid(s.id, bidId));
    return { tx: hash };
  });

  await r.step("seller deposits 10 USDG into the Exeunt Vault and sells 1 USDG of shares into its 3% bid", async () => {
    await ensureAllowance(r, sdk, seller, usdg, d.exeuntVault, 10n * USD);
    await send(r, sdk, seller, sdk.vaultDeposit(10n * USD, seller.address));
    const plan = await sdk.planSellNow(1n * USD, 300, 0b01);
    check(plan.filledAssets > 0n, "no vault bid");
    const { hash } = await send(r, sdk, seller, sdk.sellNow(plan, 300, 0b01, 1n));
    const v = await sdk.vaultState(seller.address);
    return { tx: hash, vaultHeldUSDG: fmt(v.heldAssets), vaultTotalUSDG: fmt(v.totalAssets) };
  });

  await r.step("seller withdraws unsold shares; buyer cancels leftover bids", async () => {
    for (const s of (await sdk.sessions(true)).filter((x) => x.seller === seller.address)) {
      await send(r, sdk, seller, sdk.withdrawUnsold(s.id));
    }
    for (const b of (await sdk.bids()).filter((x) => x.bidder === buyer.address)) {
      await send(r, sdk, buyer, sdk.cancelBid(b.id));
    }
    return { sellerUSDG: fmt(await sdk.balanceOf(usdg, seller.address)) };
  });
}
