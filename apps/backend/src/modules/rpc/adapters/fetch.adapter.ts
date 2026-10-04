import { AppError, ErrorCode } from "../../../shared/errors/AppError.js";
import type { JsonRpcRequest, JsonRpcResponse, RpcUpstream } from "../rpc.types.js";

/** Posts JSON-RPC to the fork node over HTTP. */
export class FetchRpcUpstream implements RpcUpstream {
  constructor(private readonly timeoutMs = 30_000) {}

  async send(url: string, body: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new AppError(502, ErrorCode.UPSTREAM_ERROR, `fork node answered HTTP ${res.status}`);
      return (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(502, ErrorCode.UPSTREAM_ERROR, "fork node is not reachable");
    }
  }
}
