import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { migrate, rollback } from "./migrations.js";

function tables(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

describe("migrations", () => {
  it("apply once, are idempotent and reversible", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    migrate(db);
    expect(tables(db)).toEqual(["alert_events", "alerts", "capacity_snapshots", "faucet_grants", "faucet_locks", "schema_migrations"]);
    rollback(db, 0);
    expect(tables(db)).toEqual(["schema_migrations"]);
    migrate(db);
    expect(tables(db)).toContain("alerts");
    db.close();
  });
});
