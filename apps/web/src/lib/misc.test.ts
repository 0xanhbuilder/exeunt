import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Address } from "viem";
import { chartGeometry } from "./chart";
import { checkDeployment, loadDeployment } from "./deployment";
import { resolveApiUrl, resolveRpcUrl, rpcEnvName } from "./env";
import { summarizeFills, type SellerFill } from "./history";
import { bidLevels, bidOwner } from "./orderbook";
import { routeFromHash } from "./router";
import { withGasBuffer } from "./tx";
import { isLiquidityMarket } from "./venue";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;

describe("env", () => {
  it("derives the RPC override name from the network key", () => {
    expect(rpcEnvName("arbitrum-sepolia")).toBe("VITE_RPC_ARBITRUM_SEPOLIA");
    expect(rpcEnvName("earn-bank-run")).toBe("VITE_RPC_EARN_BANK_RUN");
  });
  it("uses the override, else the SDK default", () => {
    expect(resolveRpcUrl("kelp-replay", { VITE_RPC_KELP_REPLAY: "http://x:1" })).toBe("http://x:1");
    expect(resolveRpcUrl("kelp-replay", { VITE_RPC_KELP_REPLAY: " " })).toBe("http://127.0.0.1:8602");
  });
  it("defaults the backend URL and trims trailing slashes", () => {
    expect(resolveApiUrl({})).toBe("http://127.0.0.1:8787");
    expect(resolveApiUrl({ VITE_API_URL: "https://api.example/" })).toBe("https://api.example");
  });
});

describe("deployments", () => {
  const raw = {
    network: "arbitrum-sepolia",
    chainId: 421614,
    venue: "aave",
    market: A,
    receipt: A,
    underlying: A,
    priceRouter: A,
    exeuntVault: A,
    payTokens: [A],
    aavePool: A,
    debtToken: A,
  };
  it("accepts a file for the requested network", () => {
    expect(checkDeployment("arbitrum-sepolia", raw).status).toBe("ready");
  });
  it("rejects files for another network or chain", () => {
    expect(checkDeployment("kelp-replay", raw).status).toBe("invalid");
    expect(checkDeployment("arbitrum-sepolia", { ...raw, chainId: 1 }).status).toBe("invalid");
    expect(checkDeployment("arbitrum-sepolia", { ...raw, market: undefined }).status).toBe("invalid");
  });
  it("treats 404s and HTML fallbacks as not deployed", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as typeof fetch;
    const html = (async () => new Response("<!doctype html>", { status: 200 })) as typeof fetch;
    const ok = (async () => new Response(JSON.stringify(raw), { status: 200 })) as typeof fetch;
    expect((await loadDeployment("arbitrum-sepolia", "/", notFound)).status).toBe("missing");
    expect((await loadDeployment("arbitrum-sepolia", "/", html)).status).toBe("missing");
    expect((await loadDeployment("arbitrum-sepolia", "/", ok)).status).toBe("ready");
  });
});

describe("order book", () => {
  it("groups bids by discount with running totals", () => {
    const levels = bidLevels([
      { minDiscountBps: 300, capacityAssets: 150n },
      { minDiscountBps: 100, capacityAssets: 12n },
      { minDiscountBps: 100, capacityAssets: 3n },
      { minDiscountBps: 500, capacityAssets: 0n },
    ]);
    expect(levels).toEqual([
      { discountBps: 100, size: 15n, cumulative: 15n },
      { discountBps: 300, size: 150n, cumulative: 165n },
    ]);
  });
  it("labels the vault's bid and yours", () => {
    expect(bidOwner(A, A, B)).toBe("vault");
    expect(bidOwner(B, A, B)).toBe("mine");
    expect(bidOwner(B, A, null)).toBe("other");
  });
});

describe("summarizeFills", () => {
  const fill = (assets: bigint, paid: bigint, payToken: Address | null, discountBps: number): SellerFill => ({
    sessionId: 1n,
    assets,
    paid,
    payToken,
    discountBps,
    txHash: null,
    via: "bid",
  });
  it("sums proceeds per token and weights the discount by size", () => {
    const s = summarizeFills([fill(100n, 99n, A, 100), fill(300n, 291n, B, 300), fill(100n, 97n, A, 300)]);
    expect(s.assets).toBe(500n);
    expect(s.avgDiscountBps).toBe(260);
    expect(s.received).toEqual([
      { token: A, amount: 196n },
      { token: B, amount: 291n },
    ]);
  });
  it("has no average without fills", () => {
    expect(summarizeFills([]).avgDiscountBps).toBeNull();
  });
});

describe("chartGeometry", () => {
  const box = { width: 640, height: 210, left: 48, right: 14, top: 18, bottom: 30 };
  it("spans the plot and puts 100% at the top", () => {
    const g = chartGeometry(
      [
        { t: 2_000, utilizationBps: 10_000 },
        { t: 1_000, utilizationBps: 9_000 },
      ],
      box,
    );
    expect(g.maxBps).toBe(10_000);
    expect(g.minBps).toBe(8_500);
    expect(g.polyline.split(" ")).toHaveLength(2);
    expect(g.last).toEqual({ x: 626, y: 18 });
    expect(g.yFor(10_000)).toBe(18);
  });
  it("keeps the alert threshold in range", () => {
    const g = chartGeometry([{ t: 1, utilizationBps: 9_900 }], box, 7_000);
    expect(g.minBps).toBeLessThanOrEqual(7_000);
  });
});

describe("router", () => {
  it("maps hashes to pages", () => {
    expect(routeFromHash("")).toBe("overview");
    expect(routeFromHash("#/sell")).toBe("sell");
    expect(routeFromHash("#/frozen-collateral")).toBe("frozen");
    expect(routeFromHash("#/nope")).toBe("overview");
  });
});

describe("isLiquidityMarket", () => {
  const market = { loanToken: A, collateralToken: B, oracle: A, irm: B, lltv: 915n * 10n ** 15n };
  const data = encodeAbiParameters(
    [
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
    ],
    [market],
  );
  it("matches the vault's liquidity market through the same adapter", () => {
    expect(isLiquidityMarket(A, data, A, market)).toBe(true);
  });
  it("needs forced deallocation for other markets or adapters", () => {
    expect(isLiquidityMarket(A, data, A, { ...market, lltv: 1n })).toBe(false);
    expect(isLiquidityMarket(B, data, A, market)).toBe(false);
    expect(isLiquidityMarket(A, "0x", A, market)).toBe(false);
  });
});

describe("withGasBuffer", () => {
  it("adds 30% to the estimate", () => {
    expect(withGasBuffer(141_740n)).toBe(184_262n);
    expect(withGasBuffer(100_000n)).toBe(130_000n);
  });
});
