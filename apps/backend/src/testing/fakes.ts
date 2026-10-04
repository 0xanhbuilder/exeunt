import { pino } from "pino";
import type { PublicClient } from "viem";
import type { Deployment, NetworkKey } from "@exeunt/sdk";
import type { ExeuntChain } from "@exeunt/mcp";
import type { AppChainPort } from "../app.js";
import { openDatabase, type Db, type Transactional } from "../shared/db/database.js";
import { migrate } from "../shared/db/migrations.js";
import { AppError, ErrorCode } from "../shared/errors/AppError.js";
import type { CapacityReading } from "../shared/integrations/chain/chain.gateway.js";

export const silentLogger = pino({ level: "silent" });

/** Runs the callback directly; for unit tests whose repositories are mocks. */
export const directTransaction: Transactional = (fn) => fn(undefined as unknown as Db);

export function testDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export const OWNER = "0x00000000000000000000000000000000000000aa";
export const OTHER_OWNER = "0x00000000000000000000000000000000000000bb";

export const KELP_DEPLOYMENT: Deployment = {
  network: "kelp-replay",
  chainId: 42161,
  deployBlock: 1,
  venue: "aave",
  market: "0x0000000000000000000000000000000000001001",
  receipt: "0x0000000000000000000000000000000000001002",
  underlying: "0x0000000000000000000000000000000000001003",
  priceRouter: "0x0000000000000000000000000000000000001004",
  exeuntVault: "0x0000000000000000000000000000000000001005",
  payTokens: ["0x0000000000000000000000000000000000001006"],
  aavePool: "0x0000000000000000000000000000000000001007",
  debtToken: "0x0000000000000000000000000000000000001008",
};

export function reading(utilizationBps: number, overrides: Partial<CapacityReading> = {}): CapacityReading {
  return {
    withdrawable: 10n ** 17n,
    supplied: 148_193_896_256_465_612_948_440n,
    utilizationBps,
    debtorCapacity: 148_195_452_534_232_807_657_743n,
    sessionAssets: 0n,
    bidCapacity: [],
    underlying: { address: KELP_DEPLOYMENT.underlying, symbol: "WETH", decimals: 18 },
    ...overrides,
  };
}

/** Chain stub with one deployed network (kelp-replay) and a settable utilization. */
export function fakeChain(state: { utilizationBps: number } = { utilizationBps: 9_999 }): AppChainPort {
  const deployment = (key: NetworkKey) => (key === "kelp-replay" ? KELP_DEPLOYMENT : null);
  return {
    deployment,
    requireDeployment: (key) => {
      const d = deployment(key);
      if (!d) throw new AppError(404, ErrorCode.DEPLOYMENT_NOT_FOUND, `No Exeunt deployment for ${key}`);
      return d;
    },
    deployedNetworks: () => ["kelp-replay"],
    isReachable: async (key) => key === "kelp-replay",
    readCapacity: async (key, levels) => {
      if (key !== "kelp-replay") throw new AppError(404, ErrorCode.DEPLOYMENT_NOT_FOUND, `No Exeunt deployment for ${key}`);
      return reading(state.utilizationBps, {
        bidCapacity: levels.map((discountBps) => ({ discountBps, assets: BigInt(discountBps) * 10n ** 18n })),
      });
    },
    publicClient: (): PublicClient => {
      throw new Error("network access is disabled in tests");
    },
  };
}

/** MCP chain layer with no deployments: enough to exercise the /mcp transport. */
export const emptyMcpChain: ExeuntChain = {
  list: () => [],
  get: (key) => {
    throw new Error(`No Exeunt deployment found for ${key}`);
  },
};
