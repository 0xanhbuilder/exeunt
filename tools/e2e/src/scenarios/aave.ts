import { encodeFunctionData, formatUnits, maxUint256, type Address } from "viem";
import { aavePoolAbi, type ExeuntClient, type SessionParams } from "@exeunt/sdk";
import { FREEZER, borrowerKit, bidderKit, refreeze, sellerKit, type KitContext } from "@exeunt/forkkit";
import { ensureAllowance, expectRevert, send, type Actor } from "../lib/chain.js";
import { check, near, type Recorder } from "../lib/report.js";

const E18 = 10n ** 18n;
const fmt = (v: bigint, d = 18) => Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 6 });

export interface AaveScenarioOptions {
  /** WETH left withdrawable after freezing: > 0 exercises Aave's own flash loan, 0 needs the external source. */
  leave: bigint;
}

/**
 * Full Aave flow on a fork: frozen aWETH pool; seller exits through borrowers (wallet and flash mode), limit bids,
 * a matched auction and the Exeunt Vault; a borrower repays USDC debt with frozen collateral; the pool recovers.
 */
export async function aaveScenario(
  r: Recorder,
  sdk: ExeuntClient,
  kit: KitContext,
  actors: { seller: Actor; buyer: Actor; bidder: Actor; depositor: Actor; borrower: Actor; keeper: Actor },
  opts: AaveScenarioOptions,
): Promise<void> {
  const d = sdk.deployment;
  const { seller, buyer, bidder, depositor, borrower, keeper } = actors;
  const weth = d.underlying;
  const usdg = d.payTokens[0] as Address;
  const usdc = d.payTokens[1] as Address;
  const aUsdc = d.payATokens?.[1] as Address;
  const pool = d.aavePool as Address;
  let sessionId = 0n;

  await r.step("setup: seller holds 100 aWETH in the frozen pool", async () => {
    await sellerKit(kit, seller.address, 100n * E18, opts.leave);
    const bal = await sdk.receiptValueOf(seller.address);
    check(bal >= 100n * E18 - 10n, `seller aWETH ${bal}`);
    return { aWETH: fmt(bal) };
  });

  await r.step("setup: buyer owes 60 WETH against USDC collateral", async () => {
    await borrowerKit(kit, buyer.address, 60n * E18, opts.leave);
    const pos = await sdk.position(buyer.address);
    check(pos.debt >= 60n * E18 - 10n, `debt ${pos.debt}`); // debt-token rounding can be a wei short
    await bidderKit(kit, buyer.address, { [usdg]: 500_000n * 10n ** 6n });
    return { debt: fmt(pos.debt), healthFactor: fmt(pos.health) };
  });

  await r.step("setup: bidder and vault depositor funded; borrower posts aWETH and borrows USDC", async () => {
    await bidderKit(kit, bidder.address, { [usdg]: 500_000n * 10n ** 6n, [usdc]: 500_000n * 10n ** 6n });
    await bidderKit(kit, depositor.address, { [weth]: 50n * E18 });
    await sellerKit(kit, borrower.address, 40n * E18, opts.leave);
    await kit.anvil.sendAs(
      borrower.address,
      pool,
      encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [usdc, 30_000n * 10n ** 6n, 2n, 0, borrower.address] }),
    );
    await refreeze(kit, opts.leave);
  });

  await r.step("pool is frozen: utilization ~100%, nothing (or almost nothing) withdrawable", async () => {
    const c = await sdk.capacity();
    check(c.utilizationBps >= 9_990, `utilization ${c.utilizationBps}`);
    check(c.withdrawable <= opts.leave + E18 / 1000n, `withdrawable ${c.withdrawable}`);
    return { utilization: `${c.utilizationBps / 100}%`, withdrawable: fmt(c.withdrawable), debtorCapacity: fmt(c.debtorCapacity) };
  });

  await r.step("seller opens a Dutch auction for 50 aWETH (1% rising 0.5%/h, cap 15%)", async () => {
    const p: SessionParams = { startBps: 100, stepBps: 50, stepInterval: 3600, capBps: 1500, duration: 7 * 86400, payMask: 0b1111 & ((1 << d.payTokens.length) - 1) };
    await ensureAllowance(r, sdk, seller, d.receipt, d.market, 50n * E18);
    await send(r, sdk, seller, sdk.openSession(50n * E18, p));
    const sessions = await sdk.sessions(true);
    const s = sessions[0];
    check(!!s && s.seller === seller.address, "session not found");
    sessionId = s.id;
    near(s.remainingAssets, 50n * E18, 10n, "session size");
    return { sessionId: String(s.id), discount: `${s.discountBps / 100}%` };
  });

  await r.step("buyer buys 20 WETH of receipts with USDG; debt repaid in the same tx; liquidity unchanged", async () => {
    const assets = 20n * E18;
    const [before, debtBefore, sellerUsdg] = await Promise.all([
      sdk.capacity(),
      sdk.position(buyer.address),
      sdk.balanceOf(usdg, seller.address),
    ]);
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdg);
    await ensureAllowance(r, sdk, buyer, usdg, d.market, price);
    const { gasUsed } = await send(r, sdk, buyer, sdk.buyAndRepay(sessionId, assets, 0, price, "0x"));
    const [after, debtAfter, sellerUsdgAfter] = await Promise.all([
      sdk.capacity(),
      sdk.position(buyer.address),
      sdk.balanceOf(usdg, seller.address),
    ]);
    const repaid = debtBefore.debt - debtAfter.debt;
    check(repaid >= (assets * 999n) / 1000n, `debt repaid only ${repaid}`);
    check(sellerUsdgAfter - sellerUsdg === price, "seller not paid the quoted price");
    near(after.withdrawable, before.withdrawable, 2n, "withdrawable liquidity");
    return {
      paidUSDG: fmt(price, 6),
      debtRepaidWETH: fmt(repaid),
      discount: `${s.discountBps / 100}%`,
      withdrawableBefore: fmt(before.withdrawable),
      withdrawableAfter: fmt(after.withdrawable),
      gasUsed: gasUsed.toString(),
    };
  });

  await r.step("buyer buys 10 WETH in flash mode: seller paid in USDC from freed collateral, no cash used", async () => {
    const assets = 10n * E18;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdc);
    const [hfBefore, sellerUsdc, buyerUsdc, before] = await Promise.all([
      sdk.position(buyer.address),
      sdk.balanceOf(usdc, seller.address),
      sdk.balanceOf(usdc, buyer.address),
      sdk.capacity(),
    ]);
    await ensureAllowance(r, sdk, buyer, aUsdc, d.market, price);
    await send(r, sdk, buyer, sdk.buyAndRepayWithCollateral(sessionId, assets, 1, price, "0x"));
    const [hfAfter, sellerUsdcAfter, buyerUsdcAfter, after] = await Promise.all([
      sdk.position(buyer.address),
      sdk.balanceOf(usdc, seller.address),
      sdk.balanceOf(usdc, buyer.address),
      sdk.capacity(),
    ]);
    check(hfAfter.health > hfBefore.health, "health factor did not improve");
    check(sellerUsdcAfter - sellerUsdc === price, "seller USDC mismatch");
    check(buyerUsdcAfter === buyerUsdc, "buyer spent wallet cash");
    near(after.withdrawable, before.withdrawable, 2n, "withdrawable liquidity");
    return { paidUSDC: fmt(price, 6), healthBefore: fmt(hfBefore.health), healthAfter: fmt(hfAfter.health) };
  });

  await r.step("guards: no debt, no purchase; price above the buyer's limit reverts", async () => {
    const noDebt = await expectRevert(sdk, keeper, sdk.buyAndRepay(sessionId, E18, 0, maxUint256, "0x"));
    check(noDebt.startsWith("DebtTooSmall"), noDebt);
    const tooCheap = await expectRevert(sdk, buyer, sdk.buyAndRepay(sessionId, E18, 0, 1n, "0x"));
    check(tooCheap.startsWith("PriceTooHigh"), tooCheap);
    return { noDebt, tooCheap };
  });

  let usdgBid = 0n;
  await r.step("bidder escrows a 5% USDG limit bid for up to 10 WETH", async () => {
    const escrow = await sdk.quote(10n * E18, 500, usdg);
    await ensureAllowance(r, sdk, bidder, usdg, d.market, escrow);
    await send(r, sdk, bidder, sdk.placeBid(500, 0, 10n * E18, escrow));
    const bids = await sdk.bids();
    const b = bids.find((x) => x.bidder === bidder.address);
    check(!!b, "bid not listed");
    usdgBid = b.id;
    return { bidId: String(b.id), escrowUSDG: fmt(escrow, 6), capacityWETH: fmt(b.capacityAssets) };
  });

  await r.step("seller sells 4 aWETH now into the best bid and is paid immediately", async () => {
    const plan = await sdk.planSellNow(4n * E18, 1000, 0b0001);
    check(plan.filledAssets === 4n * E18, `plan filled ${plan.filledAssets}`);
    const usdgBefore = await sdk.balanceOf(usdg, seller.address);
    await ensureAllowance(r, sdk, seller, d.receipt, d.market, plan.filledAssets);
    await send(r, sdk, seller, sdk.sellNow(plan, 1000, 0b0001, plan.filledAssets));
    const got = (await sdk.balanceOf(usdg, seller.address)) - usdgBefore;
    check(got === plan.proceeds[usdg], "proceeds differ from plan");
    return { proceedsUSDG: fmt(got, 6), averageDiscount: `${plan.averageDiscountBps / 100}%` };
  });

  await r.step("auction discount climbs to the bid's 5% and a keeper matches them", async () => {
    await kit.anvil.increaseTime(9 * 3600);
    const s = await sdk.session(sessionId);
    check(s.discountBps >= 500, `discount ${s.discountBps}`);
    const bidderBefore = await sdk.receiptValueOf(bidder.address);
    await send(r, sdk, keeper, sdk.matchBid(sessionId, usdgBid));
    const gained = (await sdk.receiptValueOf(bidder.address)) - bidderBefore;
    check(gained > 5n * E18, `bidder gained ${gained}`);
    return { discount: `${s.discountBps / 100}%`, filledWETH: fmt(gained) };
  });

  await r.step("depositor puts 50 WETH in the Exeunt Vault; it bids 3% for up to 20% of capital", async () => {
    await ensureAllowance(r, sdk, depositor, weth, d.exeuntVault, 50n * E18);
    await send(r, sdk, depositor, sdk.vaultDeposit(50n * E18, depositor.address));
    const v = await sdk.vaultState(depositor.address);
    check(v.bidId > 0n, "vault has no bid");
    const bid = (await sdk.bids()).find((b) => b.id === v.bidId);
    check(!!bid && bid.minDiscountBps === 300, "vault bid wrong");
    near(bid.escrow, 10n * E18, 10n, "vault escrow");
    return { vaultTotal: fmt(v.totalAssets), bidEscrowWETH: fmt(bid.escrow) };
  });

  await r.step("seller sells 8 aWETH into the vault's bid and receives WETH at once", async () => {
    const plan = await sdk.planSellNow(8n * E18, 300, 0b0100);
    check(plan.filledAssets === 8n * E18, `plan filled ${plan.filledAssets}`);
    const wethBefore = await sdk.balanceOf(weth, seller.address);
    await send(r, sdk, seller, sdk.sellNow(plan, 300, 0b0100, plan.filledAssets));
    const got = (await sdk.balanceOf(weth, seller.address)) - wethBefore;
    near(got, (8n * E18 * 97n) / 100n, 1n, "WETH received at 3%");
    const v = await sdk.vaultState();
    near(v.heldAssets, 8n * E18, 10n, "vault holds the receipts");
    return { receivedWETH: fmt(got), vaultHeldAWETH: fmt(v.heldAssets) };
  });

  await r.step("borrower with frozen aWETH collateral repays 20,000 USDC by selling it into a USDC bid", async () => {
    const escrow = 100_000n * 10n ** 6n;
    await ensureAllowance(r, sdk, bidder, usdc, d.market, escrow);
    await send(r, sdk, bidder, sdk.placeBid(500, 1, maxUint256 >> 128n, escrow));
    const posBefore = await kit.client.readContract({
      address: pool,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [borrower.address],
    });
    const collateralSell = 10n * E18;
    const plan = await sdk.planSellNow(collateralSell, 500, 0b0010);
    await ensureAllowance(r, sdk, borrower, d.receipt, d.collateralRoute as Address, collateralSell);
    await send(r, sdk, borrower, sdk.routeRepayWithFrozenCollateral(collateralSell, plan, 500, 1, 20_000n * 10n ** 6n));
    const posAfter = await kit.client.readContract({
      address: pool,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [borrower.address],
    });
    check(posAfter[5] > posBefore[5], "health did not improve");
    check(posAfter[1] < posBefore[1], "debt did not fall");
    const c = await sdk.capacity();
    check(c.withdrawable <= opts.leave + E18 / 1000n, "route withdrew from the frozen pool");
    return { healthBefore: fmt(posBefore[5]), healthAfter: fmt(posAfter[5]) };
  });

  await r.step("seller withdraws the unsold rest of the session immediately", async () => {
    const before = await sdk.receiptValueOf(seller.address);
    const left = (await sdk.session(sessionId)).remainingAssets;
    await send(r, sdk, seller, sdk.withdrawUnsold(sessionId));
    const got = (await sdk.receiptValueOf(seller.address)) - before;
    // Receipts keep accruing interest between the read and the withdrawal block.
    check(got >= left - 10n && got - left <= left / 100_000n, `unsold returned ${got} vs ${left}`);
    const s = await sdk.session(sessionId);
    check(!s.open, "session still open");
    return { returnedAWETH: fmt(got) };
  });

  await r.step("pool recovers; anyone triggers the vault's recovery; depositor exits with the discount as profit", async () => {
    const debt = await sdk.balanceOf(d.debtToken as Address, FREEZER);
    await kit.anvil.dealErc20(weth, FREEZER, debt + E18);
    await kit.anvil.sendAs(FREEZER, weth, encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "approve",
      args: [pool, maxUint256],
    }));
    await kit.anvil.sendAs(FREEZER, pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "repay", args: [weth, maxUint256, 2n, FREEZER] }));
    const c = await sdk.capacity();
    check(c.withdrawable > 10n * E18, "pool did not recover");
    await send(r, sdk, keeper, sdk.vaultRecover(0n));
    const v = await sdk.vaultState(depositor.address);
    check(v.heldAssets <= 10n, `vault still holds ${v.heldAssets}`);
    await send(r, sdk, depositor, sdk.vaultRedeem(v.shares, depositor.address, depositor.address));
    const out = await sdk.balanceOf(weth, depositor.address);
    check(out > 50n * E18, `depositor got ${out}`);
    return { withdrawableNow: fmt(c.withdrawable), depositorOutWETH: fmt(out), profitWETH: fmt(out - 50n * E18) };
  });

  await r.step("market holds only escrow: no stray WETH, receipts back every open session", async () => {
    const wethHeld = await sdk.balanceOf(weth, d.market);
    const escrow = await kit.client.readContract({
      address: d.market,
      abi: [{ type: "function", name: "totalEscrow", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "totalEscrow",
      args: [weth],
    });
    check(wethHeld === escrow, `market WETH ${wethHeld} vs escrow ${escrow}`);
    return { marketWETH: fmt(wethHeld) };
  }, { independent: true });

}
