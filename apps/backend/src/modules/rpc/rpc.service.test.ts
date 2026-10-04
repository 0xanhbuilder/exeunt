import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../shared/errors/AppError.js";
import { RpcProxyService } from "./rpc.service.js";
import type { JsonRpcRequest, JsonRpcResponse, RpcUpstream } from "./rpc.types.js";

function setup() {
  const send = vi.fn<RpcUpstream["send"]>(async (_url, body) =>
    Array.isArray(body)
      ? body.map((r): JsonRpcResponse => ({ jsonrpc: "2.0", id: r.id ?? null, result: r.method }))
      : { jsonrpc: "2.0", id: body.id ?? null, result: body.method },
  );
  const service = new RpcProxyService({ rpcUrl: () => "http://127.0.0.1:8602" }, { send });
  return { service, send };
}

const call = (method: string, id = 1): JsonRpcRequest => ({ jsonrpc: "2.0", id, method, params: [] });

describe("RpcProxyService", () => {
  it("forwards reads and signed transactions to the fork node", async () => {
    const { service, send } = setup();
    await expect(service.forward("kelp-replay", call("eth_call"))).resolves.toMatchObject({ result: "eth_call" });
    await service.forward("kelp-replay", call("eth_sendRawTransaction"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8602");
  });

  it.each([
    "anvil_setBalance",
    "anvil_impersonateAccount",
    "evm_increaseTime",
    "hardhat_impersonateAccount",
    "eth_sendTransaction",
    "eth_sign",
    "eth_signTypedData_v4",
    "personal_sign",
  ])("never forwards %s", async (method) => {
    const { service, send } = setup();
    const res = (await service.forward("earn-bank-run", call(method))) as JsonRpcResponse;
    expect(res.error?.code).toBe(-32601);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers a mixed batch in order, rejecting only the blocked entries", async () => {
    const { service, send } = setup();
    const res = (await service.forward("kelp-replay", [
      call("eth_chainId", 1),
      call("anvil_mine", 2),
      call("eth_blockNumber", 3),
    ])) as JsonRpcResponse[];
    expect(res.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(res[0]?.result).toBe("eth_chainId");
    expect(res[1]?.error?.code).toBe(-32601);
    expect(res[2]?.result).toBe("eth_blockNumber");
    expect(send.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it("refuses live networks, which have public RPCs", async () => {
    const { service } = setup();
    await expect(service.forward("arbitrum-sepolia", call("eth_chainId"))).rejects.toBeInstanceOf(AppError);
  });
});
