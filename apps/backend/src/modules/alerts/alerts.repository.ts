import { num, numOrNull, str, strOrNull, type Db, type Row } from "../../shared/db/database.js";
import type { AlertEventRow, AlertRow, NewAlertEvent } from "./alerts.model.js";

function toAlert(r: Row): AlertRow {
  return {
    id: str(r, "id"),
    owner: str(r, "owner"),
    network: str(r, "network"),
    thresholdBps: num(r, "threshold_bps"),
    webhookUrl: strOrNull(r, "webhook_url"),
    lastUtilizationBps: numOrNull(r, "last_utilization_bps"),
    createdAt: num(r, "created_at"),
  };
}

function toEvent(r: Row): AlertEventRow {
  return {
    id: num(r, "id"),
    alertId: str(r, "alert_id"),
    owner: str(r, "owner"),
    network: str(r, "network"),
    utilizationBps: num(r, "utilization_bps"),
    thresholdBps: num(r, "threshold_bps"),
    at: num(r, "at"),
  };
}

export class AlertRepository {
  constructor(private readonly db: Db) {}

  insert(a: AlertRow, tx: Db = this.db): void {
    tx.prepare(
      "INSERT INTO alerts (id, owner, network, threshold_bps, webhook_url, last_utilization_bps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(a.id, a.owner, a.network, a.thresholdBps, a.webhookUrl, a.lastUtilizationBps, a.createdAt);
  }

  findById(id: string, tx: Db = this.db): AlertRow | null {
    const r = tx.prepare("SELECT * FROM alerts WHERE id = ?").get(id);
    return r ? toAlert(r) : null;
  }

  listByOwner(owner: string, tx: Db = this.db): AlertRow[] {
    return tx.prepare("SELECT * FROM alerts WHERE owner = ? ORDER BY created_at DESC, id").all(owner).map(toAlert);
  }

  listByNetwork(network: string, tx: Db = this.db): AlertRow[] {
    return tx.prepare("SELECT * FROM alerts WHERE network = ?").all(network).map(toAlert);
  }

  delete(id: string, tx: Db = this.db): void {
    tx.prepare("DELETE FROM alerts WHERE id = ?").run(id);
  }

  /** Records the utilization every alert of `network` was just evaluated against. */
  setLastUtilization(network: string, utilizationBps: number, tx: Db = this.db): void {
    tx.prepare("UPDATE alerts SET last_utilization_bps = ? WHERE network = ?").run(utilizationBps, network);
  }

  insertEvents(events: NewAlertEvent[], tx: Db = this.db): AlertEventRow[] {
    const stmt = tx.prepare(
      "INSERT INTO alert_events (alert_id, owner, network, utilization_bps, threshold_bps, at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    return events.map((e) => {
      const res = stmt.run(e.alertId, e.owner, e.network, e.utilizationBps, e.thresholdBps, e.at);
      return { ...e, id: Number(res.lastInsertRowid) };
    });
  }

  /** Newest events first. */
  listEventsByOwner(owner: string, limit: number, tx: Db = this.db): AlertEventRow[] {
    return tx
      .prepare("SELECT * FROM alert_events WHERE owner = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(owner, limit)
      .map(toEvent);
  }
}
