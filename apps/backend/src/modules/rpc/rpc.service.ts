import { NETWORKS, type NetworkKey } from "@exeunt/sdk";
import { AppError, ErrorCode } from "../../shared/errors/AppError.js";
import type { ChainGateway } from "../../shared/integrations/chain/chain.gateway.js";
import type { JsonRpcRequest, JsonRpcResponse, RpcUpstream } from "./rpc.types.js";

export type RpcChainPort = Pick<ChainGateway, "rpcUrl">;

/**
 * Public JSON-RPC methods of a demo fork. The node's own methods (anvil_*, evm_*, hardhat_*) and anything that
 * signs with its unlocked accounts (eth_sendTransaction, eth_sign*, personal_*) are never forwarded.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "net_version",
  "web3_clientVersion",
  "eth_syncing",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_createAccessList",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_sendRawTransaction",
]);

const METHOD_NOT_ALLOWED = -32601;

export class RpcProxyService {
  constructor(
    private readonly chain: RpcChainPort,
    private readonly upstream: RpcUpstream,
  ) {}

  /** Forwards allowed calls to the fork node; blocked calls in a batch get an error entry of their own. */
  async forward(
    network: NetworkKey,
    body: JsonRpcRequest | JsonRpcRequest[],
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    if (!NETWORKS[network].isFork) {
      throw new AppError(404, ErrorCode.NOT_FOUND, `${network} is a live network; use its public RPC`);
    }
    const url = this.chain.rpcUrl(network);
    if (!Array.isArray(body)) {
      return ALLOWED_METHODS.has(body.method) ? this.upstream.send(url, body) : this.reject(body);
    }
    const allowed = body.filter((r) => ALLOWED_METHODS.has(r.method));
    const forwarded = allowed.length > 0 ? await this.upstream.send(url, allowed) : [];
    const replies = new Map((Array.isArray(forwarded) ? forwarded : [forwarded]).map((r) => [r.id, r]));
    return body.map((r) =>
      ALLOWED_METHODS.has(r.method) ? (replies.get(r.id ?? null) ?? this.reject(r)) : this.reject(r),
    );
  }

  private reject(r: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: r.id ?? null,
      error: { code: METHOD_NOT_ALLOWED, message: `method ${r.method} is not available on this demo fork` },
    };
  }
}
