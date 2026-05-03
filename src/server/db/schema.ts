import type Database from "better-sqlite3";

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
      library_layout text not null default 'auto' check (library_layout in ('auto', 'folders', 'flat')),
      stream_delivery_mode text not null default 'proxy' check (stream_delivery_mode in ('proxy', 'direct')),
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

    create table if not exists media_files (
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
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
      unique(profile_id, ftp_path)
    );

    create index if not exists idx_media_episode on media_files(profile_id, media_kind, parsed_title, season, episode);
    create index if not exists idx_media_movie on media_files(profile_id, media_kind, imdb_id, parsed_title, parsed_year);
    create index if not exists idx_profile_install_tokens_profile_id on profile_install_tokens(profile_id);

    create table if not exists scan_jobs (
      id integer primary key autoincrement,
      profile_id integer not null references profiles(id) on delete cascade,
      status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
      trigger text not null check (trigger in ('manual', 'scheduled')),
      progress_percent integer not null default 0 check (progress_percent between 0 and 100),
      entries_seen integer not null default 0 check (entries_seen >= 0),
      files_seen integer not null default 0 check (files_seen >= 0),
      directories_seen integer not null default 0 check (directories_seen >= 0),
      current_path text,
      estimated_seconds_remaining integer check (estimated_seconds_remaining is null or estimated_seconds_remaining >= 0),
      message text,
      error text,
      queued_at text not null,
      started_at text,
      finished_at text
    );

    create index if not exists idx_scan_jobs_profile_status on scan_jobs(profile_id, status);
    create index if not exists idx_scan_jobs_status_queued on scan_jobs(status, queued_at);

  `);
  ensureProfileColumn(db, "addon_name", "text");
  ensureProfileColumn(db, "addon_logo_url", "text");
  ensureProfileColumn(db, "addon_description", "text");
  ensureProfileColumn(db, "catalog_enabled", "integer not null default 0");
  ensureProfileColumn(db, "catalog_tmdb_api_key", "text");
  ensureProfileColumn(db, "catalog_content_movies", "integer not null default 1");
  ensureProfileColumn(db, "catalog_content_series", "integer not null default 1");
  ensureProfileColumn(db, "catalog_content_anime", "integer not null default 0");
  ensureProfileColumn(db, "library_layout", "text not null default 'auto'");
  ensureProfileColumn(db, "stream_delivery_mode", "text not null default 'proxy'");
  ensureProfileColumn(db, "last_indexed_at", "text");
  ensureProfileColumn(db, "indexed_media_count", "integer not null default 0");
  ensureProfileColumn(db, "last_ftp_tested_at", "text");
  ensureProfileColumn(db, "last_ftp_test_ok", "integer");
  ensureProfileColumn(db, "scan_interval_minutes", "integer not null default 0");
  ensureProfileColumn(db, "next_scheduled_scan_at", "text");
  ensureMediaColumn(db, "catalog_kind", "text not null default 'movie'");
}

function ensureProfileColumn(db: Database.Database, name: string, definition: string) {
  const columns = db.prepare("pragma table_info(profiles)").all() as { name: string }[];
  if (columns.some((column) => column.name === name)) return;
  db.prepare(`alter table profiles add column ${name} ${definition}`).run();
}

function ensureMediaColumn(db: Database.Database, name: string, definition: string) {
  const columns = db.prepare("pragma table_info(media_files)").all() as { name: string }[];
  if (columns.some((column) => column.name === name)) return;
  db.prepare(`alter table media_files add column ${name} ${definition}`).run();
}
