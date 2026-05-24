import type Database from "better-sqlite3";

const SCAN_JOBS_COLUMNS = `
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      ftp_server_id integer references profile_ftp_servers(id) on delete cascade,
      status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
      trigger text not null check (trigger in ('manual', 'scheduled')),
      progress_percent integer not null default 0 check (progress_percent between 0 and 100),
      scan_mode text check (scan_mode in ('full', 'incremental', 'force')),
      entries_seen integer not null default 0 check (entries_seen >= 0),
      files_seen integer not null default 0 check (files_seen >= 0),
      media_items_added integer not null default 0 check (media_items_added >= 0),
      directories_seen integer not null default 0 check (directories_seen >= 0),
      current_path text,
      estimated_seconds_remaining integer check (estimated_seconds_remaining is null or estimated_seconds_remaining >= 0),
      message text,
      error text,
      queued_at text not null,
      started_at text,
      finished_at text
`;

const MEDIA_FILES_COLUMNS = `
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      ftp_server_id integer references profile_ftp_servers(id) on delete cascade,
      ftp_path text not null,
      filename text not null,
      normalized_filename text not null,
      extension text not null,
      size_bytes integer check (size_bytes is null or size_bytes >= 0),
      modified_at text,
      media_kind text not null check (media_kind in ('movie', 'series')),
      catalog_kind text not null default 'movie' check (catalog_kind in ('movie', 'series', 'anime')),
      parsed_title text,
      parsed_year integer check (parsed_year is null or parsed_year between 1888 and 2200),
      season integer check (season is null or season > 0),
      episode integer check (episode is null or episode > 0),
      imdb_id text,
      quality text,
      confidence integer not null check (confidence between 0 and 100),
      last_seen_at text not null,
      unique(profile_id, ftp_server_id, ftp_path)
`;

const SCAN_DIRECTORY_SNAPSHOTS_COLUMNS = `
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      ftp_server_id integer references profile_ftp_servers(id) on delete cascade,
      dir_path text not null,
      entry_count integer not null check (entry_count >= 0),
      fingerprint text not null,
      modified_at text,
      last_seen_at text not null,
      unique(profile_id, ftp_server_id, dir_path)
`;

const CATALOG_ENRICHMENT_COLUMNS = `
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      ftp_server_id integer not null references profile_ftp_servers(id) on delete cascade,
      item_key text not null,
      media_kind text not null check (media_kind in ('movie', 'series')),
      catalog_kind text not null check (catalog_kind in ('movie', 'series', 'anime')),
      parsed_title text not null,
      parsed_year integer check (parsed_year is null or parsed_year between 1888 and 2200),
      source_imdb_id text,
      status text not null check (status in ('pending', 'matched', 'unmatched', 'retry')),
      meta_id text,
      meta_type text check (meta_type is null or meta_type in ('movie', 'series')),
      meta_name text,
      poster text,
      background text,
      description text,
      release_info text,
      genres text,
      algorithm_version integer not null default 1 check (algorithm_version >= 1),
      attempts integer not null default 0 check (attempts >= 0),
      error text,
      next_attempt_at text,
      last_seen_at text not null,
      created_at text not null,
      updated_at text not null,
      unique(profile_id, ftp_server_id, item_key)
`;

export function migrate(db: Database.Database) {
  db.exec(`
    create table if not exists profiles (
      id integer primary key autoincrement,
      browser_uid text not null unique,
      passphrase_verifier text not null,
      encrypted_ftp_config text,
      addon_name text,
      addon_logo_url text,
      addon_description text,
      catalog_enabled integer not null default 0 check (catalog_enabled in (0, 1)),
      catalog_tmdb_api_key text,
      catalog_content_movies integer not null default 1 check (catalog_content_movies in (0, 1)),
      catalog_content_series integer not null default 1 check (catalog_content_series in (0, 1)),
      catalog_content_anime integer not null default 0 check (catalog_content_anime in (0, 1)),
      catalog_content_uncategorized integer not null default 1 check (catalog_content_uncategorized in (0, 1)),
      combine_uncategorized_catalogs integer not null default 0 check (combine_uncategorized_catalogs in (0, 1)),
      library_layout text not null default 'auto' check (library_layout in ('auto', 'folders', 'flat')),
      stream_delivery_mode text not null default 'proxy' check (stream_delivery_mode in ('proxy', 'direct')),
      stream_name_template text,
      stream_description_template text,
      last_indexed_at text,
      indexed_media_count integer not null default 0 check (indexed_media_count >= 0),
      last_ftp_tested_at text,
      last_ftp_test_ok integer check (last_ftp_test_ok is null or last_ftp_test_ok in (0, 1)),
      scan_interval_minutes integer not null default 0 check (scan_interval_minutes >= 0),
      next_scheduled_scan_at text,
      install_token_hash text not null unique,
      created_at text not null,
      updated_at text not null,
      last_unlocked_at text
    );

    create table if not exists profile_install_tokens (
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      token_hash text not null unique,
      created_at text not null
    );

    create table if not exists profile_ftp_servers (
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      name text not null,
      encrypted_ftp_config text,
      catalog_enabled integer not null default 0 check (catalog_enabled in (0, 1)),
      catalog_tmdb_api_key text,
      catalog_content_movies integer not null default 1 check (catalog_content_movies in (0, 1)),
      catalog_content_series integer not null default 1 check (catalog_content_series in (0, 1)),
      catalog_content_anime integer not null default 0 check (catalog_content_anime in (0, 1)),
      catalog_content_uncategorized integer not null default 1 check (catalog_content_uncategorized in (0, 1)),
      library_layout text not null default 'auto' check (library_layout in ('auto', 'folders', 'flat')),
      stream_delivery_mode text not null default 'proxy' check (stream_delivery_mode in ('proxy', 'direct')),
      indexed_media_count integer not null default 0 check (indexed_media_count >= 0),
      last_indexed_at text,
      last_ftp_tested_at text,
      last_ftp_test_ok integer check (last_ftp_test_ok is null or last_ftp_test_ok in (0, 1)),
      scan_interval_minutes integer not null default 0 check (scan_interval_minutes >= 0),
      next_scheduled_scan_at text,
      pending_scan_after text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists idx_profile_ftp_servers_profile_id on profile_ftp_servers(profile_id);
    create index if not exists idx_profile_ftp_servers_pending_scan on profile_ftp_servers(pending_scan_after);

    create table if not exists media_files (
${MEDIA_FILES_COLUMNS}
    );

    create index if not exists idx_media_episode on media_files(profile_id, media_kind, parsed_title, season, episode);
    create index if not exists idx_media_movie on media_files(profile_id, media_kind, imdb_id, parsed_title, parsed_year);
    create index if not exists idx_profile_install_tokens_profile_id on profile_install_tokens(profile_id);

    create table if not exists scan_jobs (
${SCAN_JOBS_COLUMNS}
    );

    create table if not exists scan_directory_snapshots (
${SCAN_DIRECTORY_SNAPSHOTS_COLUMNS}
    );

    create table if not exists catalog_enrichment (
${CATALOG_ENRICHMENT_COLUMNS}
    );

    create index if not exists idx_scan_jobs_profile_status on scan_jobs(profile_id, status);
    create index if not exists idx_scan_jobs_status_queued on scan_jobs(status, queued_at);
    create index if not exists idx_scan_directory_snapshots_profile_server on scan_directory_snapshots(profile_id, ftp_server_id);
    create index if not exists idx_catalog_enrichment_status on catalog_enrichment(profile_id, ftp_server_id, status, next_attempt_at);
    create index if not exists idx_catalog_enrichment_catalog on catalog_enrichment(profile_id, catalog_kind, status);

  `);
  ensureProfileColumn(db, "addon_name", "text");
  ensureProfileColumn(db, "addon_logo_url", "text");
  ensureProfileColumn(db, "addon_description", "text");
  ensureProfileColumn(db, "catalog_enabled", "integer not null default 0");
  ensureProfileColumn(db, "catalog_tmdb_api_key", "text");
  ensureProfileColumn(db, "catalog_content_movies", "integer not null default 1");
  ensureProfileColumn(db, "catalog_content_series", "integer not null default 1");
  ensureProfileColumn(db, "catalog_content_anime", "integer not null default 0");
  ensureProfileColumn(db, "catalog_content_uncategorized", "integer not null default 1");
  ensureProfileColumn(db, "combine_uncategorized_catalogs", "integer not null default 0");
  ensureProfileColumn(db, "library_layout", "text not null default 'auto'");
  ensureProfileColumn(db, "stream_delivery_mode", "text not null default 'proxy'");
  ensureProfileColumn(db, "stream_name_template", "text");
  ensureProfileColumn(db, "stream_description_template", "text");
  ensureProfileColumn(db, "last_indexed_at", "text");
  ensureProfileColumn(db, "indexed_media_count", "integer not null default 0");
  ensureProfileColumn(db, "last_ftp_tested_at", "text");
  ensureProfileColumn(db, "last_ftp_test_ok", "integer");
  ensureProfileColumn(db, "scan_interval_minutes", "integer not null default 0");
  ensureProfileColumn(db, "next_scheduled_scan_at", "text");
  ensureMediaColumn(db, "catalog_kind", "text not null default 'movie'");
  ensureMediaColumn(db, "ftp_server_id", "integer references profile_ftp_servers(id) on delete cascade");
  ensureFtpServerColumn(db, "catalog_content_uncategorized", "integer not null default 1");
  ensureScanJobColumn(db, "ftp_server_id", "integer references profile_ftp_servers(id) on delete cascade");
  ensureScanJobColumn(db, "scan_mode", "text");
  ensureScanJobColumn(db, "media_items_added", "integer not null default 0");
  ensureMediaServerUnique(db);
  ensureScanJobsCancelledStatus(db);
  ensureDefaultFtpServers(db);
  ensureCatalogEnrichmentTable(db);
  ensureCatalogEnrichmentColumn(db, "algorithm_version", "integer not null default 1");
  ensureCatalogEnrichmentColumn(db, "genres", "text");
}

function ensureProfileColumn(db: Database.Database, name: string, definition: string) {
  const columns = db.prepare("pragma table_info(profiles)").all() as { name: string }[];
  if (columns.some((column) => column.name === name)) return;
  db.prepare(`alter table profiles add column ${name} ${definition}`).run();
}

function ensureFtpServerColumn(db: Database.Database, name: string, definition: string) {
  const columns = db.prepare("pragma table_info(profile_ftp_servers)").all() as { name: string }[];
  if (columns.some((column) => column.name === name)) return;
  db.prepare(`alter table profile_ftp_servers add column ${name} ${definition}`).run();
}

function ensureMediaColumn(db: Database.Database, name: string, definition: string) {
  const columns = db.prepare("pragma table_info(media_files)").all() as { name: string }[];
  if (columns.some((column) => column.name === name)) return;
  db.prepare(`alter table media_files add column ${name} ${definition}`).run();
}

function ensureScanJobColumn(db: Database.Database, name: string, definition: string) {
  const columns = db.prepare("pragma table_info(scan_jobs)").all() as { name: string }[];
  if (columns.some((column) => column.name === name)) return;
  db.prepare(`alter table scan_jobs add column ${name} ${definition}`).run();
}

function ensureCatalogEnrichmentColumn(db: Database.Database, name: string, definition: string) {
  const columns = db.prepare("pragma table_info(catalog_enrichment)").all() as { name: string }[];
  if (columns.some((column) => column.name === name)) return;
  db.prepare(`alter table catalog_enrichment add column ${name} ${definition}`).run();
}

function ensureCatalogEnrichmentTable(db: Database.Database) {
  db.exec(`
    create table if not exists catalog_enrichment (
${CATALOG_ENRICHMENT_COLUMNS}
    );
    create index if not exists idx_catalog_enrichment_status on catalog_enrichment(profile_id, ftp_server_id, status, next_attempt_at);
    create index if not exists idx_catalog_enrichment_catalog on catalog_enrichment(profile_id, catalog_kind, status);
  `);
}

function ensureMediaServerUnique(db: Database.Database) {
  const row = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'media_files'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("unique(profile_id, ftp_server_id, ftp_path)")) return;

  db.transaction(() => {
    db.exec(`
      alter table media_files rename to media_files_old;
      create table media_files (
${MEDIA_FILES_COLUMNS}
      );
      insert into media_files (
        id, profile_id, ftp_server_id, ftp_path, filename, normalized_filename, extension, size_bytes,
        modified_at, media_kind, catalog_kind, parsed_title, parsed_year, season, episode, imdb_id,
        quality, confidence, last_seen_at
      )
      select
        id, profile_id, ftp_server_id, ftp_path, filename, normalized_filename, extension, size_bytes,
        modified_at, media_kind, catalog_kind, parsed_title, parsed_year, season, episode, imdb_id,
        quality, confidence, last_seen_at
      from media_files_old;
      drop table media_files_old;
      create index if not exists idx_media_episode on media_files(profile_id, media_kind, parsed_title, season, episode);
      create index if not exists idx_media_movie on media_files(profile_id, media_kind, imdb_id, parsed_title, parsed_year);
      create index if not exists idx_media_server on media_files(profile_id, ftp_server_id);
    `);
  })();
}

function ensureScanJobsCancelledStatus(db: Database.Database) {
  const row = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'scan_jobs'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'cancelled'")) return;

  db.transaction(() => {
    db.exec(`
      alter table scan_jobs rename to scan_jobs_old;
      create table scan_jobs (
${SCAN_JOBS_COLUMNS}
      );
      insert into scan_jobs (
        id, profile_id, ftp_server_id, status, trigger, progress_percent, entries_seen, files_seen, directories_seen,
        current_path, estimated_seconds_remaining, message, error, queued_at, started_at, finished_at
      )
      select
        id, profile_id, ftp_server_id, status, trigger, progress_percent, entries_seen, files_seen, directories_seen,
        current_path, estimated_seconds_remaining, message, error, queued_at, started_at, finished_at
      from scan_jobs_old;
      drop table scan_jobs_old;
      create index if not exists idx_scan_jobs_profile_status on scan_jobs(profile_id, status);
      create index if not exists idx_scan_jobs_status_queued on scan_jobs(status, queued_at);
    `);
  })();
}

function ensureDefaultFtpServers(db: Database.Database) {
  const profiles = db.prepare("select * from profiles order by id asc").all() as Array<{
    id: number;
    encrypted_ftp_config: string | null;
    catalog_enabled: number;
    catalog_tmdb_api_key: string | null;
    catalog_content_movies: number;
    catalog_content_series: number;
    catalog_content_anime: number;
    catalog_content_uncategorized: number;
    library_layout: string;
    stream_delivery_mode: string;
    indexed_media_count: number;
    last_indexed_at: string | null;
    last_ftp_tested_at: string | null;
    last_ftp_test_ok: number | null;
    scan_interval_minutes: number;
    next_scheduled_scan_at: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const countServers = db.prepare("select count(*) as count from profile_ftp_servers where profile_id = ?");
  const insertServer = db.prepare(`
    insert into profile_ftp_servers (
      profile_id, name, encrypted_ftp_config, catalog_enabled, catalog_tmdb_api_key,
      catalog_content_movies, catalog_content_series, catalog_content_anime,
      catalog_content_uncategorized,
      library_layout, stream_delivery_mode, indexed_media_count, last_indexed_at,
      last_ftp_tested_at, last_ftp_test_ok, scan_interval_minutes, next_scheduled_scan_at,
      created_at, updated_at
    ) values (?, 'Server 1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateMedia = db.prepare("update media_files set ftp_server_id = ? where profile_id = ? and ftp_server_id is null");
  const updateJobs = db.prepare("update scan_jobs set ftp_server_id = ? where profile_id = ? and ftp_server_id is null");

  db.transaction(() => {
    for (const profile of profiles) {
      const count = (countServers.get(profile.id) as { count: number }).count;
      if (count > 0) continue;
      const result = insertServer.run(
        profile.id,
        profile.encrypted_ftp_config,
        profile.catalog_enabled,
        profile.catalog_tmdb_api_key,
        profile.catalog_content_movies,
        profile.catalog_content_series,
        profile.catalog_content_anime,
        profile.catalog_content_uncategorized,
        profile.library_layout,
        profile.stream_delivery_mode,
        profile.indexed_media_count,
        profile.last_indexed_at,
        profile.last_ftp_tested_at,
        profile.last_ftp_test_ok,
        profile.scan_interval_minutes,
        profile.next_scheduled_scan_at,
        profile.created_at,
        profile.updated_at,
      );
      const serverId = Number(result.lastInsertRowid);
      updateMedia.run(serverId, profile.id);
      updateJobs.run(serverId, profile.id);
    }
  })();
}
