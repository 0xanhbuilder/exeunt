import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export type Db = DatabaseSync;
export type Row = Record<string, SQLOutputValue>;

/** Opens (creating the folder if needed) a SQLite database. ":memory:" gives a throwaway one. */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

/** Runs `fn` in one write transaction; the callback is synchronous, as node:sqlite is. */
export function transaction<T>(db: Db, fn: (tx: Db) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(db);
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Transaction runner handed to services, so they own the boundary without holding the connection. */
export type Transactional = <T>(fn: (tx: Db) => T) => T;

export function createTransactional(db: Db): Transactional {
  return (fn) => transaction(db, fn);
}

export function pingDatabase(db: Db): void {
  db.prepare("SELECT 1 AS ok").get();
}

/* Column readers: narrow SQLite values without casts. */

export function str(row: Row, col: string): string {
  const v = row[col];
  if (typeof v !== "string") throw new Error(`column ${col} is not text`);
  return v;
}

export function strOrNull(row: Row, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  return str(row, col);
}

export function num(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`column ${col} is not a number`);
}

export function numOrNull(row: Row, col: string): number | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  return num(row, col);
}
