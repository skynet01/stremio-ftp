import type Database from "better-sqlite3";
import type { ParsedMedia } from "./parser.js";

export type ParsedMediaFileInput = ParsedMedia & {
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  lastSeenAt?: string;
};

export type MediaMatch = {
  id: number;
  ftpPath: string;
  filename: string;
  quality: string | null;
  sizeBytes: number | null;
};

type MediaFileRow = {
  id: number;
  ftp_path: string;
  filename: string;
  quality: string | null;
  size_bytes: number | null;
};

function toMediaMatch(row: MediaFileRow): MediaMatch {
  return {
    id: row.id,
    ftpPath: row.ftp_path,
    filename: row.filename,
    quality: row.quality,
    sizeBytes: row.size_bytes,
  };
}

export class MediaRepository {
  constructor(private readonly db: Database.Database) {}

  upsertParsedFile(profileId: number, file: ParsedMediaFileInput) {
    const lastSeenAt = file.lastSeenAt ?? new Date().toISOString();
    this.db
      .prepare(
        `
        insert into media_files (
          profile_id,
          ftp_path,
          filename,
          normalized_filename,
          extension,
          size_bytes,
          modified_at,
          media_kind,
          parsed_title,
          parsed_year,
          season,
          episode,
          imdb_id,
          quality,
          confidence,
          last_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(profile_id, ftp_path) do update set
          filename = excluded.filename,
          normalized_filename = excluded.normalized_filename,
          extension = excluded.extension,
          size_bytes = excluded.size_bytes,
          modified_at = excluded.modified_at,
          media_kind = excluded.media_kind,
          parsed_title = excluded.parsed_title,
          parsed_year = excluded.parsed_year,
          season = excluded.season,
          episode = excluded.episode,
          imdb_id = excluded.imdb_id,
          quality = excluded.quality,
          confidence = excluded.confidence,
          last_seen_at = excluded.last_seen_at
      `,
      )
      .run(
        profileId,
        file.ftpPath,
        file.filename,
        file.normalizedFilename,
        file.extension,
        file.sizeBytes ?? null,
        file.modifiedAt ?? null,
        file.mediaKind,
        file.parsedTitle,
        file.parsedYear,
        file.season,
        file.episode,
        file.imdbId,
        file.quality,
        file.confidence,
        lastSeenAt,
      );
  }

  deleteStaleUnderRoot(profileId: number, rootPath: string, seenSince: string) {
    const root = normalizeRootPath(rootPath);
    if (root === "/") {
      return this.db
        .prepare("delete from media_files where profile_id = ? and last_seen_at < ?")
        .run(profileId, seenSince).changes;
    }

    const rootWithSlash = `${root}/`;
    return this.db
      .prepare(
        `
        delete from media_files
        where profile_id = ?
          and last_seen_at < ?
          and (ftp_path = ? or substr(ftp_path, 1, ?) = ?)
      `,
      )
      .run(profileId, seenSince, root, rootWithSlash.length, rootWithSlash).changes;
  }

  findEpisode(profileId: number, normalizedTitle: string, season: number, episode: number): MediaMatch[] {
    const rows = this.db
      .prepare(
        `
        select id, ftp_path, filename, quality, size_bytes
        from media_files
        where profile_id = ?
          and media_kind = 'series'
          and parsed_title = ?
          and season = ?
          and episode = ?
        order by confidence desc, size_bytes desc
      `,
      )
      .all(profileId, normalizedTitle, season, episode) as MediaFileRow[];
    return rows.map(toMediaMatch);
  }

  findMovie(profileId: number, imdbId: string, normalizedTitle: string, year: number | null): MediaMatch[] {
    const rows = this.db
      .prepare(
        `
        select id, ftp_path, filename, quality, size_bytes
        from media_files
        where profile_id = ?
          and media_kind = 'movie'
          and (
            (imdb_id is not null and imdb_id = ?)
            or (
              parsed_title = ?
              and (? is null or parsed_year is null or parsed_year = ?)
            )
          )
        order by confidence desc, size_bytes desc
      `,
      )
      .all(profileId, imdbId, normalizedTitle, year, year) as MediaFileRow[];
    return rows.map(toMediaMatch);
  }

  setNegativeCache(profileId: number, type: "movie" | "series", stremioId: string, expiresAt: string) {
    this.db
      .prepare(
        `
        insert into negative_cache (profile_id, type, stremio_id, expires_at)
        values (?, ?, ?, ?)
        on conflict(profile_id, type, stremio_id) do update set
          expires_at = excluded.expires_at
      `,
      )
      .run(profileId, type, stremioId, expiresAt);
  }

  isNegativeCached(profileId: number, type: "movie" | "series", stremioId: string, now = new Date().toISOString()) {
    const row = this.db
      .prepare(
        `
        select 1
        from negative_cache
        where profile_id = ?
          and type = ?
          and stremio_id = ?
          and expires_at > ?
      `,
      )
      .get(profileId, type, stremioId, now);
    return Boolean(row);
  }

  clearExpiredNegativeCache(now = new Date().toISOString()) {
    return this.db.prepare("delete from negative_cache where expires_at <= ?").run(now).changes;
  }
}

function normalizeRootPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
