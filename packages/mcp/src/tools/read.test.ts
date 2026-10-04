import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ADDR, AAVE_DEPLOYMENT, fakeChain, fakeNetwork, MORPHO_DEPLOYMENT, session, type FakeNetwork } from "../testing/fakes.js";
import type { ToolContext } from "./common.js";
import {
  getBorrowerPosition,
  getBorrowerPositionShape,
  getExitCapacity,
  listBids,
  listNetworks,
  planSellNow,
  planSellNowShape,
  quotePurchase,
  quotePurchaseShape,
} from "./read.js";

const E18 = 10n ** 18n;

let aave: FakeNetwork;
let morpho: FakeNetwork;
let ctx: ToolContext;

beforeEach(() => {
  aave = fakeNetwork(AAVE_DEPLOYMENT);
  morpho = fakeNetwork(MORPHO_DEPLOYMENT);
  ctx = { chain: fakeChain({ "kelp-replay": aave.handle, "earn-bank-run": morpho.handle }) };
});

describe("list_networks", () => {
  it("reports which networks have a deployment", async () => {
    const out = await listNetworks(ctx);
    const byKey = Object.fromEntries(out.networks.map((n) => [n.network, n]));
    expect(byKey["kelp-replay"]?.deployed).toBe(true);
    expect(byKey["kelp-replay"]?.contracts?.market).toBe(ADDR.market);
    expect(byKey["arbitrum-sepolia"]?.deployed).toBe(false);
    expect(byKey["arbitrum-sepolia"]?.contracts).toBeNull();
  });
});

describe("get_exit_capacity", () => {
  it("returns raw and human values and bid capacity at each discount level", async () => {
    vi.spyOn(aave.sdk, "capacity").mockResolvedValue({
      withdrawable: E18 / 10n,
      supplied: 1_000n * E18,
      utilizationBps: 9_999,
      debtorCapacity: 900n * E18,
      sessionAssets: 5n * E18,
    });
    const bidAt = vi.spyOn(aave.sdk, "bidCapacityAt").mockImplementation(async (d: number) => BigInt(d) * E18);
    const out = await getExitCapacity(ctx, { network: "kelp-replay" });
    expect(out.withdrawableNow).toEqual({ raw: "100000000000000000", human: "0.1", symbol: "WETH" });
    expect(out.utilization).toEqual({ bps: 9_999, percent: "99.99%" });
    expect(bidAt.mock.calls.map((c) => c[0])).toEqual([100, 300, 500, 1_000, 2_000]);
    expect(out.bidCapacity[2]).toEqual({ maxDiscount: { bps: 500, percent: "5.00%" }, assets: { raw: (500n * E18).toString(), human: "500", symbol: "WETH" } });
  });

  it("fails clearly on a network without a deployment", async () => {
    await expect(getExitCapacity(ctx, { network: "arbitrum-sepolia" })).rejects.toThrow(/No Exeunt deployment found/);
  });
});

describe("quote_purchase", () => {
  const parse = (raw: unknown) => z.object(quotePurchaseShape).parse(raw);

  it("prices at the session's current discount and shows the saving", async () => {
    vi.spyOn(aave.sdk, "session").mockResolvedValue(session({ discountBps: 250 }));
    const quote = vi.spyOn(aave.sdk, "quote").mockResolvedValue(4_875_000_000n);
    const out = await quotePurchase(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "2", payToken: "usdc" }));
    expect(quote).toHaveBeenCalledWith(2n * E18, 250, ADDR.USDC);
    expect(out.price).toEqual({ raw: "4875000000", human: "4875", symbol: "USDC" });
    expect(out.savings.human).toBe("0.05");
    expect(out.currentDiscount.percent).toBe("2.50%");
  });

  it("rejects pay tokens the session does not accept and unknown tokens", async () => {
    vi.spyOn(aave.sdk, "session").mockResolvedValue(session({ acceptedPayTokens: [ADDR.USDG] }));
    await expect(quotePurchase(ctx, parse({ network: "kelp-replay", sessionId: "1", assets: "1", payToken: "USDC" }))).rejects.toThrow(
      /does not accept USDC/,
    );
    await expect(quotePurchase(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "1", payToken: "DAI" }))).rejects.toThrow(
      /Accepted: USDG/,
    );
  });

  it("rejects buying more than the session has left", async () => {
    vi.spyOn(aave.sdk, "session").mockResolvedValue(session({ remainingAssets: E18 }));
    await expect(quotePurchase(ctx, parse({ network: "kelp-replay", sessionId: 1, assets: "1.5", payToken: "WETH" }))).rejects.toThrow(
      /only has 1 WETH left/,
    );
  });

  it("validates input shape", () => {
    expect(() => parse({ network: "mainnet", sessionId: 1, assets: "1", payToken: "WETH" })).toThrow();
    expect(() => parse({ network: "kelp-replay", sessionId: 0, assets: "1", payToken: "WETH" })).toThrow();
    expect(() => parse({ network: "kelp-replay", sessionId: 1, assets: "1e18", payToken: "WETH" })).toThrow();
  });
});

describe("list_bids", () => {
  it("flags Exeunt Vault bids and uses each bid's pay token decimals", async () => {
    vi.spyOn(aave.sdk, "bids").mockResolvedValue([
      { id: 3n, bidder: ADDR.aaveVault, minDiscountBps: 300, payIdx: 2, payToken: ADDR.WETH, maxAssets: 10n * E18, escrow: 9n * E18, capacityAssets: 9n * E18 },
      { id: 4n, bidder: ADDR.bidder, minDiscountBps: 500, payIdx: 1, payToken: ADDR.USDC, maxAssets: E18, escrow: 2_000_000_000n, capacityAssets: E18 / 2n },
    ]);
    const out = await listBids(ctx, { network: "kelp-replay" });
    expect(out.bids[0]?.isExeuntVault).toBe(true);
    expect(out.bids[1]?.escrow).toEqual({ raw: "2000000000", human: "2000", symbol: "USDC" });
    expect(out.bids[1]?.buysUpTo.human).toBe("0.5");
  });
});

describe("get_borrower_position", () => {
  it("shows Morpho debt, health and collateral", async () => {
    vi.spyOn(morpho.sdk, "position").mockResolvedValue({
      debt: 5_000_000_000n,
      health: (3n * E18) / 2n,
      market: { loanToken: ADDR.morphoUSDG, collateralToken: ADDR.USDe, oracle: ADDR.oracle, irm: ADDR.irm, lltv: 915n * 10n ** 15n },
      marketId: "0x01",
      collateral: 20_000n * E18,
    });
    const args = z.object(getBorrowerPositionShape).parse({ network: "earn-bank-run", address: ADDR.user });
    const out = await getBorrowerPosition(ctx, args);
    expect(out.debt).toEqual({ raw: "5000000000", human: "5000", symbol: "USDG" });
    expect(out.health).toBe("1.5");
    expect(out.collateral).toEqual({ raw: (20_000n * E18).toString(), human: "20000", symbol: "USDe" });
  });
});

describe("plan_sell_now", () => {
  it("builds the pay mask from the chosen tokens and reports unfilled amount", async () => {
    const plan = vi.spyOn(aave.sdk, "planSellNow").mockResolvedValue({
      bidIds: [4n],
      fills: [{ bidId: 4n, assets: E18, pay: 1_900_000_000n, payToken: ADDR.USDC, discountBps: 500 }],
      filledAssets: E18,
      proceeds: { [ADDR.USDC]: 1_900_000_000n },
      averageDiscountBps: 500,
    });
    const args = z.object(planSellNowShape).parse({ network: "kelp-replay", assets: "3", maxDiscountBps: 600, payTokens: ["USDC", ADDR.wstETH] });
    const out = await planSellNow(ctx, args);
    expect(plan).toHaveBeenCalledWith(3n * E18, 600, 0b1010);
    expect(out.unfilled.human).toBe("2");
    expect(out.proceeds).toEqual([{ raw: "1900000000", human: "1900", symbol: "USDC" }]);
    expect(out.notes.join(" ")).toMatch(/open a Dutch-auction session/);
  });

  it("rejects discounts above the contract maximum", () => {
    expect(() => z.object(planSellNowShape).parse({ network: "kelp-replay", assets: "1", maxDiscountBps: 5_001 })).toThrow();
  });
});
