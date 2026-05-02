import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./schema.js";

export function openDatabase(sqlitePath: string) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
