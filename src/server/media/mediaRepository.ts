import type Database from "better-sqlite3";
import type { ParsedMedia } from "./parser.js";

export type ParsedMediaFileInput = Omit<ParsedMedia, "catalogKind"> & {
  catalogKind?: ParsedMedia["catalogKind"];
  ftpServerId?: number | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  lastSeenAt?: string;
};

export type MediaMatch = {
  id: number;
  ftpServerId: number | null;
  serverName: string | null;
  streamDeliveryMode?: "proxy" | "direct" | null;
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

export type DirectorySnapshotInput = {
  dirPath: string;
  entryCount: number;
  fingerprint: string;
  modifiedAt?: string | null;
  lastSeenAt: string;
  ftpServerId?: number | null;
};

type MediaFileRow = {
  id: number;
  ftp_server_id: number | null;
  server_name?: string | null;
  stream_delivery_mode?: "proxy" | "direct" | null;
  ftp_path: string;
  filename: string;
  quality: string | null;
  size_bytes: number | null;
};

function toMediaMatch(row: MediaFileRow): MediaMatch {
  return {
    id: row.id,
    ftpServerId: row.ftp_server_id,
    serverName: row.server_name ?? null,
    streamDeliveryMode: row.stream_delivery_mode ?? null,
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
    if (file.ftpServerId === undefined || file.ftpServerId === null) {
      const updated = this.db
        .prepare(
          `
          update media_files
          set filename = ?,
              normalized_filename = ?,
              extension = ?,
              size_bytes = ?,
              modified_at = ?,
              media_kind = ?,
              catalog_kind = ?,
              parsed_title = ?,
              parsed_year = ?,
              season = ?,
              episode = ?,
              imdb_id = ?,
              quality = ?,
              confidence = ?,
              last_seen_at = ?
          where profile_id = ?
            and ftp_server_id is null
            and ftp_path = ?
        `,
        )
        .run(
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
          profileId,
          file.ftpPath,
        );
      if (updated.changes > 0) return;
    }
    this.db
      .prepare(
        `
        insert into media_files (
          profile_id,
          ftp_server_id,
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
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(profile_id, ftp_server_id, ftp_path) do update set
          ftp_server_id = excluded.ftp_server_id,
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
        file.ftpServerId ?? null,
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

  deleteStaleUnderRoot(profileId: number, rootPath: string, seenSince: string, ftpServerId?: number | null) {
    const root = normalizeRootPath(rootPath);
    if (root === "/") {
      return this.db
        .prepare("delete from media_files where profile_id = ? and (? is null or ftp_server_id = ?) and last_seen_at < ?")
        .run(profileId, ftpServerId ?? null, ftpServerId ?? null, seenSince).changes;
    }

    const rootWithSlash = `${root}/`;
    return this.db
      .prepare(
        `
        delete from media_files
        where profile_id = ?
          and (? is null or ftp_server_id = ?)
          and last_seen_at < ?
          and (ftp_path = ? or substr(ftp_path, 1, ?) = ?)
      `,
      )
      .run(profileId, ftpServerId ?? null, ftpServerId ?? null, seenSince, root, rootWithSlash.length, rootWithSlash).changes;
  }

  findEpisode(profileId: number, normalizedTitle: string, season: number, episode: number): MediaMatch[] {
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, s.name as server_name, s.stream_delivery_mode, mf.ftp_path, mf.filename, mf.quality, mf.size_bytes
        from media_files mf
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and mf.media_kind = 'series'
          and mf.parsed_title = ?
          and mf.season = ?
          and mf.episode = ?
        order by s.name asc, mf.confidence desc, mf.size_bytes desc
      `,
      )
      .all(profileId, normalizedTitle, season, episode) as MediaFileRow[];
    return rows.map(toMediaMatch);
  }

  findMovie(profileId: number, imdbId: string, normalizedTitle: string, year: number | null): MediaMatch[] {
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, s.name as server_name, s.stream_delivery_mode, mf.ftp_path, mf.filename, mf.quality, mf.size_bytes
        from media_files mf
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and mf.media_kind = 'movie'
          and (
            (mf.imdb_id is not null and mf.imdb_id = ?)
            or (
              mf.parsed_title = ?
              and (? is null or mf.parsed_year is null or mf.parsed_year = ?)
            )
          )
        order by s.name asc, mf.confidence desc, mf.size_bytes desc
      `,
      )
      .all(profileId, imdbId, normalizedTitle, year, year) as MediaFileRow[];
    return rows.map(toMediaMatch);
  }

  getFileForProfile(profileId: number, fileId: number): MediaMatch | null {
    const row = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, s.name as server_name, s.stream_delivery_mode, mf.ftp_path, mf.filename, mf.quality, mf.size_bytes
        from media_files mf
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and mf.id = ?
      `,
      )
      .get(profileId, fileId) as MediaFileRow | undefined;
    return row ? toMediaMatch(row) : null;
  }

  countForProfile(profileId: number): number {
    const row = this.db.prepare("select count(*) as count from media_files where profile_id = ?").get(profileId) as { count: number };
    return row.count;
  }

  countForServer(profileId: number, ftpServerId: number): number {
    const row = this.db
      .prepare("select count(*) as count from media_files where profile_id = ? and ftp_server_id = ?")
      .get(profileId, ftpServerId) as { count: number };
    return row.count;
  }

  aggregateCountsForProfile(profileId: number) {
    const categorized = this.db
      .prepare(
        `
        select
          count(*) as total,
          sum(case when category = 'movie' then 1 else 0 end) as movies,
          sum(case when category = 'series' then 1 else 0 end) as series,
          sum(case when category = 'anime' then 1 else 0 end) as anime
        from (
          select
            catalog_kind as category,
            case
              when imdb_id is not null then imdb_id
              when catalog_kind = 'movie' then parsed_title || '|' || coalesce(parsed_year, '')
              else parsed_title
            end as item_key
          from media_files
          where profile_id = ?
            and parsed_title is not null
          group by category, item_key
        )
      `,
      )
      .get(profileId) as { total: number; movies: number | null; series: number | null; anime: number | null };
    const uncategorized = this.db
      .prepare(
        `
        select count(*) as count
        from (
          select
            catalog_kind,
            case
              when catalog_kind = 'movie' then parsed_title || '|' || coalesce(parsed_year, '')
              else parsed_title
            end as item_key
          from media_files
          where profile_id = ?
            and imdb_id is null
            and parsed_title is not null
          group by catalog_kind, item_key
        )
      `,
      )
      .get(profileId) as { count: number };
    return {
      total: categorized.total,
      movies: categorized.movies ?? 0,
      series: categorized.series ?? 0,
      anime: categorized.anime ?? 0,
      uncategorized: uncategorized.count,
    };
  }

  directorySnapshotMatchesModifiedAt(profileId: number, ftpServerId: number | null | undefined, dirPath: string, modifiedAt: string) {
    const row = this.db
      .prepare(
        `
        select id
        from scan_directory_snapshots
        where profile_id = ?
          and (? is null or ftp_server_id = ?)
          and dir_path = ?
          and modified_at = ?
        limit 1
      `,
      )
      .get(profileId, ftpServerId ?? null, ftpServerId ?? null, normalizeRootPath(dirPath), modifiedAt) as { id: number } | undefined;
    return Boolean(row);
  }

  directorySnapshotMatchesFingerprint(
    profileId: number,
    ftpServerId: number | null | undefined,
    dirPath: string,
    entryCount: number,
    fingerprint: string,
  ) {
    const row = this.db
      .prepare(
        `
        select id
        from scan_directory_snapshots
        where profile_id = ?
          and (? is null or ftp_server_id = ?)
          and dir_path = ?
          and entry_count = ?
          and fingerprint = ?
        limit 1
      `,
      )
      .get(profileId, ftpServerId ?? null, ftpServerId ?? null, normalizeRootPath(dirPath), entryCount, fingerprint) as
      | { id: number }
      | undefined;
    return Boolean(row);
  }

  saveDirectorySnapshot(profileId: number, snapshot: DirectorySnapshotInput) {
    this.db
      .prepare(
        `
        insert into scan_directory_snapshots (
          profile_id,
          ftp_server_id,
          dir_path,
          entry_count,
          fingerprint,
          modified_at,
          last_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(profile_id, ftp_server_id, dir_path) do update set
          entry_count = excluded.entry_count,
          fingerprint = excluded.fingerprint,
          modified_at = excluded.modified_at,
          last_seen_at = excluded.last_seen_at
      `,
      )
      .run(
        profileId,
        snapshot.ftpServerId ?? null,
        normalizeRootPath(snapshot.dirPath),
        snapshot.entryCount,
        snapshot.fingerprint,
        snapshot.modifiedAt ?? null,
        snapshot.lastSeenAt,
      );
  }

  touchDirectorySnapshot(profileId: number, ftpServerId: number | null | undefined, dirPath: string, lastSeenAt: string) {
    this.db
      .prepare(
        `
        update scan_directory_snapshots
        set last_seen_at = ?
        where profile_id = ?
          and (? is null or ftp_server_id = ?)
          and dir_path = ?
      `,
      )
      .run(lastSeenAt, profileId, ftpServerId ?? null, ftpServerId ?? null, normalizeRootPath(dirPath));
  }

  markSeenUnderRoot(profileId: number, rootPath: string, seenAt: string, ftpServerId?: number | null) {
    const root = normalizeRootPath(rootPath);
    if (root === "/") {
      return this.db
        .prepare("update media_files set last_seen_at = ? where profile_id = ? and (? is null or ftp_server_id = ?)")
        .run(seenAt, profileId, ftpServerId ?? null, ftpServerId ?? null).changes;
    }

    const rootWithSlash = `${root}/`;
    return this.db
      .prepare(
        `
        update media_files
        set last_seen_at = ?
        where profile_id = ?
          and (? is null or ftp_server_id = ?)
          and (ftp_path = ? or substr(ftp_path, 1, ?) = ?)
      `,
      )
      .run(seenAt, profileId, ftpServerId ?? null, ftpServerId ?? null, root, rootWithSlash.length, rootWithSlash).changes;
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
        select mf.id, mf.ftp_server_id, s.name as server_name, s.stream_delivery_mode, mf.ftp_path, mf.filename, mf.quality, mf.size_bytes
        from media_files mf
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and mf.imdb_id is null
          and mf.parsed_title = ?
          and (mf.parsed_year is ? or mf.parsed_year = ?)
        order by s.name asc, mf.size_bytes desc, mf.filename asc
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
