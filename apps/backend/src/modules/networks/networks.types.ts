import type { NetworkKey, Venue } from "@exeunt/sdk";

export interface NetworkSummary {
  key: NetworkKey;
  label: string;
  description: string;
  venue: Venue;
  isFork: boolean;
  chainId: number;
  explorerUrl: string | null;
  deploymentLoaded: boolean;
  market: string | null;
  rpcReachable: boolean;
}
