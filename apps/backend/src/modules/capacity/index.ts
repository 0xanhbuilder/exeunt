import { createTransactional, type Db } from "../../shared/db/database.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { createCapacityController } from "./capacity.controller.js";
import { CapacityPoller } from "./capacity.poller.js";
import { CapacityRepository } from "./capacity.repository.js";
import { createCapacityRouter } from "./capacity.routes.js";
import { CapacityService, type CapacityChainPort } from "./capacity.service.js";
import type { SnapshotListener } from "./capacity.types.js";

/** Composition root of the capacity module. */
export function createCapacityModule(deps: { db: Db; chain: CapacityChainPort; logger: Logger; now?: () => number }) {
  const logger = deps.logger.child({ module: "capacity" });
  const service = new CapacityService(new CapacityRepository(deps.db), deps.chain, createTransactional(deps.db), logger, deps.now);
  return {
    service,
    router: createCapacityRouter(createCapacityController(service)),
    createPoller: (intervalMs: number, listeners: SnapshotListener[]) =>
      new CapacityPoller(() => service.snapshotAll(), listeners, intervalMs, logger),
  };
}

export type { CapacityPoller } from "./capacity.poller.js";
export type { CapacityChainPort } from "./capacity.service.js";
export type { CapacitySnapshot, SnapshotListener } from "./capacity.types.js";
