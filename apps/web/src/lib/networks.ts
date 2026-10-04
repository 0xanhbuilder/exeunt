import { NETWORKS, type NetworkInfo, type NetworkKey } from "@exeunt/sdk";

export const NETWORK_KEYS = Object.keys(NETWORKS) as NetworkKey[];

export const DEFAULT_NETWORK: NetworkKey = "arbitrum-sepolia";

export function isNetworkKey(value: unknown): value is NetworkKey {
  return typeof value === "string" && (NETWORK_KEYS as string[]).includes(value);
}

export interface NetworkGroup {
  title: string;
  networks: NetworkInfo[];
}

export function networkGroups(): NetworkGroup[] {
  const all = NETWORK_KEYS.map((k) => NETWORKS[k]);
  return [
    { title: "Live testnets", networks: all.filter((n) => !n.isFork) },
    { title: "Scenario forks", networks: all.filter((n) => n.isFork) },
  ];
}

export function networkKind(n: NetworkInfo): string {
  return n.isFork ? "Scenario fork" : "Live testnet";
}

export function venueLabel(n: NetworkInfo): string {
  return n.venue === "aave" ? "Aave V3" : "Morpho";
}

export function explorerTxUrl(n: NetworkInfo, hash: string): string | null {
  return n.explorerUrl ? `${n.explorerUrl.replace(/\/+$/, "")}/tx/${hash}` : null;
}

export function explorerAddressUrl(n: NetworkInfo, address: string): string | null {
  return n.explorerUrl ? `${n.explorerUrl.replace(/\/+$/, "")}/address/${address}` : null;
}
