import { transaction, type Db } from "./database.js";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

/** Ordered schema history. Never edit an applied migration; append a new one. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    up: `
      CREATE TABLE capacity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network TEXT NOT NULL,
        at INTEGER NOT NULL,
        utilization_bps INTEGER NOT NULL,
        withdrawable TEXT NOT NULL,
        supplied TEXT NOT NULL,
        debtor_capacity TEXT NOT NULL,
        session_assets TEXT NOT NULL
      );
      CREATE INDEX idx_capacity_snapshots_network_at ON capacity_snapshots (network, at);

      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        network TEXT NOT NULL,
        threshold_bps INTEGER NOT NULL,
        webhook_url TEXT,
        last_utilization_bps INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_alerts_owner ON alerts (owner);
      CREATE INDEX idx_alerts_network ON alerts (network);

      CREATE TABLE alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        network TEXT NOT NULL,
        utilization_bps INTEGER NOT NULL,
        threshold_bps INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_alert_events_owner_at ON alert_events (owner, at);

      CREATE TABLE faucet_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network TEXT NOT NULL,
        address TEXT NOT NULL,
        kit TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_faucet_grants_lookup ON faucet_grants (network, address, kit, at);

      CREATE TABLE faucet_locks (
        network TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP TABLE faucet_locks;
      DROP TABLE faucet_grants;
      DROP TABLE alert_events;
      DROP TABLE alerts;
      DROP TABLE capacity_snapshots;
    `,
  },
];

function ensureTable(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
}

function appliedVersions(db: Db): Set<number> {
  const rows = db.prepare("SELECT version FROM schema_migrations").all();
  return new Set(rows.map((r) => Number(r.version)));
}

/** Applies pending migrations in order, each in its own transaction. */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): void {
  ensureTable(db);
  const applied = appliedVersions(db);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    transaction(db, (tx) => {
      tx.exec(m.up);
      tx.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Date.now());
    });
  }
}

/** Reverts applied migrations newer than `version`, newest first. */
export function rollback(db: Db, version: number, migrations: Migration[] = MIGRATIONS): void {
  ensureTable(db);
  const applied = appliedVersions(db);
  for (const m of [...migrations].sort((a, b) => b.version - a.version)) {
    if (m.version <= version || !applied.has(m.version)) continue;
    transaction(db, (tx) => {
      tx.exec(m.down);
      tx.prepare("DELETE FROM schema_migrations WHERE version = ?").run(m.version);
    });
  }
}
