import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSqliteDb, readSqlitePath } from "@/lib/storage/sqlite";

afterEach(() => {
  delete process.env.SQLITE_PATH;
  delete (globalThis as { __echolensSqliteDb?: unknown }).__echolensSqliteDb;
});

describe("sqlite storage", () => {
  it("creates nested database directories before opening sqlite", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "echolens-sqlite-test-"));
    process.env.SQLITE_PATH = path.join(tempDir, "nested", "echolens.sqlite");

    try {
      const db = getSqliteDb();
      db.exec("CREATE TABLE smoke (id TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO smoke (id) VALUES (?)").run("ok");

      expect(readSqlitePath()).toBe(process.env.SQLITE_PATH);
      expect(db.prepare("SELECT id FROM smoke").get()).toEqual({ id: "ok" });
      db.close();
      delete (globalThis as { __echolensSqliteDb?: unknown }).__echolensSqliteDb;
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
