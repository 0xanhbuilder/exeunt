import { Router } from "express";
import type { AlertsController } from "./alerts.controller.js";

export function createAlertsRouter(controller: AlertsController): Router {
  const router = Router();
  router.post("/api/alerts", controller.createAlert);
  router.get("/api/alerts", controller.getAlerts);
  router.get("/api/alerts/events", controller.getEvents);
  router.delete("/api/alerts/:id", controller.deleteAlert);
  return router;
}
