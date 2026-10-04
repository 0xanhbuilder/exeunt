import express, { type Express } from "express";
import type { ExeuntChain } from "@exeunt/mcp";
import type { Db } from "./shared/db/database.js";
import { cors } from "./shared/middlewares/cors.js";
import { errorHandler, notFound } from "./shared/middlewares/errorHandler.js";
import { httpLogger, type Logger } from "./shared/middlewares/logger.js";
import { requestId } from "./shared/middlewares/requestId.js";
import { createAlertsModule, type WebhookSender } from "./modules/alerts/index.js";
import { createCapacityModule, type CapacityChainPort } from "./modules/capacity/index.js";
import { createFaucetModule, type FaucetServiceOptions, type ForkkitChainPort, type KitRunner } from "./modules/faucet/index.js";
import { createHealthModule } from "./modules/health/index.js";
import { createMcpModule } from "./modules/mcp/index.js";
import { createNetworksModule, type NetworksChainPort } from "./modules/networks/index.js";

export type AppChainPort = NetworksChainPort & CapacityChainPort & ForkkitChainPort;

export interface AppDeps {
  db: Db;
  logger: Logger;
  chain: AppChainPort;
  /** Chain layer of the MCP server, shared by every /mcp request. */
  mcpChain: ExeuntChain;
  corsOrigin: string;
  webhookSecret?: string;
  /* Test seams: replace adapters and clocks. */
  kits?: KitRunner;
  webhook?: WebhookSender;
  faucetOptions?: Partial<FaucetServiceOptions>;
  now?: () => number;
}

export function createApp(deps: AppDeps) {
  const app: Express = express();
  app.disable("x-powered-by");
  app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

  app.use(requestId());
  app.use(httpLogger(deps.logger));
  app.use(cors(deps.corsOrigin));
  app.use(express.json({ limit: "1mb" }));

  const { db, logger, chain, now } = deps;
  const capacity = createCapacityModule({ db, chain, logger, now });
  const alerts = createAlertsModule({ db, logger, webhookSecret: deps.webhookSecret, webhook: deps.webhook, now });
  const faucetOptions = now ? { now, ...deps.faucetOptions } : deps.faucetOptions;
  const faucet = createFaucetModule({ db, chain, logger, kits: deps.kits, options: faucetOptions });

  app.use(createHealthModule({ db }).router);
  app.use(createNetworksModule({ chain }).router);
  app.use(capacity.router);
  app.use(alerts.router);
  app.use(faucet.router);
  app.use(createMcpModule({ chain: deps.mcpChain }).router);

  app.use(notFound());
  app.use(errorHandler(logger));
  return { app, capacity, alerts };
}
