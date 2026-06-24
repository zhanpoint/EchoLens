import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type GlobalWithSqlite = typeof globalThis & {
  __echolensSqliteDb?: Database.Database;
};

const globalForSqlite = globalThis as GlobalWithSqlite;

export function getSqliteDb(): Database.Database {
  if (globalForSqlite.__echolensSqliteDb) {
    return globalForSqlite.__echolensSqliteDb;
  }

  const dbPath = readSqlitePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  globalForSqlite.__echolensSqliteDb = db;
  return db;
}

export function readSqlitePath(): string {
  return process.env.SQLITE_PATH || path.join(process.cwd(), "data", "echolens.sqlite");
}
