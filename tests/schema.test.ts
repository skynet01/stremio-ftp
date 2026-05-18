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
    expect(tables.map((row) => row.name)).toEqual([
      "catalog_enrichment",
      "media_files",
      "profile_ftp_servers",
      "profile_install_tokens",
      "profiles",
      "scan_directory_snapshots",
      "scan_jobs",
      "shared_directory_snapshots",
      "shared_index_groups",
      "shared_media_files",
    ]);
  });

  it("creates scan schedule columns and scan job persistence", () => {
    const db = createDb();
    const profileColumns = db.prepare("pragma table_info(profiles)").all() as { name: string }[];
    const serverColumns = db.prepare("pragma table_info(profile_ftp_servers)").all() as { name: string }[];
    const scanColumns = db.prepare("pragma table_info(scan_jobs)").all() as { name: string }[];
    const sharedGroupColumns = db.prepare("pragma table_info(shared_index_groups)").all() as { name: string }[];
    const enrichmentColumns = db.prepare("pragma table_info(catalog_enrichment)").all() as { name: string }[];

    expect(profileColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "scan_interval_minutes",
        "next_scheduled_scan_at",
        "stream_delivery_mode",
        "catalog_content_uncategorized",
        "stream_name_template",
        "stream_description_template",
        "admin_enabled",
        "last_country_code",
      ]),
    );
    expect(scanColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "target_kind",
        "shared_index_group_id",
        "profile_id",
        "ftp_server_id",
        "status",
        "trigger",
        "progress_percent",
        "entries_seen",
        "files_seen",
        "scan_mode",
        "media_items_added",
        "directories_seen",
        "current_path",
        "estimated_seconds_remaining",
      ]),
    );
    expect(serverColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["shared_index_group_id", "shared_index_key_hash"]));
    expect(sharedGroupColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "key_hint",
        "shared_index_key_hash",
        "master_profile_ftp_server_id",
        "root_paths_json",
        "catalog_content_json",
        "auto_link_imports",
      ]),
    );
    expect(enrichmentColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["algorithm_version"]));
  });

  it("stores shared index groups, shared media, and scan target rows", () => {
    const db = createDb();
    const profileId = insertProfile(db);
    db.prepare("insert into profile_ftp_servers (profile_id, name, created_at, updated_at) values (?, 'Server 1', 'now', 'now')").run(profileId);
    const serverId = db.prepare("select id from profile_ftp_servers where profile_id = ?").get(profileId) as { id: number };
    const groupId = db
      .prepare(
        `
          insert into shared_index_groups (
            key_hint, name, shared_index_key_hash, host, port, tls_mode, allow_invalid_certificate,
            root_paths_json, library_layout, catalog_content_json, enabled, auto_link_imports,
            master_profile_ftp_server_id, created_at, updated_at
          ) values (
            'sputnik-main', 'Sputnik Main', 'hash-1', 'sputnik.whatbox.ca', 21, 'explicit', 0,
            '["/media"]', 'auto', '{"movies":true,"series":true,"anime":false,"uncategorized":true}', 1, 1,
            ?, '2026-05-17T00:00:00.000Z', '2026-05-17T00:00:00.000Z'
          )
        `,
      )
      .run(serverId.id).lastInsertRowid as number;

    db.prepare("update profile_ftp_servers set shared_index_group_id = ?, shared_index_key_hash = 'hash-1' where id = ?").run(groupId, serverId.id);
    db.prepare(
      `
        insert into shared_media_files (
          shared_index_group_id, ftp_path, filename, normalized_filename, extension, size_bytes,
          media_kind, parsed_title, parsed_year, confidence, last_seen_at
        ) values (?, '/media/Movie.mkv', 'Movie.mkv', 'movie.mkv', 'mkv', 1024, 'movie', 'movie', 2020, 90, '2026-05-17T00:00:00.000Z')
      `,
    ).run(groupId);
    db.prepare(
      `
        insert into scan_jobs (target_kind, shared_index_group_id, profile_id, status, trigger, progress_percent, message, queued_at)
        values ('shared_group', ?, ?, 'queued', 'manual', 0, 'Shared scan queued.', '2026-05-17T00:00:00.000Z')
      `,
    ).run(groupId, profileId);

    const linked = db.prepare("select shared_index_group_id from profile_ftp_servers where id = ?").get(serverId.id) as { shared_index_group_id: number };
    const sharedCount = db.prepare("select count(*) as count from shared_media_files where shared_index_group_id = ?").get(groupId) as { count: number };
    expect(linked.shared_index_group_id).toBe(groupId);
    expect(sharedCount.count).toBe(1);
  });

  it("clears a shared index master when the master server is deleted", () => {
    const db = createDb();
    const profileId = insertProfile(db);
    db.prepare("insert into profile_ftp_servers (profile_id, name, created_at, updated_at) values (?, 'Server 2', 'now', 'now')").run(profileId);
    const master = db.prepare("select id from profile_ftp_servers where profile_id = ? order by id desc limit 1").get(profileId) as { id: number };
    const groupId = db
      .prepare(
        `
          insert into shared_index_groups (
            key_hint, name, shared_index_key_hash, host, port, tls_mode, allow_invalid_certificate,
            root_paths_json, library_layout, catalog_content_json, enabled, auto_link_imports,
            master_profile_ftp_server_id, created_at, updated_at
          ) values (
            'main', 'Main', 'hash', 'ftp.example.test', 21, 'explicit', 0,
            '["/"]', 'auto', '{}', 1, 1, ?, 'now', 'now'
          )
        `,
      )
      .run(master.id).lastInsertRowid as number;

    db.prepare("delete from profile_ftp_servers where id = ?").run(master.id);

    const group = db.prepare("select master_profile_ftp_server_id from shared_index_groups where id = ?").get(groupId) as {
      master_profile_ftp_server_id: number | null;
    };
    expect(group.master_profile_ftp_server_id).toBeNull();
  });

  it("can run shared schema migration twice", () => {
    const db = createDb();
    expect(() => migrate(db)).not.toThrow();
  });

  it("migrates legacy scan jobs before creating shared target indexes", () => {
    const db = new Database(":memory:");
    db.exec(`
      create table scan_jobs (
        id integer primary key autoincrement,
        profile_id integer not null,
        status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
        trigger text not null check (trigger in ('manual', 'scheduled')),
        progress_percent integer not null default 0,
        entries_seen integer not null default 0,
        files_seen integer not null default 0,
        directories_seen integer not null default 0,
        current_path text,
        estimated_seconds_remaining integer,
        message text,
        error text,
        queued_at text not null,
        started_at text,
        finished_at text
      );
      insert into scan_jobs (profile_id, status, trigger, progress_percent, queued_at)
      values (1, 'queued', 'manual', 0, '2026-05-17T00:00:00.000Z');
    `);

    expect(() => migrate(db)).not.toThrow();
    const columns = db.prepare("pragma table_info(scan_jobs)").all() as { name: string }[];
    const indexes = db.prepare("select name from sqlite_master where type = 'index' and name = 'idx_scan_jobs_target_status'").all() as {
      name: string;
    }[];
    const row = db.prepare("select target_kind, shared_index_group_id from scan_jobs where id = 1").get() as {
      target_kind: string;
      shared_index_group_id: number | null;
    };

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["target_kind", "shared_index_group_id", "ftp_server_id"]));
    expect(indexes).toEqual([{ name: "idx_scan_jobs_target_status" }]);
    expect(row).toEqual({ target_kind: "profile_server", shared_index_group_id: null });
  });

  it("allows halted scan jobs to be stored as cancelled", () => {
    const db = createDb();
    const profileId = insertProfile(db);

    expect(() =>
      db
        .prepare(
          `
            insert into scan_jobs (profile_id, status, trigger, progress_percent, message, queued_at, finished_at)
            values (?, 'cancelled', 'manual', 0, 'Scan halted.', '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:01.000Z')
          `,
        )
        .run(profileId),
    ).not.toThrow();
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
