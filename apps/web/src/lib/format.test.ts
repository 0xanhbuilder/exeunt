import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import {
  bpsToPercentInput,
  displayDecimals,
  formatAmount,
  formatDuration,
  formatHealth,
  formatShare,
  formatToken,
  parseAmountInput,
  parsePercentToBps,
  shortAddress,
  toInputString,
  utilizationTone,
} from "./format";

describe("formatAmount", () => {
  it("uses token decimals and thousands separators", () => {
    expect(formatAmount(1_234_567_890n, 6)).toBe("1,234.57");
    expect(formatAmount(12_500_000_000_000_000_000n, 18)).toBe("12.5");
  });
  it("shows tiny non-zero values as a bound instead of zero", () => {
    expect(formatAmount(1n, 18)).toBe("< 0.0001");
    expect(formatAmount(0n, 18)).toBe("0");
  });
  it("keeps the sign of negative values", () => {
    expect(formatAmount(-1_500_000n, 6)).toBe("-1.5");
  });
  it("picks precision from the token", () => {
    expect(displayDecimals(18)).toBe(4);
    expect(displayDecimals(6)).toBe(2);
    expect(formatToken(10n ** 18n, { decimals: 18, symbol: "WETH" })).toBe("1 WETH");
  });
});

describe("parseAmountInput", () => {
  it("parses plain and separated numbers", () => {
    expect(parseAmountInput("1.5", 18).value).toBe(1_500_000_000_000_000_000n);
    expect(parseAmountInput("1,234.5", 6).value).toBe(1_234_500_000n);
    expect(parseAmountInput(".5", 6).value).toBe(500_000n);
  });
  it("treats empty input as neither value nor error", () => {
    expect(parseAmountInput("  ", 6)).toEqual({ value: null, error: null });
  });
  it("rejects junk and excess precision", () => {
    expect(parseAmountInput("abc", 6).error).toMatch(/number/);
    expect(parseAmountInput("1.2.3", 6).value).toBeNull();
    expect(parseAmountInput("-1", 6).value).toBeNull();
    expect(parseAmountInput("1.1234567", 6).error).toBe("At most 6 decimals");
  });
  it("round-trips through toInputString", () => {
    const v = 123_456_789n;
    expect(parseAmountInput(toInputString(v, 6), 6).value).toBe(v);
  });
});

describe("parsePercentToBps", () => {
  it("converts percent text to basis points", () => {
    expect(parsePercentToBps("2.5")).toBe(250);
    expect(parsePercentToBps("3")).toBe(300);
    expect(parsePercentToBps("0.05")).toBe(5);
    expect(parsePercentToBps("95 %")).toBe(9500);
  });
  it("rejects more than two decimals and junk", () => {
    expect(parsePercentToBps("2.555")).toBeNull();
    expect(parsePercentToBps("x")).toBeNull();
    expect(parsePercentToBps("")).toBeNull();
  });
  it("formats basis points back for inputs", () => {
    expect(bpsToPercentInput(200)).toBe("2.00");
  });
});

describe("formatHealth", () => {
  it("formats 1e18-scaled health with two decimals", () => {
    expect(formatHealth(1_523_400_000_000_000_000n)).toBe("1.52");
  });
  it("reports unbounded health as no debt and caps huge values", () => {
    expect(formatHealth(maxUint256)).toBe("No debt");
    expect(formatHealth(2_585_944_068n * 10n ** 18n)).toBe("> 1,000");
  });
});

describe("formatDuration", () => {
  it("uses the two largest units", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(12 * 60)).toBe("12 m");
    expect(formatDuration(5 * 3600 + 10 * 60)).toBe("5 h 10 m");
    expect(formatDuration(2 * 86_400 + 3 * 3600)).toBe("2 d 3 h");
    expect(formatDuration(-5)).toBe("0 s");
  });
});

describe("misc", () => {
  it("shortens addresses", () => {
    expect(shortAddress("0x7a4e00000000000000000000000000000003c1e")).toBe("0x7a4e…3c1e");
  });
  it("bands utilization like the mockup", () => {
    expect(utilizationTone(9_977)).toBe("frozen");
    expect(utilizationTone(9_170)).toBe("tight");
    expect(utilizationTone(8_449)).toBe("open");
  });
  it("formats shares of a total", () => {
    expect(formatShare(1n, 100n)).toBe("1.00%");
    expect(formatShare(5n, 0n)).toBe("0.00%");
  });
});
