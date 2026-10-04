import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { alertIdParamsSchema, createAlertSchema, ownerQuerySchema } from "./alerts.schema.js";
import type { AlertService } from "./alerts.service.js";

function bodyOwner(body: unknown): unknown {
  return typeof body === "object" && body !== null ? (body as { owner?: unknown }).owner : undefined;
}

export function createAlertsController(service: AlertService) {
  return {
    createAlert: asyncHandler(async (req, res) => {
      const input = createAlertSchema.parse(req.body);
      const alert = service.createAlert(input);
      res.status(201).json({ id: alert.id });
    }),
    getAlerts: asyncHandler(async (req, res) => {
      const { owner } = ownerQuerySchema.parse(req.query);
      res.json({ alerts: service.getAlerts(owner) });
    }),
    deleteAlert: asyncHandler(async (req, res) => {
      const { id } = alertIdParamsSchema.parse(req.params);
      const { owner } = ownerQuerySchema.parse({ owner: req.query.owner ?? bodyOwner(req.body) });
      service.deleteAlert(id, owner);
      res.status(204).end();
    }),
    getEvents: asyncHandler(async (req, res) => {
      const { owner } = ownerQuerySchema.parse(req.query);
      res.json({ events: service.getEvents(owner) });
    }),
  };
}

export type AlertsController = ReturnType<typeof createAlertsController>;
