import { createTransactional, type Db } from "../../shared/db/database.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { ForkkitAdapter, type ForkkitChainPort } from "./adapters/forkkit.adapter.js";
import { createFaucetController } from "./faucet.controller.js";
import { FaucetRepository } from "./faucet.repository.js";
import { createFaucetRouter } from "./faucet.routes.js";
import { FaucetService, type FaucetServiceOptions } from "./faucet.service.js";
import type { KitRunner } from "./faucet.types.js";

/** Composition root of the faucet module. `kits` replaces the forkkit adapter (tests). */
export function createFaucetModule(deps: {
  db: Db;
  chain: ForkkitChainPort;
  logger: Logger;
  kits?: KitRunner;
  options?: Partial<FaucetServiceOptions>;
}) {
  const service = new FaucetService(
    new FaucetRepository(deps.db),
    deps.kits ?? new ForkkitAdapter(deps.chain),
    createTransactional(deps.db),
    deps.logger.child({ module: "faucet" }),
    deps.options,
  );
  return { service, router: createFaucetRouter(createFaucetController(service)) };
}

export type { ForkkitChainPort } from "./adapters/forkkit.adapter.js";
export type { FaucetServiceOptions } from "./faucet.service.js";
export type { KitRunner, KitType } from "./faucet.types.js";
