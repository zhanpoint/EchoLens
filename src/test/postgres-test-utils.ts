import { DataType, newDb } from "pg-mem";
import { afterEach, beforeEach } from "vitest";
import {
  closePostgresPoolForTest,
  ensurePostgresSchema,
  setPostgresPoolForTest,
} from "@/lib/storage/postgres";

export function setupPostgresTestDb(): void {
  beforeEach(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    db.public.registerFunction({
      name: "to_timestamp",
      args: [DataType.float],
      returns: DataType.timestamptz,
      implementation: (seconds: number | null) => seconds === null ? null : new Date(seconds * 1000),
    });
    db.public.registerFunction({
      name: "to_char",
      args: [DataType.timestamp, DataType.text],
      returns: DataType.text,
      implementation: (date: Date | null) => date === null ? null : formatShanghaiDate(date),
    });
    db.public.registerFunction({
      name: "timezone",
      args: [DataType.text, DataType.timestamptz],
      returns: DataType.timestamp,
      implementation: (_timeZone: string, date: Date | null) => date,
    });
    const { Pool } = db.adapters.createPg();
    setPostgresPoolForTest(new Pool());
    await ensurePostgresSchema();
  });

  afterEach(async () => {
    await closePostgresPoolForTest();
  });
}

function formatShanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}年${values.month}月${values.day}日 ${values.hour}:${values.minute}`;
}
