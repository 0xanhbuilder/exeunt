import { numOrNull, type Db } from "../../shared/db/database.js";
import type { FaucetGrantRow } from "./faucet.model.js";

export class FaucetRepository {
  constructor(private readonly db: Db) {}

  /** Time of the latest grant of `kit` to `address` on `network`, or null. */
  lastGrantAt(network: string, address: string, kit: string, tx: Db = this.db): number | null {
    const r = tx
      .prepare("SELECT MAX(at) AS last FROM faucet_grants WHERE network = ? AND address = ? AND kit = ?")
      .get(network, address, kit);
    return r ? numOrNull(r, "last") : null;
  }

  insertGrant(grant: Omit<FaucetGrantRow, "id">, tx: Db = this.db): number {
    const res = tx
      .prepare("INSERT INTO faucet_grants (network, address, kit, at) VALUES (?, ?, ?, ?)")
      .run(grant.network, grant.address, grant.kit, grant.at);
    return Number(res.lastInsertRowid);
  }

  deleteGrant(id: number, tx: Db = this.db): void {
    tx.prepare("DELETE FROM faucet_grants WHERE id = ?").run(id);
  }

  /**
   * Takes the network's row in `faucet_locks` (kit runs impersonate shared helper accounts, so they must not
   * interleave on one fork) when it is free or expired; returns whether `holder` now owns it.
   */
  tryAcquireLock(network: string, holder: string, now: number, ttlMs: number, tx: Db = this.db): boolean {
    const res = tx
      .prepare(
        `INSERT INTO faucet_locks (network, holder, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (network) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE faucet_locks.expires_at < ?`,
      )
      .run(network, holder, now + ttlMs, now);
    return Number(res.changes) === 1;
  }

  releaseLock(network: string, holder: string, tx: Db = this.db): void {
    tx.prepare("DELETE FROM faucet_locks WHERE network = ? AND holder = ?").run(network, holder);
  }
}
