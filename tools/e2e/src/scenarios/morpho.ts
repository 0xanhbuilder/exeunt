import { encodeFunctionData, formatUnits, maxUint256, type Address, type Hex } from "viem";
import { erc20Abi, morphoAbi, vaultV2Abi, type ExeuntClient, type SessionParams } from "@exeunt/sdk";
import { FREEZER, LIQUIDITY_HELPER, bidderKit, borrowerKit, refreeze, sellerKit, type KitContext } from "@exeunt/forkkit";
import { ensureAllowance, expectRevert, send, type Actor } from "../lib/chain.js";
import { check, near, type Recorder } from "../lib/report.js";

const USD = 10n ** 6n;
const fmt = (v: bigint, d = 6) => Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 4 });

export interface MorphoScenarioOptions {
  /** Robinhood testnet stack: seed a separate Morpho market so flash liquidity exists. */
  seedFlashLiquidity?: bigint;
  /** Earn bank-run fork: real share holders who withdraw before the market drains. */
  bankRunHolders?: Address[];
}

async function approveAs(kit: KitContext, from: Address, token: Address, spender: Address) {
  await kit.anvil.sendAs(from, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }));
}

/** Withdraws as much as each holder can until normal withdrawals stop working. */
export async function bankRun(sdk: ExeuntClient, kit: KitContext, holders: Address[]): Promise<{ withdrawn: bigint; holders: number }> {
  const vault = sdk.deployment.earnVault as Address;
  let withdrawn = 0n;
  let count = 0;
  for (const h of holders) {
    const shares = await kit.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "balanceOf", args: [h] });
    if (shares === 0n) continue;
    const holderAssets = await kit.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares] });
    const exitable = (await sdk.capacity()).withdrawable;
    if (exitable <= 1n) break;
    // Each holder takes as much as the vault can still pay out (idle cash plus the liquidity market).
    let assets = holderAssets < exitable - 1n ? holderAssets : exitable - 1n;
    while (assets > 0n) {
      try {
        await kit.anvil.sendAs(h, vault, encodeFunctionData({ abi: vaultV2Abi, functionName: "withdraw", args: [assets, h, h] }));
        withdrawn += assets;
        count++;
        break;
      } catch {
        // The adapter rounds against the withdrawer; step down slightly.
        assets = (assets * 999n) / 1000n;
      }
    }
  }
  return { withdrawn, holders: count };
}

async function unfreeze(sdk: ExeuntClient, kit: KitContext): Promise<void> {
  const morpho = sdk.deployment.morpho as Address;
  const usdg = sdk.deployment.underlying;
  for (const { id, params } of await sdk.morphoMarkets()) {
    const pos = await kit.client.readContract({ address: morpho, abi: morphoAbi, functionName: "position", args: [id, FREEZER] });
    if (pos[1] === 0n) continue;
    const m = await kit.client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [id] });
    const owed = (pos[1] * m[2]) / m[3] + 1_000n * USD;
    await kit.anvil.dealErc20(usdg, FREEZER, owed);
    await approveAs(kit, FREEZER, usdg, morpho);
    await kit.anvil.sendAs(FREEZER, morpho, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params, 0n, pos[1], FREEZER, "0x"] }));
  }
}

/**
 * Full Morpho flow: frozen USDG Earn vault; seller exits through a borrower (wallet and flash mode with signed,
 * same-transaction-revoked collateral authorization), limit bids, a matched auction and the Exeunt Vault.
 */
export async function morphoScenario(
  r: Recorder,
  sdk: ExeuntClient,
  kit: KitContext,
  actors: { seller: Actor; buyer: Actor; bidder: Actor; depositor: Actor; keeper: Actor },
  opts: MorphoScenarioOptions,
): Promise<void> {
  const d = sdk.deployment;
  const { seller, buyer, bidder, depositor, keeper } = actors;
  const usdg = d.underlying;
  const collateral = d.payTokens[1] as Address;
  const morpho = d.morpho as Address;
  let sessionId = 0n;

  if (opts.seedFlashLiquidity) {
    await r.step("setup: a separate Morpho market holds idle USDG (flash-loan liquidity)", async () => {
      const [loanToken, collateralToken, oracle, irm, lltv] = await kit.client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [d.flashMarketId as Hex],
      });
      const amount = opts.seedFlashLiquidity as bigint;
      await kit.anvil.setBalance(LIQUIDITY_HELPER, 10n ** 18n);
      await kit.anvil.dealErc20(usdg, LIQUIDITY_HELPER, amount);
      await approveAs(kit, LIQUIDITY_HELPER, usdg, morpho);
      await kit.anvil.sendAs(LIQUIDITY_HELPER, morpho, encodeFunctionData({
        abi: morphoAbi,
        functionName: "supply",
        args: [{ loanToken, collateralToken, oracle, irm, lltv }, amount, 0n, LIQUIDITY_HELPER, "0x"],
      }));
      return { flashLiquidityUSDG: fmt(amount) };
    });
  }

  await r.step("setup: seller holds 100,000 USDG of Earn vault shares", async () => {
    await sellerKit(kit, seller.address, 100_000n * USD);
    const v = await sdk.receiptValueOf(seller.address);
    // Interest accrues while the kit re-freezes the vault.
    check(v >= 100_000n * USD - 2n && v <= 100_100n * USD, `seller position ${v}`);
    return { positionUSDG: fmt(v) };
  });

  await r.step("setup: buyer borrows 60,000 USDG against collateral in the vault's market", async () => {
    await borrowerKit(kit, buyer.address, 60_000n * USD);
    await bidderKit(kit, buyer.address, { [usdg]: 200_000n * USD });
    const pos = await sdk.position(buyer.address);
    check(pos.debt >= 60_000n * USD, `debt ${pos.debt}`);
    return { debtUSDG: fmt(pos.debt), health: fmt(pos.health, 18) };
  });

  if (opts.bankRunHolders) {
    await r.step("bank run: the largest Steakhouse holders withdraw until withdrawals stop", async () => {
      const before = await sdk.capacity();
      const run = await bankRun(sdk, kit, opts.bankRunHolders as Address[]);
      return { withdrawnUSDG: fmt(run.withdrawn), holders: String(run.holders), withdrawableBefore: fmt(before.withdrawable) };
    });
  }

  await r.step("setup: bidder and vault depositor funded; remaining liquidity borrowed out", async () => {
    await bidderKit(kit, bidder.address, { [usdg]: 300_000n * USD });
    await bidderKit(kit, depositor.address, { [usdg]: 100_000n * USD });
    await refreeze(kit);
  });

  await r.step("vault is frozen: utilization ~100%, nothing withdrawable", async () => {
    const c = await sdk.capacity();
    check(c.utilizationBps >= 9_990, `utilization ${c.utilizationBps}`);
    check(c.withdrawable <= 10n * USD, `withdrawable ${c.withdrawable}`);
    const flash = await sdk.balanceOf(usdg, morpho);
    check(flash > 0n, "no flash-loan liquidity anywhere in Morpho");
    return { utilization: `${c.utilizationBps / 100}%`, supplied: fmt(c.supplied), morphoFlashUSDG: fmt(flash) };
  });

  await r.step("seller opens a Dutch auction for 50,000 USDG of shares (accepts USDG and the collateral)", async () => {
    const amount = await sdk.receiptAmountFor(50_000n * USD);
    const p: SessionParams = { startBps: 100, stepBps: 50, stepInterval: 3600, capBps: 1500, duration: 7 * 86400, payMask: 0b11 };
    await ensureAllowance(r, sdk, seller, d.receipt, d.market, amount);
    await send(r, sdk, seller, sdk.openSession(amount, p));
    const s = (await sdk.sessions(true))[0];
    check(!!s && s.seller === seller.address, "session not found");
    sessionId = s.id;
    return { sessionId: String(s.id), sizeUSDG: fmt(s.remainingAssets) };
  });

  await r.step("buyer buys 20,000 USDG of shares with USDG; debt repaid in the same tx; liquidity unchanged", async () => {
    const assets = 20_000n * USD;
    const [before, pos, sellerUsdg] = await Promise.all([sdk.capacity(), sdk.position(buyer.address), sdk.balanceOf(usdg, seller.address)]);
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdg);
    await ensureAllowance(r, sdk, buyer, usdg, d.market, price);
    const venue = await sdk.venueData(buyer.address);
    const { gasUsed } = await send(r, sdk, buyer, sdk.buyAndRepay(sessionId, assets, 0, price, venue));
    const [after, posAfter, sellerUsdgAfter] = await Promise.all([sdk.capacity(), sdk.position(buyer.address), sdk.balanceOf(usdg, seller.address)]);
    // The repay block is one second after the read: allow that second of interest.
    near(pos.debt - posAfter.debt, assets, assets / 100_000n, "debt repaid");
    check(sellerUsdgAfter - sellerUsdg === price, "seller not paid");
    near(after.withdrawable, before.withdrawable, 2n, "withdrawable liquidity");
    return { paidUSDG: fmt(price), debtRepaidUSDG: fmt(pos.debt - posAfter.debt), gasUsed: gasUsed.toString() };
  });

  await r.step("buyer buys 10,000 USDG in flash mode: two signatures, collateral to seller, authorization revoked", async () => {
    const assets = 10_000n * USD;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, collateral);
    const [pos, sellerColl, buyerUsdg] = await Promise.all([
      sdk.position(buyer.address),
      sdk.balanceOf(collateral, seller.address),
      sdk.balanceOf(usdg, buyer.address),
    ]);
    const auth = await sdk.signMorphoAuthorization(buyer.wallet, buyer.address);
    const venue = await sdk.venueData(buyer.address, { auth });
    await send(r, sdk, buyer, sdk.buyAndRepayWithCollateral(sessionId, assets, 1, price, venue));
    const [posAfter, sellerCollAfter, buyerUsdgAfter, stillAuthorized] = await Promise.all([
      sdk.position(buyer.address),
      sdk.balanceOf(collateral, seller.address),
      sdk.balanceOf(usdg, buyer.address),
      kit.client.readContract({ address: morpho, abi: morphoAbi, functionName: "isAuthorized", args: [buyer.address, d.market] }),
    ]);
    check(sellerCollAfter - sellerColl === price, "seller collateral mismatch");
    check(buyerUsdgAfter === buyerUsdg, "buyer used cash");
    check(posAfter.health > pos.health, "health did not improve");
    check(!stillAuthorized, "authorization survived the transaction");
    const token = await sdk.token(collateral);
    return { paidCollateral: `${fmt(price, token.decimals)} ${token.symbol}`, healthBefore: fmt(pos.health, 18), healthAfter: fmt(posAfter.health, 18) };
  });

  await r.step("guard: a buyer without debt cannot buy", async () => {
    const noDebt = await expectRevert(sdk, keeper, sdk.buyAndRepay(sessionId, 1_000n * USD, 0, maxUint256, await sdk.venueData(buyer.address)));
    check(noDebt.startsWith("DebtTooSmall"), noDebt);
    return { noDebt };
  });

  let bidId = 0n;
  await r.step("bidder escrows a 5% USDG limit bid for up to 10,000 USDG of shares", async () => {
    const escrow = await sdk.quote(10_000n * USD, 500, usdg);
    await ensureAllowance(r, sdk, bidder, usdg, d.market, escrow);
    await send(r, sdk, bidder, sdk.placeBid(500, 0, 10_000n * USD, escrow));
    const b = (await sdk.bids()).find((x) => x.bidder === bidder.address);
    check(!!b, "bid missing");
    bidId = b.id;
    return { bidId: String(b.id), escrowUSDG: fmt(escrow) };
  });

  await r.step("seller sells 4,000 USDG of shares now into the best bid", async () => {
    const plan = await sdk.planSellNow(4_000n * USD, 1000, 0b01);
    const before = await sdk.balanceOf(usdg, seller.address);
    await ensureAllowance(r, sdk, seller, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller, sdk.sellNow(plan, 1000, 0b01, plan.filledAssets));
    const got = (await sdk.balanceOf(usdg, seller.address)) - before;
    check(got === plan.proceeds[usdg], "proceeds mismatch");
    return { proceedsUSDG: fmt(got) };
  });

  await r.step("auction climbs to 5% and a keeper matches it with the bid", async () => {
    await kit.anvil.increaseTime(9 * 3600);
    const s = await sdk.session(sessionId);
    check(s.discountBps >= 500, `discount ${s.discountBps}`);
    const before = await sdk.receiptValueOf(bidder.address);
    await send(r, sdk, keeper, sdk.matchBid(sessionId, bidId));
    const gained = (await sdk.receiptValueOf(bidder.address)) - before;
    check(gained > 5_000n * USD, `gained ${gained}`);
    return { discount: `${s.discountBps / 100}%`, filledUSDG: fmt(gained) };
  });

  await r.step("depositor puts 100,000 USDG in the Exeunt Vault; it bids 3% for up to 20%", async () => {
    await ensureAllowance(r, sdk, depositor, usdg, d.exeuntVault, 100_000n * USD);
    await send(r, sdk, depositor, sdk.vaultDeposit(100_000n * USD, depositor.address));
    const v = await sdk.vaultState(depositor.address);
    const bid = (await sdk.bids()).find((b) => b.id === v.bidId);
    check(!!bid, "vault bid missing");
    near(bid.escrow, 20_000n * USD, 1n, "vault escrow");
    return { escrowUSDG: fmt(bid.escrow) };
  });

  await r.step("seller sells 15,000 USDG of shares into the vault's bid", async () => {
    const plan = await sdk.planSellNow(15_000n * USD, 300, 0b01);
    const before = await sdk.balanceOf(usdg, seller.address);
    await send(r, sdk, seller, sdk.sellNow(plan, 300, 0b01, plan.filledAssets));
    const got = (await sdk.balanceOf(usdg, seller.address)) - before;
    near(got, 14_550n * USD, 2n, "USDG at 3%");
    const v = await sdk.vaultState();
    near(v.heldAssets, 15_000n * USD, 5n, "vault holdings");
    return { receivedUSDG: fmt(got), vaultHeldUSDG: fmt(v.heldAssets) };
  });

  await r.step("seller withdraws the unsold rest of the session immediately", async () => {
    const left = (await sdk.session(sessionId)).remainingAssets;
    const before = await sdk.receiptValueOf(seller.address);
    await send(r, sdk, seller, sdk.withdrawUnsold(sessionId));
    const got = (await sdk.receiptValueOf(seller.address)) - before;
    // Shares keep accruing interest between the read and the withdrawal block.
    check(got >= left - 5n && got - left <= left / 100_000n, `unsold returned ${got} vs ${left}`);
    return { returnedUSDG: fmt(left) };
  });

  await r.step("vault recovers; anyone triggers the vault's redemption; depositor exits with profit", async () => {
    await unfreeze(sdk, kit);
    const c = await sdk.capacity();
    check(c.withdrawable > 15_000n * USD, "vault did not recover");
    await send(r, sdk, keeper, sdk.vaultRecover(0n));
    const v = await sdk.vaultState(depositor.address);
    check(v.heldAssets <= 5n, `vault still holds ${v.heldAssets}`);
    await send(r, sdk, depositor, sdk.vaultRedeem(v.shares, depositor.address, depositor.address));
    const out = await sdk.balanceOf(usdg, depositor.address);
    check(out > 100_000n * USD, `depositor got ${out}`);
    return { depositorOutUSDG: fmt(out), profitUSDG: fmt(out - 100_000n * USD) };
  });

  await r.step("market holds only escrow; no USDG left behind by flash loans", async () => {
    const held = await sdk.balanceOf(usdg, d.market);
    const escrow = await kit.client.readContract({
      address: d.market,
      abi: [{ type: "function", name: "totalEscrow", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "totalEscrow",
      args: [usdg],
    });
    check(held === escrow, `market USDG ${held} vs escrow ${escrow}`);
    return { marketUSDG: fmt(held) };
  }, { independent: true });
}
