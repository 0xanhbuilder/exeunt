import { createNetworksController } from "./networks.controller.js";
import { createNetworksRouter } from "./networks.routes.js";
import { NetworksService, type NetworksChainPort } from "./networks.service.js";

export function createNetworksModule(deps: { chain: NetworksChainPort }) {
  const service = new NetworksService(deps.chain);
  return { service, router: createNetworksRouter(createNetworksController(service)) };
}

export type { NetworkSummary } from "./networks.types.js";
export type { NetworksChainPort } from "./networks.service.js";
