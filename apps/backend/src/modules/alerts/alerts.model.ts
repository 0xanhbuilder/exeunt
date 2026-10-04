/** Row of `alerts`. `lastUtilizationBps` is the utilization seen at this alert's previous evaluation. */
export interface AlertRow {
  id: string;
  owner: string;
  network: string;
  thresholdBps: number;
  webhookUrl: string | null;
  lastUtilizationBps: number | null;
  createdAt: number;
}

/** Row of `alert_events` (an alert that fired). */
export interface AlertEventRow {
  id: number;
  alertId: string;
  owner: string;
  network: string;
  utilizationBps: number;
  thresholdBps: number;
  at: number;
}

export type NewAlertEvent = Omit<AlertEventRow, "id">;
