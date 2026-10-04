import { pingDatabase, type Db } from "../../shared/db/database.js";
import { createHealthController } from "./health.controller.js";
import { createHealthRouter } from "./health.routes.js";
import { HealthService } from "./health.service.js";

export function createHealthModule(deps: { db: Db }) {
  const service = new HealthService(() => pingDatabase(deps.db));
  return { service, router: createHealthRouter(createHealthController(service)) };
}
