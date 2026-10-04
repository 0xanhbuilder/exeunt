import { describe, expect, it } from "vitest";
import { BaseError, encodeErrorResult, parseAbi } from "viem";
import { aaveExitMarketAbi, morphoVaultExitMarketAbi } from "@exeunt/sdk";
import { findRevertData } from "../chain.js";
import { decodeRevert } from "../revert.js";
import { ADDR, AAVE_DEPLOYMENT, fakeChain, fakeNetwork } from "../testing/fakes.js";
import { simulateTransaction } from "./simulate.js";

describe("decodeRevert", () => {
  it("decodes Exeunt custom errors with arguments", () => {
    const data = encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "PriceTooHigh", args: [5n, 4n] });
    expect(decodeRevert(data)).toEqual({ name: "PriceTooHigh", signature: "PriceTooHigh(uint256 price, uint256 maxPay)", args: ["5", "4"] });
  });

  it("decodes Morpho-only errors and Error(string)", () => {
    const morpho = encodeErrorResult({ abi: morphoVaultExitMarketAbi, errorName: "BadAuthorization" });
    expect(decodeRevert(morpho)?.name).toBe("BadAuthorization");
    const plain = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["nope"] });
    expect(decodeRevert(plain)).toMatchObject({ name: "Error", args: ["nope"] });
  });

  it("returns null for unknown or missing data", () => {
    expect(decodeRevert("0xdeadbeef")).toBeNull();
    expect(decodeRevert(undefined)).toBeNull();
  });
});

describe("findRevertData", () => {
  it("finds the revert bytes nested in viem's error causes", () => {
    const inner = Object.assign(new Error("rpc"), { data: "0x1234abcd" });
    const outer = new BaseError("call failed", { cause: new BaseError("execution reverted", { cause: inner }) });
    expect(findRevertData(outer)).toBe("0x1234abcd");
    expect(findRevertData(new Error("no data"))).toBeUndefined();
  });
});

describe("simulate_transaction", () => {
  it("reports success and decoded reverts", async () => {
    const net = fakeNetwork(AAVE_DEPLOYMENT);
    const ctx = { chain: fakeChain({ "kelp-replay": net.handle }) };
    const args = { network: "kelp-replay" as const, from: ADDR.user, to: ADDR.market, data: "0x12345678", value: "0" };

    expect(await simulateTransaction(ctx, args)).toMatchObject({ ok: true });
    expect(net.reads.call).toHaveBeenCalledWith({ from: ADDR.user, to: ADDR.market, data: "0x12345678", value: 0n });

    net.reads.call.mockResolvedValue({
      ok: false,
      message: "execution reverted",
      revertData: encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "DebtTooSmall", args: [1n, 2n] }),
    });
    const failed = await simulateTransaction(ctx, args);
    expect(failed).toMatchObject({ ok: false, revert: { name: "DebtTooSmall", args: ["1", "2"] } });
  });
});
