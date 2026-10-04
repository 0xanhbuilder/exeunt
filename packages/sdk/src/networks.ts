import { defineChain, type Address, type Chain, type Hex } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

export type NetworkKey = "arbitrum-sepolia" | "robinhood-testnet" | "kelp-replay" | "earn-bank-run";
export type Venue = "aave" | "morpho";

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

export interface NetworkInfo {
  key: NetworkKey;
  label: string;
  description: string;
  chain: Chain;
  venue: Venue;
  /** Fork scenarios run on a local or hosted fork node, not on the public chain. */
  isFork: boolean;
  defaultRpcUrl: string;
  explorerUrl?: string;
}

export const NETWORKS: Record<NetworkKey, NetworkInfo> = {
  "arbitrum-sepolia": {
    key: "arbitrum-sepolia",
    label: "Arbitrum Sepolia",
    description: "Live testnet · Aave V3 · aWETH",
    chain: arbitrumSepolia,
    venue: "aave",
    isFork: false,
    defaultRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
  },
  "robinhood-testnet": {
    key: "robinhood-testnet",
    label: "Robinhood Testnet",
    description: "Live testnet · Morpho Earn (sim) · USDG",
    chain: robinhoodTestnet,
    venue: "morpho",
    isFork: false,
    defaultRpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  },
  "kelp-replay": {
    key: "kelp-replay",
    label: "Kelp replay",
    description: "Arbitrum One fork · 18 Apr 2026 · Aave WETH at 100%",
    chain: { ...arbitrum, rpcUrls: { default: { http: ["http://127.0.0.1:8602"] } } },
    venue: "aave",
    isFork: true,
    defaultRpcUrl: "http://127.0.0.1:8602",
  },
  "earn-bank-run": {
    key: "earn-bank-run",
    label: "Earn bank-run",
    description: "Robinhood Chain fork · Steakhouse USDG drained",
    chain: { ...robinhoodChain, rpcUrls: { default: { http: ["http://127.0.0.1:8604"] } } },
    venue: "morpho",
    isFork: true,
    defaultRpcUrl: "http://127.0.0.1:8604",
  },
};

/** Addresses written by contracts/script/Deploy.s.sol. */
export interface Deployment {
  network: NetworkKey;
  chainId: number;
  deployBlock: number;
  venue: Venue;
  market: Address;
  receipt: Address;
  underlying: Address;
  priceRouter: Address;
  exeuntVault: Address;
  payTokens: Address[];
  // Aave
  aavePool?: Address;
  debtToken?: Address;
  payATokens?: Address[];
  collateralRoute?: Address;
  externalFlash?: Address;
  // Morpho
  morpho?: Address;
  earnVault?: Address;
  adapter?: Address;
  collateral?: Address;
  earnMarketId?: Hex;
  flashMarketId?: Hex;
}

const REQUIRED: (keyof Deployment)[] = [
  "network",
  "chainId",
  "venue",
  "market",
  "receipt",
  "underlying",
  "priceRouter",
  "exeuntVault",
  "payTokens",
];

/** Validates a deployment JSON object; throws with the first missing field. */
export function parseDeployment(raw: unknown): Deployment {
  if (typeof raw !== "object" || raw === null) throw new Error("deployment: not an object");
  const d = raw as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (d[key] === undefined) throw new Error(`deployment: missing ${key}`);
  }
  if (d.venue === "aave" && (!d.aavePool || !d.debtToken)) throw new Error("deployment: aave fields missing");
  if (d.venue === "morpho" && (!d.morpho || !d.earnVault || !d.adapter)) {
    throw new Error("deployment: morpho fields missing");
  }
  return d as unknown as Deployment;
}
