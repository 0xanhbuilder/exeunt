import { createTransactional, type Db } from "../../shared/db/database.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { WebhookAdapter } from "./adapters/webhook.adapter.js";
import { createAlertsController } from "./alerts.controller.js";
import { AlertRepository } from "./alerts.repository.js";
import { createAlertsRouter } from "./alerts.routes.js";
import { AlertService } from "./alerts.service.js";
import type { WebhookSender } from "./alerts.types.js";

/** Composition root of the alerts module. `webhook` replaces the HTTP adapter (tests). */
export function createAlertsModule(deps: {
  db: Db;
  logger: Logger;
  webhookSecret?: string;
  webhook?: WebhookSender;
  now?: () => number;
}) {
  const webhook = deps.webhook ?? new WebhookAdapter(deps.webhookSecret ? { secret: deps.webhookSecret } : {});
  const service = new AlertService(
    new AlertRepository(deps.db),
    webhook,
    createTransactional(deps.db),
    deps.logger.child({ module: "alerts" }),
    deps.now,
  );
  return { service, router: createAlertsRouter(createAlertsController(service)) };
}

export type { AlertService } from "./alerts.service.js";
export type { WebhookPayload, WebhookSender } from "./alerts.types.js";
