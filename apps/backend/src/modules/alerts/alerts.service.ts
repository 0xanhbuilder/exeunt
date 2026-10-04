import { randomUUID } from "node:crypto";
import type { Transactional } from "../../shared/db/database.js";
import { AppError, ErrorCode } from "../../shared/errors/AppError.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { toNetworkKey } from "../../shared/utils/validation.js";
import type { CapacitySnapshot } from "../capacity/index.js";
import type { AlertEventRow, AlertRow, NewAlertEvent } from "./alerts.model.js";
import type { AlertRepository } from "./alerts.repository.js";
import type { CreateAlertInput } from "./alerts.schema.js";
import { EVENTS_LIMIT, type AlertDto, type AlertEventDto, type WebhookPayload, type WebhookSender } from "./alerts.types.js";

export type AlertRepositoryPort = Pick<
  AlertRepository,
  "insert" | "findById" | "listByOwner" | "listByNetwork" | "delete" | "setLastUtilization" | "insertEvents" | "listEventsByOwner"
>;

/**
 * Edge trigger: fire when utilization is at/above the threshold now and was below it at the alert's previous
 * evaluation. An alert never evaluated before fires on its first evaluation if already at/above.
 */
export function shouldFire(previousBps: number | null, currentBps: number, thresholdBps: number): boolean {
  return currentBps >= thresholdBps && (previousBps === null || previousBps < thresholdBps);
}

function toAlertDto(a: AlertRow): AlertDto {
  return {
    id: a.id,
    owner: a.owner,
    network: toNetworkKey(a.network),
    thresholdBps: a.thresholdBps,
    webhookUrl: a.webhookUrl,
    createdAt: a.createdAt,
  };
}

function toEventDto(e: AlertEventRow): AlertEventDto {
  return {
    id: e.id,
    alertId: e.alertId,
    network: toNetworkKey(e.network),
    utilizationBps: e.utilizationBps,
    thresholdBps: e.thresholdBps,
    at: e.at,
  };
}

export class AlertService {
  constructor(
    private readonly repo: AlertRepositoryPort,
    private readonly webhook: WebhookSender,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  createAlert(input: CreateAlertInput): AlertDto {
    const row: AlertRow = {
      id: this.newId(),
      owner: input.owner,
      network: input.network,
      thresholdBps: input.thresholdBps,
      webhookUrl: input.webhookUrl ?? null,
      lastUtilizationBps: null,
      createdAt: this.now(),
    };
    this.repo.insert(row);
    this.logger.info({ alertId: row.id, network: row.network, thresholdBps: row.thresholdBps }, "alert created");
    return toAlertDto(row);
  }

  getAlerts(owner: string): AlertDto[] {
    return this.repo.listByOwner(owner).map(toAlertDto);
  }

  deleteAlert(id: string, owner: string): void {
    const alert = this.repo.findById(id);
    if (!alert) throw new AppError(404, ErrorCode.ALERT_NOT_FOUND, `Alert ${id} not found`);
    if (alert.owner !== owner) throw new AppError(403, ErrorCode.FORBIDDEN, "Alert belongs to another owner");
    this.repo.delete(id);
    this.logger.info({ alertId: id }, "alert deleted");
  }

  getEvents(owner: string): AlertEventDto[] {
    return this.repo.listEventsByOwner(owner, EVENTS_LIMIT).map(toEventDto);
  }

  /** Evaluates every alert against a poll round, records fired events and delivers their webhooks. */
  async evaluateSnapshots(snapshots: CapacitySnapshot[]): Promise<void> {
    const deliveries: { url: string; payload: WebhookPayload; alertId: string }[] = [];
    for (const snap of snapshots) {
      const fired = this.inTransaction((tx) => {
        const alerts = this.repo.listByNetwork(snap.network, tx);
        const firing = alerts.filter((a) => shouldFire(a.lastUtilizationBps, snap.utilizationBps, a.thresholdBps));
        const events: NewAlertEvent[] = firing.map((a) => ({
          alertId: a.id,
          owner: a.owner,
          network: a.network,
          utilizationBps: snap.utilizationBps,
          thresholdBps: a.thresholdBps,
          at: snap.at,
        }));
        this.repo.insertEvents(events, tx);
        this.repo.setLastUtilization(snap.network, snap.utilizationBps, tx);
        return firing;
      });
      for (const a of fired) {
        this.logger.info({ alertId: a.id, network: snap.network, utilizationBps: snap.utilizationBps }, "alert fired");
        if (!a.webhookUrl) continue;
        deliveries.push({
          url: a.webhookUrl,
          alertId: a.id,
          payload: {
            type: "exeunt.capacity.alert",
            network: snap.network,
            utilizationBps: snap.utilizationBps,
            thresholdBps: a.thresholdBps,
            withdrawable: snap.withdrawable.toString(),
            supplied: snap.supplied.toString(),
            at: snap.at,
          },
        });
      }
    }
    const results = await Promise.allSettled(deliveries.map((d) => this.webhook.deliver(d.url, d.payload)));
    results.forEach((res, i) => {
      const d = deliveries[i];
      if (!d) return;
      if (res.status === "fulfilled") this.logger.info({ alertId: d.alertId }, "webhook delivered");
      else this.logger.warn({ alertId: d.alertId, err: res.reason }, "webhook delivery failed");
    });
  }
}
