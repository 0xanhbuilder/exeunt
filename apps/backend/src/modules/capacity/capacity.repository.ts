import { num, str, type Db, type Row } from "../../shared/db/database.js";
import type { CapacitySnapshotRow } from "./capacity.model.js";

function toRow(r: Row): CapacitySnapshotRow {
  return {
    network: str(r, "network"),
    at: num(r, "at"),
    utilizationBps: num(r, "utilization_bps"),
    withdrawable: str(r, "withdrawable"),
    supplied: str(r, "supplied"),
    debtorCapacity: str(r, "debtor_capacity"),
    sessionAssets: str(r, "session_assets"),
  };
}

export class CapacityRepository {
  constructor(private readonly db: Db) {}

  insertMany(rows: CapacitySnapshotRow[], tx: Db = this.db): void {
    const stmt = tx.prepare(
      "INSERT INTO capacity_snapshots (network, at, utilization_bps, withdrawable, supplied, debtor_capacity, session_assets) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      stmt.run(r.network, r.at, r.utilizationBps, r.withdrawable, r.supplied, r.debtorCapacity, r.sessionAssets);
    }
  }

  /** Snapshots of `network` taken at or after `sinceMs`, oldest first. */
  listSince(network: string, sinceMs: number, tx: Db = this.db): CapacitySnapshotRow[] {
    return tx
      .prepare("SELECT * FROM capacity_snapshots WHERE network = ? AND at >= ? ORDER BY at ASC, id ASC")
      .all(network, sinceMs)
      .map(toRow);
  }

  deleteOlderThan(cutoffMs: number, tx: Db = this.db): number {
    return Number(tx.prepare("DELETE FROM capacity_snapshots WHERE at < ?").run(cutoffMs).changes);
  }
}
