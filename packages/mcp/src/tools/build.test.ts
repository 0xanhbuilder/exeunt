import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeErrorResult, erc20Abi as viemErc20Abi, maxUint256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { aaveCollateralRouteAbi, aaveExitMarketAbi, exeuntVaultAbi } from "@exeunt/sdk";
import { z } from "zod";
import { ADDR, AAVE_DEPLOYMENT, fakeChain, fakeNetwork, MORPHO_DEPLOYMENT, session, type FakeNetwork } from "../testing/fakes.js";
import {
  buildBuyAndRepay,
  buildBuyAndRepayShape,
  buildBuyWithCollateral,
  buildBuyWithCollateralShape,
  buildCancelBid,
  buildOpenSession,
  buildOpenSessionShape,
  buildPlaceBid,
  buildPlaceBidShape,
  buildRouteRepayShape,
  buildRouteRepayWithFrozenCollateral,
  buildSellNow,
  buildSellNowShape,
  buildVaultDeposit,
  buildVaultRedeem,
  buildWithdrawUnsold,
} from "./build.js";
import type { BuildResult, ToolContext } from "./common.js";

const E18 = 10n ** 18n;
const MORPHO_MARKET = {
  loanToken: ADDR.morphoUSDG,
  collateralToken: ADDR.USDe,
  oracle: ADDR.oracle,
  irm: ADDR.irm,
  lltv: 915n * 10n ** 15n,
};

let aave: FakeNetwork;
let morpho: FakeNetwork;
let ctx: ToolContext;

beforeEach(() => {
  aave = fakeNetwork(AAVE_DEPLOYMENT);
  morpho = fakeNetwork(MORPHO_DEPLOYMENT);
  ctx = { chain: fakeChain({ "kelp-replay": aave.handle, "earn-bank-run": morpho.handle }), nowSeconds: () => 1_700_000_100n };
});

function decodeMarket(data: Hex) {
  return decodeFunctionData({ abi: aaveExitMarketAbi, data });
}

function decodeApprove(data: Hex) {
  return decodeFunctionData({ abi: viemErc20Abi, data });
}

function expectUnsigned(out: BuildResult) {
  for (const tx of out.transactions) {
    expect(Object.keys(tx).sort()).toEqual(["data", "description", "to", "value"]);
    expect(tx.value).toBe("0");
  }
}

describe("build_buy_and_repay", () => {
  const parse = (raw: unknown) => z.object(buildBuyAndRepayShape).parse(raw);

  beforeEach(() => {
    vi.spyOn(aave.sdk, "session").mockResolvedValue(session({ discountBps: 200 }));
    vi.spyOn(aave.sdk, "position").mockResolvedValue({ debt: 5n * E18, health: 2n * E18 });
    vi.spyOn(aave.sdk, "quote").mockResolvedValue(4_900_000_000n);
  });

  it("adds an exact approval when the allowance is short and converts human amounts", async () => {
    const out = await buildBuyAndRepay(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "2.5", payToken: "USDC", from: ADDR.user }));
    expectUnsigned(out);
    expect(out.chainId).toBe(42161);
    expect(out.transactions).toHaveLength(2);
    const [approveTx, buyTx] = out.transactions;
    // 0.5% buffer over the quote because USDC is oracle-priced against WETH.
    const maxPay = 4_900_000_000n + 24_500_000n;
    expect(approveTx?.to).toBe(ADDR.USDC);
    expect(decodeApprove(approveTx!.data).args).toEqual([ADDR.market, maxPay]);
    expect(buyTx?.to).toBe(ADDR.market);
    const call = decodeMarket(buyTx!.data);
    expect(call.functionName).toBe("buyAndRepay");
    expect(call.args).toEqual([1n, 2_500_000_000_000_000_000n, 1, maxPay, "0x"]);
    expect(out.details?.maxPay).toEqual({ raw: maxPay.toString(), human: "4924.5", symbol: "USDC" });
  });

  it("skips the approval when the allowance already covers maxPay", async () => {
    vi.spyOn(aave.sdk, "allowance").mockResolvedValue(maxUint256);
    const out = await buildBuyAndRepay(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "WETH", from: ADDR.user, maxPay: "5000" }));
    expect(out.transactions).toHaveLength(1);
    expect(decodeMarket(out.transactions[0]!.data).args[3]).toBe(5_000n * E18);
  });

  it("refuses buyers without enough same-asset debt", async () => {
    await expect(
      buildBuyAndRepay(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "6", payToken: "USDC", from: ADDR.user })),
    ).rejects.toThrow(/owes 5 WETH/);
  });

  it("refuses a maxPay below the current price and amounts with too many decimals", async () => {
    await expect(
      buildBuyAndRepay(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "USDC", from: ADDR.user, maxPay: "100" })),
    ).rejects.toThrow(/below the current price/);
    await expect(
      buildBuyAndRepay(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "USDC", from: ADDR.user, maxPay: "5000.0000001" })),
    ).rejects.toThrow(/only has 6/);
  });

  it("requires `from`", () => {
    expect(() => parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "USDC" })).toThrow();
  });
});

describe("build_buy_with_collateral", () => {
  const parse = (raw: unknown) => z.object(buildBuyWithCollateralShape).parse(raw);

  it("Aave: approves the collateral aToken and builds the flash-mode purchase", async () => {
    vi.spyOn(aave.sdk, "session").mockResolvedValue(session());
    vi.spyOn(aave.sdk, "position").mockResolvedValue({ debt: 5n * E18, health: 2n * E18 });
    vi.spyOn(aave.sdk, "quote").mockResolvedValue(1_000_000_000n);
    const out = (await buildBuyWithCollateral(
      ctx,
      parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "USDC", from: ADDR.user, maxPay: "1000" }),
    )) as BuildResult;
    expect(out.transactions).toHaveLength(2);
    expect(out.transactions[0]?.to).toBe(ADDR.aUSDC);
    expect(decodeApprove(out.transactions[0]!.data).args).toEqual([ADDR.market, 1_000_000_000n]);
    const call = decodeMarket(out.transactions[1]!.data);
    expect(call.functionName).toBe("buyAndRepayWithCollateral");
    expect(call.args).toEqual([1n, E18, 1, 1_000_000_000n, "0x"]);
  });

  it("rejects paying with the underlying or a token without an aToken", async () => {
    vi.spyOn(aave.sdk, "session").mockResolvedValue(session());
    vi.spyOn(aave.sdk, "position").mockResolvedValue({ debt: 5n * E18, health: 2n * E18 });
    vi.spyOn(aave.sdk, "quote").mockResolvedValue(E18);
    await expect(
      buildBuyWithCollateral(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "WETH", from: ADDR.user })),
    ).rejects.toThrow(/cannot be the underlying/);
    await expect(
      buildBuyWithCollateral(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "USDG", from: ADDR.user })),
    ).rejects.toThrow(/no Aave collateral aToken/);
  });

  describe("Morpho", () => {
    beforeEach(() => {
      vi.spyOn(morpho.sdk, "session").mockResolvedValue(
        session({ remainingAssets: 10_000_000_000n, acceptedPayTokens: [ADDR.morphoUSDG, ADDR.USDe] }),
      );
      vi.spyOn(morpho.sdk, "position").mockResolvedValue({
        debt: 5_000_000_000n,
        health: 2n * E18,
        market: MORPHO_MARKET,
        marketId: "0x01",
        collateral: 20_000n * E18,
      });
      vi.spyOn(morpho.sdk, "quote").mockResolvedValue(980n * E18);
      morpho.reads.morphoNonce.mockResolvedValue(7n);
    });

    it("returns two typed-data messages to sign instead of a transaction", async () => {
      const out = await buildBuyWithCollateral(
        ctx,
        parse({ network: "earn-bank-run", sessionId: 1, assets: "1000", payToken: "USDe", from: ADDR.user }),
      );
      expect(out.transactions).toEqual([]);
      const requests = (out as { signatureRequests: { name: string; typedData: { message: Record<string, unknown>; domain: Record<string, unknown> } }[] })
        .signatureRequests;
      expect(requests.map((r) => r.name)).toEqual(["grant", "revoke"]);
      expect(requests[0]?.typedData.domain).toEqual({ chainId: 4663, verifyingContract: ADDR.morpho });
      expect(requests[0]?.typedData.message).toMatchObject({ authorizer: ADDR.user, authorized: ADDR.morphoMarket, isAuthorized: true, nonce: "7" });
      expect(requests[1]?.typedData.message).toMatchObject({ isAuthorized: false, nonce: "8" });
      // max(chain time, wall clock) + 1 hour
      expect(requests[0]?.typedData.message.deadline).toBe((1_700_000_100n + 3_600n).toString());
      expect(out.notes.join(" ")).toMatch(/two EIP-712 signatures/);
    });

    it("builds the purchase from the buyer's signatures, encoding grant and revoke", async () => {
      const first = (await buildBuyWithCollateral(
        ctx,
        parse({ network: "earn-bank-run", sessionId: 1, assets: "1000", payToken: "USDe", from: ADDR.user }),
      )) as { signatureRequests: { typedData: { message: { deadline: string } } }[] };
      const deadline = first.signatureRequests[0]!.typedData.message.deadline;
      // The test plays the buyer's wallet; the MCP server itself never signs.
      const wallet = privateKeyToAccount(generatePrivateKey());
      const types = {
        Authorization: [
          { name: "authorizer", type: "address" },
          { name: "authorized", type: "address" },
          { name: "isAuthorized", type: "bool" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      } as const;
      const sign = (isAuthorized: boolean, nonce: bigint) =>
        wallet.signTypedData({
          domain: { chainId: 4663, verifyingContract: ADDR.morpho },
          types,
          primaryType: "Authorization",
          message: { authorizer: ADDR.user, authorized: ADDR.morphoMarket, isAuthorized, nonce, deadline: BigInt(deadline) },
        });
      const grantSignature = await sign(true, 7n);
      const revokeSignature = await sign(false, 8n);

      const out = (await buildBuyWithCollateral(
        ctx,
        parse({
          network: "earn-bank-run",
          sessionId: 1,
          assets: "1000",
          payToken: "USDe",
          from: ADDR.user,
          authorization: { nonce: "7", deadline, grantSignature, revokeSignature },
        }),
      )) as BuildResult;
      expect(out.transactions).toHaveLength(1);
      const call = decodeMarket(out.transactions[0]!.data);
      expect(call.functionName).toBe("buyAndRepayWithCollateral");
      const [, assets, payIdx, , venueData] = call.args as readonly [bigint, bigint, number, bigint, Hex];
      expect(assets).toBe(1_000_000_000n);
      expect(payIdx).toBe(1);
      const [market, force, auth] = decodeAbiParameters(
        [
          { type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] },
          { type: "bool" },
          { type: "bytes" },
        ],
        venueData,
      );
      expect(market.collateralToken).toBe(ADDR.USDe);
      expect(force).toBe(false);
      const authTuple = { type: "tuple", components: types.Authorization } as const;
      const sigTuple = { type: "tuple", components: [{ name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] } as const;
      const [grant, grantSig, revoke] = decodeAbiParameters([authTuple, sigTuple, authTuple, sigTuple], auth);
      expect(grant).toMatchObject({ authorizer: ADDR.user, isAuthorized: true, nonce: 7n, deadline: BigInt(deadline) });
      expect(revoke).toMatchObject({ isAuthorized: false, nonce: 8n });
      expect(grantSig.r).toBe(grantSignature.slice(0, 66));
    });

    it("refuses stale signatures and the wrong collateral", async () => {
      morpho.reads.morphoNonce.mockResolvedValue(9n);
      await expect(
        buildBuyWithCollateral(
          ctx,
          parse({
            network: "earn-bank-run",
            sessionId: 1,
            assets: "1000",
            payToken: "USDe",
            from: ADDR.user,
            authorization: { nonce: "7", deadline: "1800000000", grantSignature: `0x${"11".repeat(65)}`, revokeSignature: `0x${"11".repeat(65)}` },
          }),
        ),
      ).rejects.toThrow(/nonce 7.*now 9/);
      vi.spyOn(morpho.sdk, "position").mockResolvedValue({
        debt: 5_000_000_000n,
        health: 2n * E18,
        market: { ...MORPHO_MARKET, collateralToken: ADDR.wstETH },
        marketId: "0x02",
        collateral: E18,
      });
      await expect(
        buildBuyWithCollateral(ctx, parse({ network: "earn-bank-run", sessionId: 1, assets: "1000", payToken: "USDe", from: ADDR.user })),
      ).rejects.toThrow(/collateral is wstETH/);
    });
  });
});

describe("build_open_session", () => {
  const parse = (raw: unknown) => z.object(buildOpenSessionShape).parse(raw);
  const base = { startBps: 100, stepBps: 50, stepIntervalSeconds: 600, capBps: 1_000, durationSeconds: 86_400 };

  it("converts Morpho assets to vault shares and builds the pay mask", async () => {
    const toShares = vi.spyOn(morpho.sdk, "receiptAmountFor").mockResolvedValue(999n * E18);
    const out = await buildOpenSession(ctx, parse({ network: "earn-bank-run", assets: "1000", payTokens: ["USDe"], ...base }));
    expect(toShares).toHaveBeenCalledWith(1_000_000_000n);
    expect(out.transactions).toHaveLength(2);
    expect(out.transactions[0]?.to).toBe(ADDR.steakUSDG);
    expect(decodeApprove(out.transactions[0]!.data).args).toEqual([ADDR.morphoMarket, 999n * E18]);
    const call = decodeMarket(out.transactions[1]!.data);
    expect(call.functionName).toBe("openSession");
    expect(call.args).toEqual([999n * E18, { startBps: 100, stepBps: 50, stepInterval: 600, capBps: 1_000, duration: 86_400, payMask: 0b10 }]);
    expect(out.notes.join(" ")).toMatch(/no "from" address/);
  });

  it("rejects a start discount above the cap and out-of-range values", async () => {
    await expect(buildOpenSession(ctx, parse({ network: "kelp-replay", assets: "1", ...base, startBps: 2_000 }))).rejects.toThrow(/startBps/);
    expect(() => parse({ network: "kelp-replay", assets: "1", ...base, capBps: 6_000 })).toThrow();
    expect(() => parse({ network: "kelp-replay", assets: "1", ...base, durationSeconds: 31 * 24 * 3600 })).toThrow();
  });
});

describe("build_withdraw_unsold and build_cancel_bid", () => {
  it("builds a full withdrawal for the seller and refuses other wallets", async () => {
    vi.spyOn(aave.sdk, "session").mockResolvedValue(session());
    const out = await buildWithdrawUnsold(ctx, { network: "kelp-replay", sessionId: 1, from: ADDR.seller });
    expect(decodeMarket(out.transactions[0]!.data).args).toEqual([1n, maxUint256]);
    await expect(buildWithdrawUnsold(ctx, { network: "kelp-replay", sessionId: 1, from: ADDR.user })).rejects.toThrow(/Only the seller/);
  });

  it("cancels an active bid and reports the refund", async () => {
    vi.spyOn(aave.sdk, "bids").mockResolvedValue([
      { id: 4n, bidder: ADDR.bidder, minDiscountBps: 500, payIdx: 1, payToken: ADDR.USDC, maxAssets: E18, escrow: 2_000_000_000n, capacityAssets: E18 },
    ]);
    const out = await buildCancelBid(ctx, { network: "kelp-replay", bidId: "4", from: ADDR.bidder });
    expect(decodeMarket(out.transactions[0]!.data)).toMatchObject({ functionName: "cancelBid", args: [4n] });
    expect(out.details?.refund).toEqual({ raw: "2000000000", human: "2000", symbol: "USDC" });
    await expect(buildCancelBid(ctx, { network: "kelp-replay", bidId: 5 })).rejects.toThrow(/not active/);
  });
});

describe("build_place_bid", () => {
  it("escrows the pay token and encodes the bid", async () => {
    vi.spyOn(aave.sdk, "quote").mockResolvedValue(9_500_000_000n);
    const args = z.object(buildPlaceBidShape).parse({ network: "kelp-replay", minDiscountBps: 300, payToken: "USDG", maxAssets: "5", escrow: "9000", from: ADDR.bidder });
    const out = await buildPlaceBid(ctx, args);
    expect(decodeApprove(out.transactions[0]!.data).args).toEqual([ADDR.market, 9_000_000_000n]);
    expect(decodeMarket(out.transactions[1]!.data).args).toEqual([300, 0, 5n * E18, 9_000_000_000n]);
    expect(out.notes.join(" ")).toMatch(/covers only part/);
  });
});

describe("build_sell_now", () => {
  const parse = (raw: unknown) => z.object(buildSellNowShape).parse(raw);
  const plan = {
    bidIds: [3n, 4n],
    fills: [
      { bidId: 3n, assets: E18, pay: 970_000_000_000_000_000n, payToken: ADDR.WETH, discountBps: 300 },
      { bidId: 4n, assets: E18, pay: 1_900_000_000n, payToken: ADDR.USDC, discountBps: 500 },
    ],
    filledAssets: 2n * E18,
    proceeds: { [ADDR.WETH]: 970_000_000_000_000_000n, [ADDR.USDC]: 1_900_000_000n },
    averageDiscountBps: 400,
  };

  it("sells into bids with an all-or-revert minimum by default", async () => {
    vi.spyOn(aave.sdk, "planSellNow").mockResolvedValue(plan);
    const out = await buildSellNow(ctx, parse({ network: "kelp-replay", assets: "3", maxDiscountBps: 500, from: ADDR.user }));
    expect(decodeApprove(out.transactions[0]!.data).args).toEqual([ADDR.market, 2n * E18]);
    expect(decodeMarket(out.transactions[1]!.data).args).toEqual([2n * E18, [3n, 4n], 500, 0b1111, 2n * E18]);
    expect(out.notes.join(" ")).toMatch(/Only 2 of 3 WETH/);
  });

  it("fails when no bid qualifies", async () => {
    vi.spyOn(aave.sdk, "planSellNow").mockResolvedValue({ bidIds: [], fills: [], filledAssets: 0n, proceeds: {}, averageDiscountBps: 0 });
    await expect(buildSellNow(ctx, parse({ network: "kelp-replay", assets: "1", maxDiscountBps: 100 }))).rejects.toThrow(/No escrowed bid/);
  });
});

describe("Exeunt Vault", () => {
  it("deposits the vault asset for the receiver", async () => {
    const out = await buildVaultDeposit(ctx, { network: "kelp-replay", assets: "1.25", from: ADDR.user });
    expect(out.transactions[0]?.to).toBe(ADDR.WETH);
    expect(out.transactions[1]?.to).toBe(ADDR.aaveVault);
    expect(decodeFunctionData({ abi: exeuntVaultAbi, data: out.transactions[1]!.data }).args).toEqual([1_250_000_000_000_000_000n, ADDR.user]);
    await expect(buildVaultDeposit(ctx, { network: "kelp-replay", assets: "1" })).rejects.toThrow(/receiver/);
  });

  it("redeems all shares by default with a preview", async () => {
    vi.spyOn(aave.sdk, "balanceOf").mockResolvedValue(5_000n * E18);
    aave.reads.vaultPreviewRedeem.mockResolvedValue({ assets: 3n * E18, receipts: [2n * E18] });
    const out = await buildVaultRedeem(ctx, { network: "kelp-replay", from: ADDR.user });
    expect(decodeFunctionData({ abi: exeuntVaultAbi, data: out.transactions[0]!.data }).args).toEqual([5_000n * E18, ADDR.user, ADDR.user]);
    expect(out.details?.receiveNow).toEqual({ raw: (3n * E18).toString(), human: "3", symbol: "WETH" });
    expect(out.details?.receiveInKind).toEqual({ raw: (2n * E18).toString(), human: "2", symbol: "aArbWETH" });
  });
});

describe("build_route_repay_with_frozen_collateral", () => {
  const parse = (raw: unknown) => z.object(buildRouteRepayShape).parse(raw);
  const input = { from: ADDR.user, collateralAmount: "2", repayToken: "USDC", repayAmount: "3000", maxDiscountBps: 500 };

  beforeEach(() => {
    vi.spyOn(aave.sdk, "capacity").mockResolvedValue({ withdrawable: 0n, supplied: 100n * E18, utilizationBps: 10_000, debtorCapacity: 0n, sessionAssets: 0n });
    vi.spyOn(aave.sdk, "planSellNow").mockResolvedValue({
      bidIds: [4n],
      fills: [{ bidId: 4n, assets: 2n * E18, pay: 3_800_000_000n, payToken: ADDR.USDC, discountBps: 500 }],
      filledAssets: 2n * E18,
      proceeds: { [ADDR.USDC]: 3_800_000_000n },
      averageDiscountBps: 500,
    });
  });

  it("is gated to Aave networks", async () => {
    await expect(buildRouteRepayWithFrozenCollateral(ctx, parse({ network: "earn-bank-run", ...input }))).rejects.toThrow(/only available on Aave/);
  });

  it("is refused when the collateral can be withdrawn directly", async () => {
    vi.spyOn(aave.sdk, "capacity").mockResolvedValue({ withdrawable: 5n * E18, supplied: 100n * E18, utilizationBps: 9_500, debtorCapacity: 0n, sessionAssets: 0n });
    await expect(buildRouteRepayWithFrozenCollateral(ctx, parse({ network: "kelp-replay", ...input }))).rejects.toThrow(/withdrawn directly/);
  });

  it("simulates the route when no approval is needed and refuses a failing simulation", async () => {
    vi.spyOn(aave.sdk, "allowance").mockResolvedValue(maxUint256);
    const ok = await buildRouteRepayWithFrozenCollateral(ctx, parse({ network: "kelp-replay", ...input }));
    expect(ok.transactions).toHaveLength(1);
    expect(ok.transactions[0]?.to).toBe(ADDR.route);
    expect(decodeFunctionData({ abi: aaveCollateralRouteAbi, data: ok.transactions[0]!.data }).args).toEqual([
      ADDR.market,
      2n * E18,
      [4n],
      500,
      1,
      3_000_000_000n,
    ]);
    expect(ok.details?.simulation).toBe("passed");
    expect(aave.reads.call).toHaveBeenCalledWith(expect.objectContaining({ from: ADDR.user, to: ADDR.route }));

    aave.reads.call.mockResolvedValue({
      ok: false,
      message: "execution reverted",
      revertData: encodeErrorResult({ abi: aaveCollateralRouteAbi, errorName: "ProceedsTooLow", args: [1n, 2n] }),
    });
    await expect(buildRouteRepayWithFrozenCollateral(ctx, parse({ network: "kelp-replay", ...input }))).rejects.toThrow(
      /ProceedsTooLow\(uint256 proceeds, uint256 needed\).*do not send/,
    );
  });

  it("asks for a simulation after the approval when one is needed", async () => {
    const out = await buildRouteRepayWithFrozenCollateral(ctx, parse({ network: "kelp-replay", ...input }));
    expect(out.transactions.map((t) => t.to)).toEqual([ADDR.aWETH, ADDR.route]);
    expect(decodeApprove(out.transactions[0]!.data).args).toEqual([ADDR.route, 2n * E18]);
    expect(out.details?.simulation).toBe("pending-approval");
    expect(aave.reads.call).not.toHaveBeenCalled();
  });

  it("refuses when bids cannot cover the repayment", async () => {
    await expect(
      buildRouteRepayWithFrozenCollateral(ctx, parse({ network: "kelp-replay", ...input, repayAmount: "5000" })),
    ).rejects.toThrow(/less than repayAmount/);
  });
});
