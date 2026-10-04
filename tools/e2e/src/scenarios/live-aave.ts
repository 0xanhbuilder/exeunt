import { encodeFunctionData, formatUnits, parseEther, type Address } from "viem";
import { aavePoolAbi, erc20Abi, type ExeuntClient, type SessionParams, type UnsignedTx } from "@exeunt/sdk";
import { ensureAllowance, send, type Actor } from "../lib/chain.js";
import { check, type Recorder } from "../lib/report.js";

const fmt = (v: bigint, d = 18) => Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 8 });
const wethAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;

function raw(to: Address, data: `0x${string}`, description: string, value = 0n): UnsignedTx {
  return { to, data, value, description };
}

/**
 * Live Arbitrum Sepolia run with real funds and tiny amounts. The testnet WETH pool is already ~99.8% utilized,
 * so every exit goes through Exeunt rather than a withdrawal. No cheat codes: two funded accounts sign everything.
 */
export async function liveAaveScenario(
  r: Recorder,
  sdk: ExeuntClient,
  actors: { seller: Actor; buyer: Actor },
): Promise<void> {
  const d = sdk.deployment;
  const { seller, buyer } = actors;
  const weth = d.underlying;
  const usdg = d.payTokens[0] as Address;
  const usdc = d.payTokens[1] as Address;
  const aUsdc = d.payATokens?.[1] as Address;
  const pool = d.aavePool as Address;
  const sessionParams = (startBps: number): SessionParams => ({
    startBps,
    stepBps: 50,
    stepInterval: 3600,
    capBps: 1500,
    duration: 3 * 86400,
    payMask: 0b111,
  });

  await r.step("live pool state read from chain", async () => {
    const c = await sdk.capacity();
    return { utilization: `${(c.utilizationBps / 100).toFixed(2)}%`, withdrawableWETH: fmt(c.withdrawable), suppliedWETH: fmt(c.supplied) };
  }, { independent: true });

  await r.step("fund the buyer account with gas, wrapping money and USDG", async () => {
    const eth = await sdk.client.getBalance({ address: buyer.address });
    if (eth < parseEther("0.01")) {
      const hash = await seller.wallet.sendTransaction({ account: seller.account, chain: seller.wallet.chain, to: buyer.address, value: parseEther("0.015") });
      r.noteTx(hash);
      await sdk.client.waitForTransactionReceipt({ hash });
    }
    if ((await sdk.balanceOf(usdg, buyer.address)) < 20_000_000n) {
      await send(r, sdk, seller, raw(usdg, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [buyer.address, 25_000_000n] }), "Send 25 USDG to the buyer"));
    }
    return { buyerETH: fmt(await sdk.client.getBalance({ address: buyer.address })), buyerUSDG: fmt(await sdk.balanceOf(usdg, buyer.address), 6) };
  });

  await r.step("seller takes back unsold receipts from earlier runs", async () => {
    const mine = (await sdk.sessions(true)).filter((x) => x.seller === seller.address);
    for (const s of mine) await send(r, sdk, seller, sdk.withdrawUnsold(s.id));
    return { reclaimedSessions: String(mine.length) };
  });

  await r.step("seller tops up to 0.004 aWETH (wrapping only what is missing)", async () => {
    const target = parseEther("0.004");
    const have = await sdk.receiptValueOf(seller.address);
    if (have < target) {
      const need = target - have + 1_000n;
      const wethBal = await sdk.balanceOf(weth, seller.address);
      if (wethBal < need) {
        await send(r, sdk, seller, raw(weth, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), "Wrap ETH", need - wethBal));
      }
      await ensureAllowance(r, sdk, seller, weth, pool, need);
      await send(r, sdk, seller, raw(pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [weth, need, seller.address, 0] }), "Supply WETH to Aave"));
    }
    return { sellerAWETH: fmt(await sdk.receiptValueOf(seller.address)) };
  });

  await r.step("buyer posts WETH collateral and borrows 0.004 WETH and 5 USDC (skips what earlier runs did)", async () => {
    if ((await sdk.receiptValueOf(buyer.address)) < parseEther("0.0099")) {
      await send(r, sdk, buyer, raw(weth, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), "Wrap 0.01 ETH", parseEther("0.01")));
      await ensureAllowance(r, sdk, buyer, weth, pool, parseEther("0.01"));
      await send(r, sdk, buyer, raw(pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [weth, parseEther("0.01"), buyer.address, 0] }), "Supply 0.01 WETH collateral"));
    }
    if ((await sdk.position(buyer.address)).debt < parseEther("0.0039")) {
      await send(r, sdk, buyer, raw(pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [weth, parseEther("0.004"), 2n, 0, buyer.address] }), "Borrow 0.004 WETH"));
    }
    if ((await sdk.balanceOf(aUsdc, buyer.address)) < 3_900_000n) {
      await send(r, sdk, buyer, raw(pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [usdc, 5_000_000n, 2n, 0, buyer.address] }), "Borrow 5 USDC"));
      await ensureAllowance(r, sdk, buyer, usdc, pool, 4_000_000n);
      await send(r, sdk, buyer, raw(pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [usdc, 4_000_000n, buyer.address, 0] }), "Supply 4 USDC as collateral"));
    }
    const pos = await sdk.position(buyer.address);
    return { debtWETH: fmt(pos.debt), healthFactor: fmt(pos.health), aUSDC: fmt(await sdk.balanceOf(aUsdc, buyer.address), 6) };
  });

  let sessionId = 0n;
  await r.step("seller opens a Dutch auction for 0.003 aWETH", async () => {
    await ensureAllowance(r, sdk, seller, d.receipt, d.market, parseEther("0.01"));
    await send(r, sdk, seller, sdk.openSession(parseEther("0.003"), sessionParams(100)));
    const s = (await sdk.sessions(true)).find((x) => x.seller === seller.address);
    check(!!s, "session missing");
    sessionId = s.id;
    return { sessionId: String(s.id), sizeWETH: fmt(s.remainingAssets) };
  });

  await r.step("buyer buys 0.001 WETH of receipts paying USDG; debt repaid in the same tx", async () => {
    const assets = parseEther("0.001");
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdg);
    const [before, liq] = await Promise.all([sdk.position(buyer.address), sdk.capacity()]);
    await ensureAllowance(r, sdk, buyer, usdg, d.market, price);
    const { hash } = await send(r, sdk, buyer, sdk.buyAndRepay(sessionId, assets, 0, price, "0x"));
    const [after, liqAfter] = await Promise.all([sdk.position(buyer.address), sdk.capacity()]);
    check(before.debt - after.debt >= (assets * 99n) / 100n, "debt not repaid");
    return { tx: hash, paidUSDG: fmt(price, 6), debtRepaidWETH: fmt(before.debt - after.debt), withdrawableBefore: fmt(liq.withdrawable), withdrawableAfter: fmt(liqAfter.withdrawable) };
  });

  await r.step("buyer buys 0.0005 WETH in flash mode, paying the seller USDC from freed collateral", async () => {
    const assets = parseEther("0.0005");
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdc);
    const [hf, sellerUsdc] = await Promise.all([sdk.position(buyer.address), sdk.balanceOf(usdc, seller.address)]);
    await ensureAllowance(r, sdk, buyer, aUsdc, d.market, price);
    const { hash } = await send(r, sdk, buyer, sdk.buyAndRepayWithCollateral(sessionId, assets, 1, price, "0x"));
    const [hfAfter, sellerUsdcAfter] = await Promise.all([sdk.position(buyer.address), sdk.balanceOf(usdc, seller.address)]);
    check(hfAfter.health >= hf.health, "health fell");
    check(sellerUsdcAfter - sellerUsdc === price, "seller not paid in USDC");
    return { tx: hash, paidUSDC: fmt(price, 6), healthBefore: fmt(hf.health), healthAfter: fmt(hfAfter.health) };
  });

  let bidId = 0n;
  await r.step("buyer places a 5% USDG limit bid for up to 0.001 WETH", async () => {
    const escrow = await sdk.quote(parseEther("0.001"), 500, usdg);
    await ensureAllowance(r, sdk, buyer, usdg, d.market, escrow);
    await send(r, sdk, buyer, sdk.placeBid(500, 0, parseEther("0.001"), escrow));
    const b = (await sdk.bids()).filter((x) => x.bidder === buyer.address).pop();
    check(!!b, "bid missing");
    bidId = b.id;
    return { bidId: String(b.id), escrowUSDG: fmt(escrow, 6) };
  });

  await r.step("seller sells 0.0005 aWETH now into that bid", async () => {
    const plan = await sdk.planSellNow(parseEther("0.0005"), 500, 0b001);
    const before = await sdk.balanceOf(usdg, seller.address);
    const { hash } = await send(r, sdk, seller, sdk.sellNow(plan, 500, 0b001, plan.filledAssets));
    return { tx: hash, proceedsUSDG: fmt((await sdk.balanceOf(usdg, seller.address)) - before, 6) };
  });

  await r.step("a session already at 6% is matched with the 5% bid by anyone", async () => {
    await send(r, sdk, seller, sdk.openSession(parseEther("0.0004"), sessionParams(600)));
    const s = (await sdk.sessions(true)).find((x) => x.seller === seller.address && x.startBps === 600);
    check(!!s, "second session missing");
    const { hash } = await send(r, sdk, seller, sdk.matchBid(s.id, bidId));
    return { tx: hash, sessionId: String(s.id) };
  });

  await r.step("seller deposits 0.001 WETH into the Exeunt Vault, then sells into the vault's 3% bid", async () => {
    const wethBal = await sdk.balanceOf(weth, seller.address);
    if (wethBal < parseEther("0.001")) {
      await send(r, sdk, seller, raw(weth, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), "Wrap ETH", parseEther("0.001") - wethBal));
    }
    await ensureAllowance(r, sdk, seller, weth, d.exeuntVault, parseEther("0.001"));
    await send(r, sdk, seller, sdk.vaultDeposit(parseEther("0.001"), seller.address));
    const v = await sdk.vaultState(seller.address);
    const plan = await sdk.planSellNow(parseEther("0.0002"), 300, 0b100);
    check(plan.filledAssets > 0n, "vault bid not available");
    const { hash } = await send(r, sdk, seller, sdk.sellNow(plan, 300, 0b100, 1n));
    const v2 = await sdk.vaultState(seller.address);
    return { tx: hash, vaultTotalWETH: fmt(v2.totalAssets), vaultHeldAWETH: fmt(v2.heldAssets), bidBefore: String(v.bidId) };
  });

  await r.step("seller withdraws the unsold rest of the first session", async () => {
    const { hash } = await send(r, sdk, seller, sdk.withdrawUnsold(sessionId));
    const s = await sdk.session(sessionId);
    check(!s.open, "still open");
    return { tx: hash };
  });

  await r.step("buyer cancels leftover bids and gets escrow back immediately", async () => {
    const mine = (await sdk.bids()).filter((b) => b.bidder === buyer.address);
    for (const b of mine) await send(r, sdk, buyer, sdk.cancelBid(b.id));
    return { cancelled: String(mine.length) };
  });
}
