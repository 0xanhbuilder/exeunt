import { NETWORKS, type NetworkKey } from "@exeunt/sdk";
import type { ChainGateway } from "../../shared/integrations/chain/chain.gateway.js";
import type { NetworkSummary } from "./networks.types.js";

export type NetworksChainPort = Pick<ChainGateway, "deployment" | "isReachable">;

export class NetworksService {
  constructor(private readonly chain: NetworksChainPort) {}

  /** Every Exeunt network with its deployment status and RPC reachability (probed in parallel). */
  async getNetworks(): Promise<NetworkSummary[]> {
    const keys = Object.keys(NETWORKS) as NetworkKey[];
    return Promise.all(
      keys.map(async (key) => {
        const info = NETWORKS[key];
        const deployment = this.chain.deployment(key);
        return {
          key,
          label: info.label,
          description: info.description,
          venue: info.venue,
          isFork: info.isFork,
          chainId: deployment?.chainId ?? info.chain.id,
          explorerUrl: info.explorerUrl ?? null,
          deploymentLoaded: deployment !== null,
          market: deployment?.market ?? null,
          rpcReachable: await this.chain.isReachable(key),
        };
      }),
    );
  }
}
