import type Database from "better-sqlite3";

export function migrate(db: Database.Database) {
  db.exec(`
    create table if not exists profiles (
      id integer primary key autoincrement,
      browser_uid text not null unique,
      passphrase_verifier text not null,
      encrypted_ftp_config text,
      install_token_hash text not null unique,
      created_at text not null,
      updated_at text not null,
      last_unlocked_at text
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

  `);
}
