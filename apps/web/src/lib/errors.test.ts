import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi } from "viem";
import { aaveExitMarketAbi, aaveCollateralRouteAbi, morphoVaultExitMarketAbi } from "@exeunt/sdk";
import { describeError, describeRevertData, extractRevertData, isForkStateError } from "./errors";

const solidity = parseAbi(["error Error(string)", "error Panic(uint256)"]);

describe("extractRevertData", () => {
  it("finds revert data nested in the cause chain", () => {
    const data = encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "SessionClosed" });
    const err = { shortMessage: "Execution reverted", cause: { cause: { data } } };
    expect(extractRevertData(err)).toBe(data);
  });
  it("reads the { data: { data } } shape some RPCs return", () => {
    const data = encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "ZeroAmount" });
    expect(extractRevertData({ cause: { data: { data } } })).toBe(data);
  });
  it("returns undefined when there is none", () => {
    expect(extractRevertData(new Error("boom"))).toBeUndefined();
    expect(extractRevertData({ data: "0x" })).toBeUndefined();
  });
});

describe("describeRevertData", () => {
  it("explains market errors", () => {
    const data = encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "DebtTooSmall", args: [1n, 2n] });
    expect(describeRevertData(data)).toMatch(/debt is smaller/);
  });
  it("explains errors only the Morpho market and the route define", () => {
    expect(describeRevertData(encodeErrorResult({ abi: morphoVaultExitMarketAbi, errorName: "BadAuthorization" }))).toMatch(
      /permission/,
    );
    expect(
      describeRevertData(encodeErrorResult({ abi: aaveCollateralRouteAbi, errorName: "ProceedsTooLow", args: [1n, 2n] })),
    ).toMatch(/not raise enough/);
  });
  it("labels numeric Aave reason strings", () => {
    const data = encodeErrorResult({ abi: solidity, errorName: "Error", args: ["35"] });
    expect(describeRevertData(data)).toBe("Aave rejected the call (Aave error code 35).");
  });
  it("passes other reason strings through and names panics", () => {
    expect(describeRevertData(encodeErrorResult({ abi: solidity, errorName: "Error", args: ["nope"] }))).toBe("nope");
    expect(describeRevertData(encodeErrorResult({ abi: solidity, errorName: "Panic", args: [17n] }))).toMatch(/overflow/);
  });
  it("returns null for unknown selectors", () => {
    expect(describeRevertData("0xdeadbeef")).toBeNull();
  });
});

describe("describeError", () => {
  it("recognises wallet rejections", () => {
    expect(describeError({ code: 4001, message: "User rejected" })).toMatch(/rejected/);
    expect(describeError({ cause: { name: "UserRejectedRequestError" } })).toMatch(/rejected/);
  });
  it("prefers decoded revert reasons", () => {
    const data = encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "InsufficientFill", args: [1n, 2n] });
    expect(describeError({ shortMessage: "Execution reverted", cause: { data } })).toMatch(/bids changed/);
  });
  it("explains forks that cannot serve untouched state", () => {
    const err = { shortMessage: "RPC failed", cause: { details: "historical state 53b5 is not available" } };
    expect(isForkStateError(err)).toBe(true);
    expect(describeError(err)).toMatch(/demo funds/i);
  });
  it("falls back to the short message, then the first line", () => {
    expect(describeError({ shortMessage: "Nonce too low.", details: "nonce 3" })).toBe("Nonce too low. nonce 3");
    expect(describeError(new Error("first\nsecond"))).toBe("first");
  });
});
