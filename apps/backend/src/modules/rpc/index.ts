import { FetchRpcUpstream } from "./adapters/fetch.adapter.js";
import { createRpcController } from "./rpc.controller.js";
import { createRpcRouter } from "./rpc.routes.js";
import { RpcProxyService, type RpcChainPort } from "./rpc.service.js";
import type { RpcUpstream } from "./rpc.types.js";

/** Composition root of the fork RPC proxy. `upstream` replaces the HTTP adapter (tests). */
export function createRpcModule(deps: { chain: RpcChainPort; upstream?: RpcUpstream }) {
  const service = new RpcProxyService(deps.chain, deps.upstream ?? new FetchRpcUpstream());
  return { service, router: createRpcRouter(createRpcController(service)) };
}

export type { RpcChainPort } from "./rpc.service.js";
export type { RpcUpstream } from "./rpc.types.js";
