import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import {
  aaveFlashPayIndices,
  allPayMask,
  buildPayMask,
  maskIncludes,
  maskIndices,
  morphoFlashPayIndex,
} from "./paymask";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const C = "0x00000000000000000000000000000000000000c3" as Address;
const aB = "0x00000000000000000000000000000000000000Ab" as Address;
const aC = "0x00000000000000000000000000000000000000Ac" as Address;

describe("payMask", () => {
  it("sets one bit per accepted payment token", () => {
    expect(buildPayMask([0])).toBe(0b1);
    expect(buildPayMask([0, 2])).toBe(0b101);
    expect(buildPayMask([])).toBe(0);
    expect(allPayMask(3)).toBe(0b111);
    expect(allPayMask(8)).toBe(255);
  });
  it("rejects indices that do not fit a uint8 mask", () => {
    expect(() => buildPayMask([8])).toThrow(/out of range/);
    expect(() => buildPayMask([-1])).toThrow();
  });
  it("reads bits back", () => {
    expect(maskIncludes(0b101, 0)).toBe(true);
    expect(maskIncludes(0b101, 1)).toBe(false);
    expect(maskIndices(0b1011, 4)).toEqual([0, 1, 3]);
    expect(maskIndices(0b1011, 2)).toEqual([0, 1]);
  });
});

describe("flash payment tokens", () => {
  it("Aave: needs an aToken and never the receipt's own underlying", () => {
    const d = { payTokens: [A, B, C], payATokens: [zeroAddress, aB, aC], underlying: C };
    expect(aaveFlashPayIndices(d)).toEqual([1]);
    expect(aaveFlashPayIndices({ payTokens: [A], underlying: C })).toEqual([]);
  });
  it("Morpho: the buyer's market collateral, if it is a payment token", () => {
    expect(morphoFlashPayIndex([A, B], B)).toBe(1);
    expect(morphoFlashPayIndex([A, B], C)).toBeNull();
    expect(morphoFlashPayIndex([A, B], undefined)).toBeNull();
  });
});
