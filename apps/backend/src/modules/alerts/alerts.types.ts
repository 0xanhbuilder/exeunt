import type { NetworkKey } from "@exeunt/sdk";

export interface AlertDto {
  id: string;
  owner: string;
  network: NetworkKey;
  thresholdBps: number;
  webhookUrl: string | null;
  createdAt: number;
}

export interface AlertEventDto {
  id: number;
  alertId: string;
  network: NetworkKey;
  utilizationBps: number;
  thresholdBps: number;
  at: number;
}

/** JSON body POSTed to an alert's webhook. */
export interface WebhookPayload {
  type: "exeunt.capacity.alert";
  network: NetworkKey;
  utilizationBps: number;
  thresholdBps: number;
  withdrawable: string;
  supplied: string;
  at: number;
}

export interface WebhookSender {
  /** Resolves once delivered; throws an AppError after the last failed attempt. */
  deliver(url: string, payload: WebhookPayload): Promise<void>;
}

/** Most recent events returned by GET /api/alerts/events. */
export const EVENTS_LIMIT = 100;
