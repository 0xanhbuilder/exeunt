import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { aaveExitMarketAbi, formatBps, morphoMarketId, parseDeployment } from "./index.js";

describe("morphoMarketId", () => {
  it("matches Morpho's keccak256(abi.encode(marketParams))", () => {
    // Known Morpho Blue market on Robinhood Chain (Steakhouse USDG liquidity market, USDe collateral).
    const id = morphoMarketId({
      loanToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      collateralToken: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
      oracle: "0xE64849bd4AD03DfaBbe02bb521de19997a19055f",
      irm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
      lltv: 915000000000000000n,
    });
    expect(id).toBe("0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6");
  });
});

describe("formatBps", () => {
  it("formats basis points as a percentage", () => {
    expect(formatBps(250)).toBe("2.50%");
    expect(formatBps(10_000, 0)).toBe("100%");
  });
});

describe("parseDeployment", () => {
  const base = {
    network: "arbitrum-sepolia",
    chainId: 421614,
    venue: "aave",
    market: "0x0000000000000000000000000000000000000001",
    receipt: "0x0000000000000000000000000000000000000002",
    underlying: "0x0000000000000000000000000000000000000003",
    priceRouter: "0x0000000000000000000000000000000000000004",
    exeuntVault: "0x0000000000000000000000000000000000000005",
    payTokens: [],
    aavePool: "0x0000000000000000000000000000000000000006",
    debtToken: "0x0000000000000000000000000000000000000007",
  };
  it("accepts a complete Aave deployment", () => {
    expect(parseDeployment(base).market).toBe(base.market);
  });
  it("rejects missing fields", () => {
    expect(() => parseDeployment({ ...base, market: undefined })).toThrow(/market/);
    expect(() => parseDeployment({ ...base, aavePool: undefined })).toThrow(/aave/);
  });
});

describe("ABI", () => {
  it("encodes a buy call with the venue data argument", () => {
    const data = encodeFunctionData({
      abi: aaveExitMarketAbi,
      functionName: "buyAndRepay",
      args: [1n, 10n, 0, 10n, "0x"],
    });
    expect(data.startsWith("0x")).toBe(true);
  });
});
