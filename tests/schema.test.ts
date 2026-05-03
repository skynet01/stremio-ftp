import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function insertProfile(db: Database.Database) {
  return db
    .prepare(
      `
        insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at)
        values (?, 'verifier', ?, '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z')
      `,
    )
    .run(`browser-${Math.random()}`, `token-${Math.random()}`).lastInsertRowid as number;
}

function insertMediaFile(db: Database.Database, profileId: number, values: Partial<Record<string, unknown>> = {}) {
  return db
    .prepare(
      `
        insert into media_files (
          profile_id,
          ftp_path,
          filename,
          normalized_filename,
          extension,
          size_bytes,
          media_kind,
          parsed_title,
          parsed_year,
          season,
          episode,
          confidence,
          last_seen_at
        )
        values (
          @profileId,
          @ftpPath,
          'Example.mkv',
          'example.mkv',
          'mkv',
          @sizeBytes,
          @mediaKind,
          @parsedTitle,
          @parsedYear,
          @season,
          @episode,
          @confidence,
          '2026-05-02T00:00:00.000Z'
        )
      `,
    )
    .run({
      profileId,
      ftpPath: `/media/${Math.random()}.mkv`,
      sizeBytes: 1024,
      mediaKind: "movie",
      parsedTitle: "Example",
      parsedYear: 2020,
      season: null,
      episode: null,
      confidence: 90,
      ...values,
    });
}

describe("schema", () => {
  it("creates required tables", () => {
    const db = createDb();
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(["media_files", "profile_install_tokens", "profiles", "scan_jobs"]);
  });

  it("creates scan schedule columns and scan job persistence", () => {
    const db = createDb();
    const profileColumns = db.prepare("pragma table_info(profiles)").all() as { name: string }[];
    const scanColumns = db.prepare("pragma table_info(scan_jobs)").all() as { name: string }[];

    expect(profileColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["scan_interval_minutes", "next_scheduled_scan_at", "stream_delivery_mode"]),
    );
    expect(scanColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "profile_id",
        "status",
        "trigger",
        "progress_percent",
        "entries_seen",
        "files_seen",
        "directories_seen",
        "current_path",
        "estimated_seconds_remaining",
      ]),
    );
  });

  it("creates media lookup indexes", () => {
    const db = createDb();
    const indexes = db
      .prepare("select name from sqlite_master where type = 'index' and name in ('idx_media_episode', 'idx_media_movie') order by name")
      .all() as { name: string }[];

    expect(indexes.map((row) => row.name)).toEqual(["idx_media_episode", "idx_media_movie"]);
  });

  it("enforces unique profile browser ids", () => {
    const db = createDb();
    db.prepare(
      `
        insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at)
        values ('browser-1', 'verifier', 'token-1', '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z')
      `,
    ).run();

    expect(() =>
      db
        .prepare(
          `
            insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at)
            values ('browser-1', 'verifier', 'token-2', '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z')
          `,
        )
        .run(),
    ).toThrow();
  });

  it("cascades profile deletes to media files", () => {
    const db = createDb();
    const profileId = insertProfile(db);
    insertMediaFile(db, profileId);

    db.prepare("delete from profiles where id = ?").run(profileId);

    const mediaCount = db.prepare("select count(*) as count from media_files").get() as { count: number };
    expect(mediaCount.count).toBe(0);
  });

  it("cascades profile deletes to issued install tokens", () => {
    const db = createDb();
    const profileId = insertProfile(db);
    db.prepare(
      `
        insert into profile_install_tokens (profile_id, token_hash, created_at)
        values (?, 'issued-token', '2026-05-02T00:00:00.000Z')
      `,
    ).run(profileId);

    db.prepare("delete from profiles where id = ?").run(profileId);

    const tokenCount = db.prepare("select count(*) as count from profile_install_tokens").get() as { count: number };
    expect(tokenCount.count).toBe(0);
  });

  it("rejects invalid media domain values", () => {
    const db = createDb();
    const profileId = insertProfile(db);

    expect(() => insertMediaFile(db, profileId, { mediaKind: "clip" })).toThrow();
    expect(() => insertMediaFile(db, profileId, { sizeBytes: -1 })).toThrow();
    expect(() => insertMediaFile(db, profileId, { parsedYear: 1887 })).toThrow();
    expect(() => insertMediaFile(db, profileId, { parsedYear: 2201 })).toThrow();
    expect(() => insertMediaFile(db, profileId, { season: 0 })).toThrow();
    expect(() => insertMediaFile(db, profileId, { episode: 0 })).toThrow();
    expect(() => insertMediaFile(db, profileId, { confidence: -1 })).toThrow();
    expect(() => insertMediaFile(db, profileId, { confidence: 101 })).toThrow();
  });
});
