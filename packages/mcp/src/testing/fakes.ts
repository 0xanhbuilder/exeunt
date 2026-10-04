import { vi, type Mock } from "vitest";
import { createPublicClient, custom, getAddress, type Address, type PublicClient } from "viem";
import {
  ExeuntClient,
  NETWORKS,
  type Deployment,
  type NetworkKey,
  type SessionView,
  type TokenInfo,
} from "@exeunt/sdk";
import type { ChainReads, ExeuntChain, NetworkHandle } from "../chain.js";
import { NETWORK_KEYS } from "../config.js";
import { ToolError } from "../errors.js";

const a = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

export const ADDR = {
  market: a(0x1001),
  aWETH: a(0x1002),
  WETH: a(0x1003),
  priceRouter: a(0x1004),
  aaveVault: a(0x1005),
  USDG: a(0x1006),
  USDC: a(0x1007),
  wstETH: a(0x1008),
  aUSDC: a(0x1009),
  awstETH: a(0x100a),
  aavePool: a(0x100b),
  debtToken: a(0x100c),
  route: a(0x100d),
  morphoMarket: a(0x2001),
  steakUSDG: a(0x2002),
  morphoUSDG: a(0x2003),
  USDe: a(0x2004),
  morpho: a(0x2005),
  adapter: a(0x2006),
  morphoVault: a(0x2007),
  oracle: a(0x2008),
  irm: a(0x2009),
  user: a(0xbeef),
  seller: a(0x5e11),
  bidder: a(0xb1d),
} as const;

export const AAVE_DEPLOYMENT: Deployment = {
  network: "kelp-replay",
  chainId: 42161,
  deployBlock: 1,
  venue: "aave",
  market: ADDR.market,
  receipt: ADDR.aWETH,
  underlying: ADDR.WETH,
  priceRouter: ADDR.priceRouter,
  exeuntVault: ADDR.aaveVault,
  payTokens: [ADDR.USDG, ADDR.USDC, ADDR.WETH, ADDR.wstETH],
  payATokens: ["0x0000000000000000000000000000000000000000", ADDR.aUSDC, "0x0000000000000000000000000000000000000000", ADDR.awstETH],
  aavePool: ADDR.aavePool,
  debtToken: ADDR.debtToken,
  collateralRoute: ADDR.route,
};

export const MORPHO_DEPLOYMENT: Deployment = {
  network: "earn-bank-run",
  chainId: 4663,
  deployBlock: 1,
  venue: "morpho",
  market: ADDR.morphoMarket,
  receipt: ADDR.steakUSDG,
  underlying: ADDR.morphoUSDG,
  priceRouter: ADDR.priceRouter,
  exeuntVault: ADDR.morphoVault,
  payTokens: [ADDR.morphoUSDG, ADDR.USDe],
  morpho: ADDR.morpho,
  earnVault: ADDR.steakUSDG,
  adapter: ADDR.adapter,
  collateral: ADDR.USDe,
};

const TOKENS: TokenInfo[] = [
  { address: ADDR.aWETH, symbol: "aArbWETH", decimals: 18 },
  { address: ADDR.WETH, symbol: "WETH", decimals: 18 },
  { address: ADDR.USDG, symbol: "USDG", decimals: 6 },
  { address: ADDR.USDC, symbol: "USDC", decimals: 6 },
  { address: ADDR.wstETH, symbol: "wstETH", decimals: 18 },
  { address: ADDR.aUSDC, symbol: "aArbUSDC", decimals: 6 },
  { address: ADDR.awstETH, symbol: "aArbwstETH", decimals: 18 },
  { address: ADDR.aaveVault, symbol: "exWETH", decimals: 21 },
  { address: ADDR.steakUSDG, symbol: "steakUSDG", decimals: 18 },
  { address: ADDR.morphoUSDG, symbol: "USDG", decimals: 6 },
  { address: ADDR.USDe, symbol: "USDe", decimals: 18 },
  { address: ADDR.morphoVault, symbol: "exUSDG", decimals: 9 },
];

/** A PublicClient that fails every request, so tests cannot reach a network. */
export const offlineClient: PublicClient = createPublicClient({
  transport: custom({
    async request() {
      throw new Error("network access is disabled in tests");
    },
  }),
});

export interface FakeNetwork {
  handle: NetworkHandle;
  sdk: ExeuntClient;
  reads: { [K in keyof ChainReads]: Mock<ChainReads[K]> };
}

/** A real ExeuntClient (so builders encode real calldata) whose reads are stubbed. */
export function fakeNetwork(deployment: Deployment): FakeNetwork {
  const sdk = new ExeuntClient(deployment, offlineClient);
  vi.spyOn(sdk, "token").mockImplementation(async (address: Address) => {
    const t = TOKENS.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!t) throw new Error(`unknown token ${address}`);
    return t;
  });
  vi.spyOn(sdk, "allowance").mockResolvedValue(0n);
  const reads = {
    vaultAsset: vi.fn<ChainReads["vaultAsset"]>().mockResolvedValue(deployment.underlying),
    vaultPreviewRedeem: vi.fn<ChainReads["vaultPreviewRedeem"]>().mockResolvedValue({ assets: 0n, receipts: [0n] }),
    morphoNonce: vi.fn<ChainReads["morphoNonce"]>().mockResolvedValue(0n),
    latestTimestamp: vi.fn<ChainReads["latestTimestamp"]>().mockResolvedValue(1_700_000_000n),
    call: vi.fn<ChainReads["call"]>().mockResolvedValue({ ok: true, returnData: "0x" }),
  };
  const handle: NetworkHandle = { info: NETWORKS[deployment.network], deployment, sdk, reads };
  return { handle, sdk, reads };
}

export function fakeChain(handles: Partial<Record<NetworkKey, NetworkHandle>>): ExeuntChain {
  return {
    list: () => NETWORK_KEYS.map((k) => ({ info: NETWORKS[k], deployment: handles[k]?.deployment ?? null })),
    get: (k) => {
      const h = handles[k];
      if (!h) throw new ToolError(`No Exeunt deployment found for ${k}. Use list_networks to see deployed networks.`);
      return h;
    },
  };
}

export function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 1n,
    seller: ADDR.seller,
    startedAt: 1_700_000_000,
    endsAt: 1_700_086_400,
    startBps: 100,
    stepBps: 50,
    capBps: 1_000,
    stepInterval: 3600,
    payMask: 0b1111,
    units: 10n * 10n ** 18n,
    discountBps: 200,
    remainingAssets: 10n * 10n ** 18n,
    open: true,
    acceptedPayTokens: [ADDR.USDG, ADDR.USDC, ADDR.WETH, ADDR.wstETH],
    ...overrides,
  };
}
