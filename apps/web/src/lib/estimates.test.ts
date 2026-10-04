import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import {
  discountedValue,
  estimateAaveHealthAfter,
  estimateAaveRepay,
  estimateMorphoHealthAfter,
  valueInBase,
} from "./estimates";

const E = 10n ** 18n;

describe("estimateAaveRepay", () => {
  it("charges the Aave premium on the flash chunk when Aave is the source", () => {
    const r = estimateAaveRepay({ assets: 10n * E, aaveChunk: 20n * E, externalChunk: 0n, premiumBps: 5n, maxLoops: 64n });
    expect(r.ok).toBe(true);
    expect(r.usesExternalFlash).toBe(false);
    expect(r.flashFee).toBe((10n * E * 5n) / 10_000n);
    expect(r.debtRepaid).toBe(10n * E - r.flashFee);
  });
  it("uses the free external source when it can lend at least as much", () => {
    const r = estimateAaveRepay({ assets: 10n * E, aaveChunk: E, externalChunk: 50n * E, premiumBps: 5n, maxLoops: 64n });
    expect(r.usesExternalFlash).toBe(true);
    expect(r.flashFee).toBe(0n);
    expect(r.debtRepaid).toBe(10n * E);
  });
  it("charges the premium on the chunk, not the whole purchase, when it loops", () => {
    const r = estimateAaveRepay({ assets: 10n * E, aaveChunk: E, externalChunk: 0n, premiumBps: 5n, maxLoops: 64n });
    expect(r.flashFee).toBe((E * 5n) / 10_000n);
  });
  it("refuses when there is no flash liquidity or too many loops", () => {
    expect(estimateAaveRepay({ assets: E, aaveChunk: 0n, externalChunk: 0n, premiumBps: 5n, maxLoops: 64n }).ok).toBe(false);
    const tooMany = estimateAaveRepay({ assets: 100n, aaveChunk: 1n, externalChunk: 0n, premiumBps: 0n, maxLoops: 64n });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.reason).toMatch(/smaller amount/);
  });
});

describe("health estimates", () => {
  it("Aave: repaying debt and taking less collateral raises health", () => {
    const before = estimateAaveHealthAfter({
      totalCollateralBase: 2_000n,
      totalDebtBase: 1_000n,
      liquidationThresholdBps: 8_000n,
      collateralRemovedBase: 0n,
      debtRepaidBase: 0n,
    });
    const after = estimateAaveHealthAfter({
      totalCollateralBase: 2_000n,
      totalDebtBase: 1_000n,
      liquidationThresholdBps: 8_000n,
      collateralRemovedBase: 97n,
      debtRepaidBase: 100n,
    });
    expect(before).toBe((16n * E) / 10n);
    expect(after !== null && before !== null && after > before).toBe(true);
  });
  it("Aave: all debt repaid is unbounded health", () => {
    expect(
      estimateAaveHealthAfter({
        totalCollateralBase: 10n,
        totalDebtBase: 5n,
        liquidationThresholdBps: 8_000n,
        collateralRemovedBase: 1n,
        debtRepaidBase: 5n,
      }),
    ).toBe(maxUint256);
  });
  it("Morpho: scales max borrow with the collateral left", () => {
    const h = estimateMorphoHealthAfter({
      health: 2n * E,
      debt: 100n,
      collateral: 1_000n,
      collateralRemoved: 500n,
      debtRepaid: 50n,
    });
    expect(h).toBe(2n * E);
    expect(estimateMorphoHealthAfter({ health: E, debt: 0n, collateral: 1n, collateralRemoved: 0n, debtRepaid: 0n })).toBeNull();
  });
});

describe("values", () => {
  it("prices token amounts in an 8-decimal base", () => {
    expect(valueInBase(2n * E, 18, 3_000n * 10n ** 8n)).toBe(6_000n * 10n ** 8n);
    expect(valueInBase(1_500_000n, 6, 10n ** 8n)).toBe(150_000_000n);
  });
  it("applies a discount in basis points", () => {
    expect(discountedValue(10_000n, 250)).toBe(9_750n);
  });
});
