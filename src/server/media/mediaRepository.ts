import type Database from "better-sqlite3";
import type { ParsedMedia } from "./parser.js";

export type ParsedMediaFileInput = Omit<ParsedMedia, "catalogKind"> & {
  catalogKind?: ParsedMedia["catalogKind"];
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

export type CatalogItem = {
  mediaKind: "movie" | "series";
  catalogKind: "movie" | "series" | "anime";
  parsedTitle: string;
  parsedYear: number | null;
  imdbId: string | null;
};

export type OtherCatalogItem = {
  id: number;
  mediaKind: "movie" | "series";
  filename: string;
  parsedTitle: string;
  parsedYear: number | null;
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

function toOtherCatalogItem(row: {
  id: number;
  media_kind: "movie" | "series";
  filename: string;
  parsed_title: string;
  parsed_year: number | null;
  quality: string | null;
  size_bytes: number | null;
}): OtherCatalogItem {
  return {
    id: row.id,
    mediaKind: row.media_kind,
    filename: row.filename,
    parsedTitle: row.parsed_title,
    parsedYear: row.parsed_year,
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
          catalog_kind,
          parsed_title,
          parsed_year,
          season,
          episode,
          imdb_id,
          quality,
          confidence,
          last_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(profile_id, ftp_path) do update set
          filename = excluded.filename,
          normalized_filename = excluded.normalized_filename,
          extension = excluded.extension,
          size_bytes = excluded.size_bytes,
          modified_at = excluded.modified_at,
          media_kind = excluded.media_kind,
          catalog_kind = excluded.catalog_kind,
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
        file.catalogKind ?? file.mediaKind,
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

  getFileForProfile(profileId: number, fileId: number): MediaMatch | null {
    const row = this.db
      .prepare(
        `
        select id, ftp_path, filename, quality, size_bytes
        from media_files
        where profile_id = ?
          and id = ?
      `,
      )
      .get(profileId, fileId) as MediaFileRow | undefined;
    return row ? toMediaMatch(row) : null;
  }

  countForProfile(profileId: number): number {
    const row = this.db.prepare("select count(*) as count from media_files where profile_id = ?").get(profileId) as { count: number };
    return row.count;
  }

  catalogItems(profileId: number, catalogKind: "movie" | "series" | "anime", limit: number, skip: number): CatalogItem[] {
    const rows = this.db
      .prepare(
        `
        select media_kind, catalog_kind, parsed_title, parsed_year, imdb_id, max(confidence) as max_confidence
        from media_files
        where profile_id = ?
          and catalog_kind = ?
          and parsed_title is not null
        group by media_kind, catalog_kind, parsed_title, parsed_year, imdb_id
        order by max_confidence desc, parsed_title asc
        limit ? offset ?
      `,
      )
      .all(profileId, catalogKind, limit, skip) as Array<{
      media_kind: "movie" | "series";
      catalog_kind: "movie" | "series" | "anime";
      parsed_title: string;
      parsed_year: number | null;
      imdb_id: string | null;
    }>;

    return rows.map((row) => ({
      mediaKind: row.media_kind,
      catalogKind: row.catalog_kind,
      parsedTitle: row.parsed_title,
      parsedYear: row.parsed_year,
      imdbId: row.imdb_id,
    }));
  }

  otherCatalogItems(profileId: number, limit: number, skip: number): OtherCatalogItem[] {
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.media_kind, mf.filename, mf.parsed_title, mf.parsed_year, mf.quality, mf.size_bytes
        from media_files mf
        join (
          select parsed_title, parsed_year, min(id) as id
          from media_files
          where profile_id = ?
            and imdb_id is null
            and parsed_title is not null
          group by parsed_title, parsed_year
        ) grouped on grouped.id = mf.id
        order by mf.parsed_title asc, mf.filename asc
        limit ? offset ?
      `,
      )
      .all(profileId, limit, skip) as Array<{
      id: number;
      media_kind: "movie" | "series";
      filename: string;
      parsed_title: string;
      parsed_year: number | null;
      quality: string | null;
      size_bytes: number | null;
    }>;

    return rows.map(toOtherCatalogItem);
  }

  otherCatalogStreams(profileId: number, representativeFileId: number): MediaMatch[] {
    const base = this.db
      .prepare(
        `
        select parsed_title, parsed_year
        from media_files
        where profile_id = ?
          and id = ?
          and imdb_id is null
      `,
      )
      .get(profileId, representativeFileId) as { parsed_title: string; parsed_year: number | null } | undefined;
    if (!base) return [];

    const rows = this.db
      .prepare(
        `
        select id, ftp_path, filename, quality, size_bytes
        from media_files
        where profile_id = ?
          and imdb_id is null
          and parsed_title = ?
          and (parsed_year is ? or parsed_year = ?)
        order by size_bytes desc, filename asc
      `,
      )
      .all(profileId, base.parsed_title, base.parsed_year, base.parsed_year) as MediaFileRow[];
    return rows.map(toMediaMatch);
  }

  otherCatalogItem(profileId: number, fileId: number): OtherCatalogItem | null {
    const row = this.db
      .prepare(
        `
        select id, media_kind, filename, parsed_title, parsed_year, quality, size_bytes
        from media_files
        where profile_id = ?
          and id = ?
      `,
      )
      .get(profileId, fileId) as
      | {
          id: number;
          media_kind: "movie" | "series";
          filename: string;
          parsed_title: string;
          parsed_year: number | null;
          quality: string | null;
          size_bytes: number | null;
        }
      | undefined;

    return row ? toOtherCatalogItem(row) : null;
  }
}

function normalizeRootPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
