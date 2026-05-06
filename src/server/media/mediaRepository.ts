import type Database from "better-sqlite3";
import type { ParsedMedia } from "./parser.js";

const CATALOG_ENRICHMENT_ALGORITHM_VERSION = 2;

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

export type CatalogEnrichmentCandidate = CatalogItem & {
  id: number;
  ftpServerId: number;
  itemKey: string;
};

export type PersistedCatalogMeta = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
};

export type CatalogEnrichmentStats = {
  total: number;
  matched: number;
  unmatched: number;
  pending: number;
  retry: number;
};

export type OtherCatalogItem = {
  id: number;
  mediaKind: "movie" | "series";
  folderName: string;
  folderKey: string;
  parsedTitle: string;
  parsedYear: number | null;
  fileCount: number;
  serverCount: number;
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
        left join catalog_enrichment ce
          on ce.profile_id = mf.profile_id
         and ce.ftp_server_id = mf.ftp_server_id
         and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
         and ce.status = 'matched'
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and (
            (
              mf.media_kind = 'movie'
              and (
                (mf.imdb_id is not null and mf.imdb_id = ?)
                or (
                  mf.parsed_title = ?
                  and (? is null or mf.parsed_year is null or mf.parsed_year = ?)
                )
              )
            )
            or (
              ce.meta_type = 'movie'
              and ce.meta_id = ?
            )
          )
        order by s.name asc, mf.confidence desc, mf.size_bytes desc
      `,
      )
      .all(profileId, imdbId, normalizedTitle, year, year, imdbId) as MediaFileRow[];
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
    const total = this.countForProfile(profileId);
    const enriched = this.db
      .prepare(
        `
        select
          count(*) as rows,
          count(distinct case when status = 'matched' and catalog_kind = 'movie' then meta_id end) as movies,
          count(distinct case when status = 'matched' and catalog_kind = 'series' then meta_id end) as series,
          count(distinct case when status = 'matched' and catalog_kind = 'anime' then meta_id end) as anime,
          count(distinct case when status = 'unmatched' then item_key end) as uncategorized
        from catalog_enrichment
        where profile_id = ?
      `,
      )
      .get(profileId) as { rows: number; movies: number; series: number; anime: number; uncategorized: number };
    if (enriched.rows > 0) {
      return {
        total,
        movies: enriched.movies,
        series: enriched.series,
        anime: enriched.anime,
        uncategorized: enriched.uncategorized,
      };
    }
    const counts = this.db
      .prepare(
        `
        select
          sum(case when category = 'movie' and needs_review = 0 then 1 else 0 end) as movies,
          sum(case when category = 'series' and needs_review = 0 then 1 else 0 end) as series,
          sum(case when category = 'anime' and needs_review = 0 then 1 else 0 end) as anime,
          sum(case when needs_review = 1 then 1 else 0 end) as uncategorized
        from (
          select
            catalog_kind as category,
            case when max(confidence) <= 70 and max(case when imdb_id is not null then 1 else 0 end) = 0 then 1 else 0 end as needs_review
          from media_files
          where profile_id = ?
            and parsed_title is not null
          group by
            catalog_kind,
            case
              when imdb_id is not null then imdb_id
              when catalog_kind = 'movie' then parsed_title || '|' || coalesce(parsed_year, '')
              else parsed_title
            end
        )
      `,
      )
      .get(profileId) as { movies: number | null; series: number | null; anime: number | null; uncategorized: number | null };
    return {
      total,
      movies: counts.movies ?? 0,
      series: counts.series ?? 0,
      anime: counts.anime ?? 0,
      uncategorized: counts.uncategorized ?? 0,
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

  clearDirectorySnapshots(profileId: number, ftpServerId?: number | null) {
    return this.db
      .prepare("delete from scan_directory_snapshots where profile_id = ? and (? is null or ftp_server_id = ?)")
      .run(profileId, ftpServerId ?? null, ftpServerId ?? null).changes;
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

  catalogItems(
    profileId: number,
    catalogKind: "movie" | "series" | "anime",
    limit: number,
    skip: number,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean } = {},
  ): CatalogItem[] {
    const serverFilter = mediaServerFilter("mf", options.ftpServerIds, options.includeLegacyNullServer);
    const rows = this.db
      .prepare(
        `
        select mf.media_kind, mf.catalog_kind, mf.parsed_title, mf.parsed_year, mf.imdb_id, max(mf.confidence) as max_confidence
        from media_files mf
        where mf.profile_id = ?
          and mf.catalog_kind = ?
          and mf.parsed_title is not null
          ${serverFilter.sql}
        group by media_kind, catalog_kind, parsed_title, parsed_year, imdb_id
        order by max_confidence desc, parsed_title asc
        limit ? offset ?
      `,
      )
      .all(profileId, catalogKind, ...serverFilter.params, limit, skip) as Array<{
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

  catalogEnrichmentCandidates(
    profileId: number,
    ftpServerId: number,
    catalogKinds: Array<"movie" | "series" | "anime">,
  ): CatalogEnrichmentCandidate[] {
    if (!catalogKinds.length) return [];
    const rows = this.db
      .prepare(
        `
        select
          min(mf.id) as id,
          mf.ftp_server_id,
          mf.media_kind,
          mf.catalog_kind,
          mf.parsed_title,
          mf.parsed_year,
          mf.imdb_id,
          max(mf.confidence) as max_confidence
        from media_files mf
        where mf.profile_id = ?
          and mf.ftp_server_id = ?
          and mf.catalog_kind in (${catalogKinds.map(() => "?").join(", ")})
          and mf.parsed_title is not null
        group by mf.ftp_server_id, mf.media_kind, mf.catalog_kind, mf.parsed_title, mf.parsed_year, mf.imdb_id
        order by max_confidence desc, mf.parsed_title asc
      `,
      )
      .all(profileId, ftpServerId, ...catalogKinds) as Array<{
      id: number;
      ftp_server_id: number;
      media_kind: "movie" | "series";
      catalog_kind: "movie" | "series" | "anime";
      parsed_title: string;
      parsed_year: number | null;
      imdb_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      ftpServerId: row.ftp_server_id,
      mediaKind: row.media_kind,
      catalogKind: row.catalog_kind,
      parsedTitle: row.parsed_title,
      parsedYear: row.parsed_year,
      imdbId: row.imdb_id,
      itemKey: catalogEnrichmentKey(row.catalog_kind, row.parsed_title, row.parsed_year, row.imdb_id),
    }));
  }

  syncCatalogEnrichmentCandidates(profileId: number, ftpServerId: number, candidates: CatalogEnrichmentCandidate[], seenAt: string) {
    const upsert = this.db.prepare(
      `
      insert into catalog_enrichment (
        profile_id, ftp_server_id, item_key, media_kind, catalog_kind, parsed_title, parsed_year,
        source_imdb_id, status, algorithm_version, last_seen_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      on conflict(profile_id, ftp_server_id, item_key) do update set
        media_kind = excluded.media_kind,
        catalog_kind = excluded.catalog_kind,
        parsed_title = excluded.parsed_title,
        parsed_year = excluded.parsed_year,
        source_imdb_id = excluded.source_imdb_id,
        status = case
          when catalog_enrichment.status = 'unmatched'
            and catalog_enrichment.algorithm_version < excluded.algorithm_version
          then 'pending'
          else catalog_enrichment.status
        end,
        algorithm_version = excluded.algorithm_version,
        error = case
          when catalog_enrichment.status = 'unmatched'
            and catalog_enrichment.algorithm_version < excluded.algorithm_version
          then null
          else catalog_enrichment.error
        end,
        next_attempt_at = case
          when catalog_enrichment.status = 'unmatched'
            and catalog_enrichment.algorithm_version < excluded.algorithm_version
          then null
          else catalog_enrichment.next_attempt_at
        end,
        last_seen_at = excluded.last_seen_at
    `,
    );
    const removeStale = this.db.prepare("delete from catalog_enrichment where profile_id = ? and ftp_server_id = ? and last_seen_at <> ?");
    this.db.transaction(() => {
      for (const candidate of candidates) {
        upsert.run(
          profileId,
          ftpServerId,
          candidate.itemKey,
          candidate.mediaKind,
          candidate.catalogKind,
          candidate.parsedTitle,
          candidate.parsedYear,
          candidate.imdbId,
          CATALOG_ENRICHMENT_ALGORITHM_VERSION,
          seenAt,
          seenAt,
          seenAt,
        );
      }
      removeStale.run(profileId, ftpServerId, seenAt);
    })();
  }

  pendingCatalogEnrichment(profileId: number, ftpServerId: number, nowIso: string, limit: number): CatalogEnrichmentCandidate[] {
    const rows = this.db
      .prepare(
        `
        select id, ftp_server_id, item_key, media_kind, catalog_kind, parsed_title, parsed_year, source_imdb_id
        from catalog_enrichment
        where profile_id = ?
          and ftp_server_id = ?
          and (
            status = 'pending'
            or (status = 'retry' and (next_attempt_at is null or next_attempt_at <= ?))
          )
        order by updated_at asc, id asc
        limit ?
      `,
      )
      .all(profileId, ftpServerId, nowIso, limit) as Array<{
      id: number;
      ftp_server_id: number;
      item_key: string;
      media_kind: "movie" | "series";
      catalog_kind: "movie" | "series" | "anime";
      parsed_title: string;
      parsed_year: number | null;
      source_imdb_id: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ftpServerId: row.ftp_server_id,
      itemKey: row.item_key,
      mediaKind: row.media_kind,
      catalogKind: row.catalog_kind,
      parsedTitle: row.parsed_title,
      parsedYear: row.parsed_year,
      imdbId: row.source_imdb_id,
    }));
  }

  saveCatalogEnrichmentMatch(enrichmentId: number, meta: PersistedCatalogMeta, nowIso: string) {
    this.db
      .prepare(
        `
        update catalog_enrichment
        set status = 'matched',
            meta_id = ?,
            meta_type = ?,
            meta_name = ?,
            poster = ?,
            background = ?,
            description = ?,
            release_info = ?,
            attempts = attempts + 1,
            error = null,
            next_attempt_at = null,
            updated_at = ?
        where id = ?
      `,
      )
      .run(meta.id, meta.type, meta.name, meta.poster ?? null, meta.background ?? null, meta.description ?? null, meta.releaseInfo ?? null, nowIso, enrichmentId);
  }

  saveCatalogEnrichmentUnmatched(enrichmentId: number, nowIso: string) {
    this.db
      .prepare(
        `
        update catalog_enrichment
        set status = 'unmatched',
            attempts = attempts + 1,
            error = null,
            next_attempt_at = null,
            updated_at = ?
        where id = ?
      `,
      )
      .run(nowIso, enrichmentId);
  }

  saveCatalogEnrichmentRetry(enrichmentId: number, error: string, nextAttemptAt: string, nowIso: string) {
    this.db
      .prepare(
        `
        update catalog_enrichment
        set status = 'retry',
            attempts = attempts + 1,
            error = ?,
            next_attempt_at = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(error, nextAttemptAt, nowIso, enrichmentId);
  }

  catalogEnrichmentStats(profileId: number, ftpServerId: number): CatalogEnrichmentStats {
    const row = this.db
      .prepare(
        `
        select
          count(*) as total,
          sum(case when status = 'matched' then 1 else 0 end) as matched,
          sum(case when status = 'unmatched' then 1 else 0 end) as unmatched,
          sum(case when status = 'pending' then 1 else 0 end) as pending,
          sum(case when status = 'retry' then 1 else 0 end) as retry
        from catalog_enrichment
        where profile_id = ?
          and ftp_server_id = ?
      `,
      )
      .get(profileId, ftpServerId) as {
      total: number;
      matched: number | null;
      unmatched: number | null;
      pending: number | null;
      retry: number | null;
    };
    return {
      total: row.total,
      matched: row.matched ?? 0,
      unmatched: row.unmatched ?? 0,
      pending: row.pending ?? 0,
      retry: row.retry ?? 0,
    };
  }

  catalogMetas(
    profileId: number,
    catalogKind: "movie" | "series" | "anime",
    limit: number,
    skip: number,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; search?: string } = {},
  ): PersistedCatalogMeta[] {
    const serverFilter = mediaServerFilter("ce", options.ftpServerIds, options.includeLegacyNullServer);
    const catalogFilter =
      catalogKind === "movie"
        ? { sql: "and ce.meta_type = 'movie'", params: [] as string[] }
        : { sql: "and ce.catalog_kind = ? and ce.meta_type = 'series'", params: [catalogKind] };
    const searchFilter = catalogSearchFilter("ce", options.search);
    const rows = this.db
      .prepare(
        `
        select ce.meta_id, ce.meta_type, ce.meta_name, ce.poster, ce.background, ce.description, ce.release_info, min(ce.id) as first_id
        from catalog_enrichment ce
        where ce.profile_id = ?
          and ce.status = 'matched'
          and ce.meta_id is not null
          and ce.meta_name is not null
          ${catalogFilter.sql}
          ${serverFilter.sql}
          ${searchFilter.sql}
        group by ce.meta_id, ce.meta_type, ce.meta_name, ce.poster, ce.background, ce.description, ce.release_info
        order by ${searchFilter.orderSql} first_id asc
        limit ? offset ?
      `,
      )
      .all(profileId, ...catalogFilter.params, ...serverFilter.params, ...searchFilter.params, ...searchFilter.orderParams, limit, skip) as Array<{
      meta_id: string;
      meta_type: "movie" | "series";
      meta_name: string;
      poster: string | null;
      background: string | null;
      description: string | null;
      release_info: string | null;
    }>;
    return rows.map((row) => ({
      id: row.meta_id,
      type: row.meta_type,
      name: row.meta_name,
      poster: row.poster ?? undefined,
      background: row.background ?? undefined,
      description: row.description ?? undefined,
      releaseInfo: row.release_info ?? undefined,
    }));
  }

  otherCatalogItems(
    profileId: number,
    limit: number,
    skip: number,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; includeUnenrichedServerIds?: number[]; search?: string } = {},
  ): OtherCatalogItem[] {
    const serverFilter = mediaServerFilter("mf", options.ftpServerIds, options.includeLegacyNullServer);
    const unenrichedFilter = unenrichedOtherFilter("mf", options.includeUnenrichedServerIds);
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, mf.media_kind, mf.filename, mf.ftp_path, mf.parsed_title, mf.parsed_year
        from media_files mf
        left join catalog_enrichment ce
          on ce.profile_id = mf.profile_id
         and ce.ftp_server_id = mf.ftp_server_id
         and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
        where mf.profile_id = ?
          and mf.parsed_title is not null
          ${serverFilter.sql}
          and (ce.status = 'unmatched'${unenrichedFilter.sql})
        order by mf.filename asc, mf.id asc
      `,
      )
      .all(profileId, ...serverFilter.params, ...unenrichedFilter.params) as OtherCatalogRow[];

    const search = normalizedSearch(options.search);
    return Array.from(groupOtherCatalogRows(rows).values())
      .filter((item) => !search || item.searchText.includes(search))
      .sort((a, b) => a.folderName.localeCompare(b.folderName) || a.id - b.id)
      .slice(skip, skip + limit);
  }

  otherCatalogStreams(
    profileId: number,
    representativeFileId: number,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; includeUnenrichedServerIds?: number[] } = {},
  ): MediaMatch[] {
    const baseUnenrichedFilter = unenrichedOtherFilter("mf", options.includeUnenrichedServerIds);
    const base = this.db
      .prepare(
        `
        select mf.ftp_path, mf.filename, mf.media_kind
        from media_files mf
        left join catalog_enrichment ce
          on ce.profile_id = mf.profile_id
         and ce.ftp_server_id = mf.ftp_server_id
         and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
        where mf.profile_id = ?
          and mf.id = ?
          and (ce.status = 'unmatched'${baseUnenrichedFilter.sql})
      `,
      )
      .get(profileId, representativeFileId, ...baseUnenrichedFilter.params) as { ftp_path: string; filename: string; media_kind: "movie" | "series" } | undefined;
    if (!base) return [];

    const folderKey = otherFolderKey(base.ftp_path, base.filename);
    const serverFilter = mediaServerFilter("mf", options.ftpServerIds, options.includeLegacyNullServer);
    const unenrichedFilter = unenrichedOtherFilter("mf", options.includeUnenrichedServerIds);
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, s.name as server_name, s.stream_delivery_mode, mf.ftp_path, mf.filename, mf.quality, mf.size_bytes
        from media_files mf
        left join catalog_enrichment ce
          on ce.profile_id = mf.profile_id
         and ce.ftp_server_id = mf.ftp_server_id
         and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and mf.media_kind = ?
          ${serverFilter.sql}
          and (ce.status = 'unmatched'${unenrichedFilter.sql})
        order by s.name asc, mf.size_bytes desc, mf.filename asc
      `,
      )
      .all(profileId, base.media_kind, ...serverFilter.params, ...unenrichedFilter.params) as MediaFileRow[];
    return rows.filter((row) => otherFolderKey(row.ftp_path, row.filename) === folderKey).map(toMediaMatch);
  }

  otherCatalogItem(
    profileId: number,
    fileId: number,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; includeUnenrichedServerIds?: number[] } = {},
  ): OtherCatalogItem | null {
    const unenrichedFilter = unenrichedOtherFilter("mf", options.includeUnenrichedServerIds);
    const base = this.db
      .prepare(
        `
        select mf.id
        from media_files mf
        left join catalog_enrichment ce
          on ce.profile_id = mf.profile_id
         and ce.ftp_server_id = mf.ftp_server_id
         and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
        where mf.profile_id = ?
          and mf.id = ?
          and (ce.status = 'unmatched'${unenrichedFilter.sql})
      `,
      )
      .get(profileId, fileId, ...unenrichedFilter.params) as { id: number } | undefined;

    if (!base) return null;
    return this.otherCatalogItems(profileId, Number.MAX_SAFE_INTEGER, 0, options).find((item) => item.id === base.id) ?? null;
  }
}

type OtherCatalogRow = {
  id: number;
  ftp_server_id: number | null;
  media_kind: "movie" | "series";
  filename: string;
  ftp_path: string;
  parsed_title: string;
  parsed_year: number | null;
};

type OtherCatalogGroup = OtherCatalogItem & { searchText: string; serverIds: Set<string> };

function groupOtherCatalogRows(rows: OtherCatalogRow[]) {
  const groups = new Map<string, OtherCatalogGroup>();
  for (const row of rows) {
    const folderName = otherFolderName(row.ftp_path, row.filename, row.parsed_title);
    const folderKey = `${row.media_kind}:${normalizeFolderKey(folderName)}`;
    const existing = groups.get(folderKey);
    if (!existing) {
      groups.set(folderKey, {
        id: row.id,
        mediaKind: row.media_kind,
        folderName,
        folderKey,
        parsedTitle: row.parsed_title,
        parsedYear: row.parsed_year,
        fileCount: 1,
        serverCount: 1,
        searchText: otherSearchText(folderName, row),
        serverIds: new Set([String(row.ftp_server_id ?? "legacy")]),
      });
      continue;
    }
    existing.fileCount += 1;
    existing.serverIds.add(String(row.ftp_server_id ?? "legacy"));
    existing.serverCount = existing.serverIds.size;
    existing.searchText = `${existing.searchText} ${otherSearchText(folderName, row)}`;
    if (row.id < existing.id) existing.id = row.id;
  }
  for (const group of groups.values()) {
    delete (group as Partial<OtherCatalogGroup>).serverIds;
  }
  return groups;
}

function mediaServerFilter(alias: string, ftpServerIds: number[] | undefined, includeLegacyNullServer: boolean | undefined) {
  if (!ftpServerIds) return { sql: "", params: [] as number[] };
  const parts: string[] = [];
  const params: number[] = [];
  if (ftpServerIds.length) {
    parts.push(`${alias}.ftp_server_id in (${ftpServerIds.map(() => "?").join(", ")})`);
    params.push(...ftpServerIds);
  }
  if (includeLegacyNullServer) parts.push(`${alias}.ftp_server_id is null`);
  if (!parts.length) return { sql: "and 1 = 0", params };
  return { sql: `and (${parts.join(" or ")})`, params };
}

function unenrichedOtherFilter(alias: string, ftpServerIds: number[] | undefined) {
  if (!ftpServerIds?.length) return { sql: "", params: [] as number[] };
  return {
    sql: ` or ${alias}.ftp_server_id in (${ftpServerIds.map(() => "?").join(", ")})`,
    params: ftpServerIds,
  };
}

function catalogSearchFilter(alias: string, search: string | undefined) {
  const normalized = search?.trim().toLowerCase();
  if (!normalized) return { sql: "", params: [] as string[], orderSql: "", orderParams: [] as string[] };
  const like = `%${escapeLike(normalized)}%`;
  return {
    sql: `and lower(${alias}.meta_name) like ? escape '\\'`,
    params: [like],
    orderSql: `case when lower(${alias}.meta_name) = ? then 0 else 1 end, instr(lower(${alias}.meta_name), ?),`,
    orderParams: [normalized, normalized],
  };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function catalogEnrichmentKey(catalogKind: string, parsedTitle: string, parsedYear: number | null, imdbId: string | null) {
  return [catalogKind, imdbId ?? "", parsedTitle.toLowerCase(), parsedYear ?? ""].join("|");
}

function catalogEnrichmentSqlKey(alias: string) {
  return `${alias}.catalog_kind || '|' || coalesce(${alias}.imdb_id, '') || '|' || lower(${alias}.parsed_title) || '|' || coalesce(${alias}.parsed_year, '')`;
}

function otherFolderName(ftpPath: string, filename: string, fallbackTitle: string) {
  const normalizedPath = normalizeRootPath(ftpPath);
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length > 1) return titleCasePathSegment(segments[segments.length - 2]);
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[._-]+/g, " ").trim();
  return titleCasePathSegment(stem || fallbackTitle);
}

function otherFolderKey(ftpPath: string, filename: string) {
  const normalizedPath = normalizeRootPath(ftpPath);
  const segments = normalizedPath.split("/").filter(Boolean);
  const folder = segments.length > 1 ? segments[segments.length - 2] : filename.replace(/\.[^.]+$/, "");
  return normalizeFolderKey(folder);
}

function normalizeFolderKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function otherSearchText(folderName: string, row: OtherCatalogRow) {
  return normalizedSearch([folderName, row.filename, row.parsed_title, row.parsed_year ?? ""].join(" "));
}

function normalizedSearch(value: string | undefined) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleCasePathSegment(value: string) {
  return value
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeRootPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
