import type Database from "better-sqlite3";
import type { ParsedMedia } from "./parser.js";

const CATALOG_ENRICHMENT_ALGORITHM_VERSION = 6;

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
  sharedIndexGroupId?: number | null;
  source?: "profile" | "shared";
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
  status?: "pending" | "matched" | "unmatched" | "retry";
};

export type PersistedCatalogMeta = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
};

export type CatalogEnrichmentStats = {
  total: number;
  matched: number;
  unmatched: number;
  pending: number;
  retry: number;
};

export type OtherCatalogItem = {
  id: string;
  mediaKind: "movie" | "series";
  folderName: string;
  folderKey: string;
  parsedTitle: string;
  parsedYear: number | null;
  fileCount: number;
  serverCount: number;
};

export type OtherCatalogFileRef = number | { source: "shared"; serverId: number; id: number };

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
  shared_index_group_id?: number | null;
  source?: "profile" | "shared";
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
    sharedIndexGroupId: row.shared_index_group_id ?? null,
    source: row.source ?? "profile",
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

  upsertSharedParsedFile(sharedIndexGroupId: number, file: ParsedMediaFileInput) {
    const lastSeenAt = file.lastSeenAt ?? new Date().toISOString();
    this.db
      .prepare(
        `
        insert into shared_media_files (
          shared_index_group_id,
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
        on conflict(shared_index_group_id, ftp_path) do update set
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
        sharedIndexGroupId,
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

  deleteSharedStaleUnderRoot(sharedIndexGroupId: number, rootPath: string, seenSince: string) {
    const root = normalizeRootPath(rootPath);
    if (root === "/") {
      return this.db
        .prepare("delete from shared_media_files where shared_index_group_id = ? and last_seen_at < ?")
        .run(sharedIndexGroupId, seenSince).changes;
    }

    const rootWithSlash = `${root}/`;
    return this.db
      .prepare(
        `
        delete from shared_media_files
        where shared_index_group_id = ?
          and last_seen_at < ?
          and (ftp_path = ? or substr(ftp_path, 1, ?) = ?)
      `,
      )
      .run(sharedIndexGroupId, seenSince, root, rootWithSlash.length, rootWithSlash).changes;
  }

  findEpisode(profileId: number, normalizedTitle: string, season: number, episode: number): MediaMatch[] {
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, s.name as server_name, s.stream_delivery_mode, mf.ftp_path, mf.filename, mf.quality, mf.size_bytes
        from media_files mf
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and (mf.ftp_server_id is null or s.shared_index_group_id is null)
          and mf.media_kind = 'series'
          and mf.parsed_title = ?
          and mf.season = ?
          and mf.episode = ?
        order by s.name asc, mf.confidence desc, mf.size_bytes desc
      `,
      )
      .all(profileId, normalizedTitle, season, episode) as MediaFileRow[];
    return rows.map(toMediaMatch).concat(this.findSharedEpisode(profileId, normalizedTitle, season, episode));
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
          and (mf.ftp_server_id is null or s.shared_index_group_id is null)
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
    return rows.map(toMediaMatch).concat(this.findSharedMovie(profileId, imdbId, normalizedTitle, year));
  }

  private findSharedEpisode(profileId: number, normalizedTitle: string, season: number, episode: number): MediaMatch[] {
    const rows = this.db
      .prepare(
        `
        select sm.id, s.id as ftp_server_id, sm.shared_index_group_id, 'shared' as source,
               s.name as server_name, s.stream_delivery_mode, sm.ftp_path, sm.filename, sm.quality, sm.size_bytes
        from profile_ftp_servers s
        join shared_index_groups g on g.id = s.shared_index_group_id and g.enabled = 1
        join shared_media_files sm on sm.shared_index_group_id = g.id
        where s.profile_id = ?
          and sm.media_kind = 'series'
          and sm.parsed_title = ?
          and sm.season = ?
          and sm.episode = ?
        order by s.name asc, sm.confidence desc, sm.size_bytes desc
      `,
      )
      .all(profileId, normalizedTitle, season, episode) as MediaFileRow[];
    return rows.map(toMediaMatch);
  }

  private findSharedMovie(profileId: number, imdbId: string, normalizedTitle: string, year: number | null): MediaMatch[] {
    const rows = this.db
      .prepare(
        `
        select sm.id, s.id as ftp_server_id, sm.shared_index_group_id, 'shared' as source,
               s.name as server_name, s.stream_delivery_mode, sm.ftp_path, sm.filename, sm.quality, sm.size_bytes
        from profile_ftp_servers s
        join shared_index_groups g on g.id = s.shared_index_group_id and g.enabled = 1
        left join profile_ftp_servers master on master.id = g.master_profile_ftp_server_id
        join shared_media_files sm on sm.shared_index_group_id = g.id
        left join catalog_enrichment ce
          on ce.profile_id = master.profile_id
         and ce.ftp_server_id = master.id
         and ce.item_key = ${catalogEnrichmentSqlKey("sm")}
         and ce.status = 'matched'
        where s.profile_id = ?
          and sm.media_kind = 'movie'
          and (
            (sm.imdb_id is not null and sm.imdb_id = ?)
            or (
              sm.parsed_title = ?
              and (? is null or sm.parsed_year is null or sm.parsed_year = ?)
            )
            or (
              ce.meta_type = 'movie'
              and ce.meta_id = ?
            )
          )
        order by s.name asc, sm.confidence desc, sm.size_bytes desc
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

  getSharedFileForProfile(profileId: number, serverId: number, sharedMediaId: number): MediaMatch | null {
    const row = this.db
      .prepare(
        `
        select sm.id, s.id as ftp_server_id, sm.shared_index_group_id, 'shared' as source,
               s.name as server_name, s.stream_delivery_mode, sm.ftp_path, sm.filename, sm.quality, sm.size_bytes
        from profile_ftp_servers s
        join shared_index_groups g on g.id = s.shared_index_group_id and g.enabled = 1
        join shared_media_files sm on sm.shared_index_group_id = g.id
        where s.profile_id = ?
          and s.id = ?
          and sm.id = ?
      `,
      )
      .get(profileId, serverId, sharedMediaId) as MediaFileRow | undefined;
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

  countForSharedIndexGroup(sharedIndexGroupId: number): number {
    const row = this.db
      .prepare("select count(*) as count from shared_media_files where shared_index_group_id = ?")
      .get(sharedIndexGroupId) as { count: number };
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

  aggregateCountsForProfileWithSharedIndexes(profileId: number, sharedIndexGroupIds: number[]) {
    const uniqueSharedIndexGroupIds = [...new Set(sharedIndexGroupIds)].filter((id) => Number.isInteger(id) && id > 0);
    if (!uniqueSharedIndexGroupIds.length) return this.aggregateCountsForProfile(profileId);

    const placeholders = uniqueSharedIndexGroupIds.map(() => "?").join(", ");
    const totalRow = this.db
      .prepare(
        `
        select
          (
            select count(*)
            from media_files mf
            left join profile_ftp_servers s on s.id = mf.ftp_server_id
            where mf.profile_id = ?
              and (mf.ftp_server_id is null or s.shared_index_group_id is null)
          ) +
          (
            select count(*)
            from shared_media_files sm
            where sm.shared_index_group_id in (${placeholders})
          ) as total
      `,
      )
      .get(profileId, ...uniqueSharedIndexGroupIds) as { total: number };

    const enriched = this.catalogEnrichmentCountsForProfileWithSharedIndexes(profileId, uniqueSharedIndexGroupIds);
    const fallbackSharedIndexGroupIds = this.sharedIndexGroupIdsWithoutCatalogEnrichment(uniqueSharedIndexGroupIds);
    const raw = this.rawAggregateCountsForProfileWithSharedIndexes(profileId, fallbackSharedIndexGroupIds);

    return {
      total: totalRow.total,
      movies: enriched.movies + raw.movies,
      series: enriched.series + raw.series,
      anime: enriched.anime + raw.anime,
      uncategorized: enriched.uncategorized + raw.uncategorized,
    };
  }

  private catalogEnrichmentCountsForProfileWithSharedIndexes(profileId: number, sharedIndexGroupIds: number[]) {
    const placeholders = sharedIndexGroupIds.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `
        with local_keys as (
          select distinct mf.ftp_server_id, ${catalogEnrichmentSqlKey("mf")} as item_key
          from media_files mf
          left join profile_ftp_servers s on s.id = mf.ftp_server_id
          where mf.profile_id = ?
            and mf.parsed_title is not null
            and (mf.ftp_server_id is null or s.shared_index_group_id is null)
        ),
        shared_keys as (
          select distinct sm.shared_index_group_id, ${catalogEnrichmentSqlKey("sm")} as item_key
          from shared_media_files sm
          where sm.shared_index_group_id in (${placeholders})
            and sm.parsed_title is not null
        ),
        enriched_sources as (
          select ce.catalog_kind, ce.status, ce.meta_id, ce.item_key
          from catalog_enrichment ce
          join local_keys lk
            on lk.ftp_server_id = ce.ftp_server_id
           and lk.item_key = ce.item_key
          where ce.profile_id = ?
          union all
          select ce.catalog_kind, ce.status, ce.meta_id, ce.item_key
          from catalog_enrichment ce
          join shared_index_groups g on g.master_profile_ftp_server_id = ce.ftp_server_id
          join profile_ftp_servers master on master.id = g.master_profile_ftp_server_id and master.profile_id = ce.profile_id
          join shared_keys sk
            on sk.shared_index_group_id = g.id
           and sk.item_key = ce.item_key
          where g.id in (${placeholders})
        )
        select
          count(distinct case when status = 'matched' and catalog_kind = 'movie' then coalesce(meta_id, item_key) end) as movies,
          count(distinct case when status = 'matched' and catalog_kind = 'series' then coalesce(meta_id, item_key) end) as series,
          count(distinct case when status = 'matched' and catalog_kind = 'anime' then coalesce(meta_id, item_key) end) as anime,
          count(distinct case when status = 'unmatched' then item_key end) as uncategorized
        from enriched_sources
      `,
      )
      .get(profileId, ...sharedIndexGroupIds, profileId, ...sharedIndexGroupIds) as {
      movies: number | null;
      series: number | null;
      anime: number | null;
      uncategorized: number | null;
    };

    return {
      movies: row.movies ?? 0,
      series: row.series ?? 0,
      anime: row.anime ?? 0,
      uncategorized: row.uncategorized ?? 0,
    };
  }

  private rawAggregateCountsForProfileWithSharedIndexes(profileId: number, sharedIndexGroupIds: number[]) {
    const sources: string[] = [];
    const params: Array<number> = [];
    sources.push(`
      select
        mf.catalog_kind,
        mf.imdb_id,
        mf.parsed_title,
        mf.parsed_year,
        mf.confidence,
        case
          when mf.ftp_server_id is null then 1
          when s.catalog_enabled = 1 and (s.catalog_content_movies = 1 or s.catalog_content_series = 1 or s.catalog_content_anime = 1) then 1
          else 0
        end as counts_uncategorized
      from media_files mf
      left join profile_ftp_servers s on s.id = mf.ftp_server_id
      where mf.profile_id = ?
        and mf.parsed_title is not null
        and (mf.ftp_server_id is null or s.shared_index_group_id is null)
        and (
          mf.ftp_server_id is null
          or not exists (
            select 1
            from catalog_enrichment ce
            where ce.profile_id = mf.profile_id
              and ce.ftp_server_id = mf.ftp_server_id
          )
        )
    `);
    params.push(profileId);
    if (sharedIndexGroupIds.length) {
      sources.push(`
        select
          sm.catalog_kind,
          sm.imdb_id,
          sm.parsed_title,
          sm.parsed_year,
          sm.confidence,
          case
            when master.catalog_enabled = 1 and (master.catalog_content_movies = 1 or master.catalog_content_series = 1 or master.catalog_content_anime = 1) then 1
            else 0
          end as counts_uncategorized
        from shared_media_files sm
        join shared_index_groups g on g.id = sm.shared_index_group_id
        left join profile_ftp_servers master on master.id = g.master_profile_ftp_server_id
        where sm.shared_index_group_id in (${sharedIndexGroupIds.map(() => "?").join(", ")})
          and sm.parsed_title is not null
      `);
      params.push(...sharedIndexGroupIds);
    }

    const counts = this.db
      .prepare(
        `
        with library_files as (
          ${sources.join("\n          union all\n")}
        )
        select
          sum(case when category = 'movie' and is_categorized = 1 and needs_review = 0 then 1 else 0 end) as movies,
          sum(case when category = 'series' and is_categorized = 1 and needs_review = 0 then 1 else 0 end) as series,
          sum(case when category = 'anime' and is_categorized = 1 and needs_review = 0 then 1 else 0 end) as anime,
          sum(case when needs_review = 1 then 1 else 0 end) as uncategorized
        from (
          select
            catalog_kind as category,
            case
              when max(confidence) > 70 or max(case when imdb_id is not null then 1 else 0 end) = 1 then 1
              else 0
            end as is_categorized,
            case
              when max(counts_uncategorized) = 1 and max(confidence) <= 70 and max(case when imdb_id is not null then 1 else 0 end) = 0 then 1
              else 0
            end as needs_review
          from library_files
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
      .get(...params) as { movies: number | null; series: number | null; anime: number | null; uncategorized: number | null };

    return {
      movies: counts.movies ?? 0,
      series: counts.series ?? 0,
      anime: counts.anime ?? 0,
      uncategorized: counts.uncategorized ?? 0,
    };
  }

  private sharedIndexGroupIdsWithoutCatalogEnrichment(sharedIndexGroupIds: number[]) {
    if (!sharedIndexGroupIds.length) return [];
    const rows = this.db
      .prepare(
        `
        with shared_keys as (
          select distinct sm.shared_index_group_id, ${catalogEnrichmentSqlKey("sm")} as item_key
          from shared_media_files sm
          where sm.shared_index_group_id in (${sharedIndexGroupIds.map(() => "?").join(", ")})
            and sm.parsed_title is not null
        )
        select g.id
        from shared_index_groups g
        left join catalog_enrichment ce
          on ce.ftp_server_id = g.master_profile_ftp_server_id
         and ce.item_key in (select item_key from shared_keys where shared_index_group_id = g.id)
        where g.id in (${sharedIndexGroupIds.map(() => "?").join(", ")})
        group by g.id
        having count(ce.id) = 0
      `,
      )
      .all(...sharedIndexGroupIds, ...sharedIndexGroupIds) as Array<{ id: number }>;
    return rows.map((row) => row.id);
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

  sharedDirectorySnapshotMatchesModifiedAt(sharedIndexGroupId: number, dirPath: string, modifiedAt: string) {
    const row = this.db
      .prepare(
        `
        select id
        from shared_directory_snapshots
        where shared_index_group_id = ?
          and dir_path = ?
          and modified_at = ?
        limit 1
      `,
      )
      .get(sharedIndexGroupId, normalizeRootPath(dirPath), modifiedAt) as { id: number } | undefined;
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

  sharedDirectorySnapshotMatchesFingerprint(sharedIndexGroupId: number, dirPath: string, entryCount: number, fingerprint: string) {
    const row = this.db
      .prepare(
        `
        select id
        from shared_directory_snapshots
        where shared_index_group_id = ?
          and dir_path = ?
          and entry_count = ?
          and fingerprint = ?
        limit 1
      `,
      )
      .get(sharedIndexGroupId, normalizeRootPath(dirPath), entryCount, fingerprint) as { id: number } | undefined;
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

  saveSharedDirectorySnapshot(sharedIndexGroupId: number, snapshot: Omit<DirectorySnapshotInput, "ftpServerId">) {
    this.db
      .prepare(
        `
      insert into shared_directory_snapshots (
        shared_index_group_id,
        dir_path,
        entry_count,
        fingerprint,
        modified_at,
        last_seen_at
      ) values (?, ?, ?, ?, ?, ?)
      on conflict(shared_index_group_id, dir_path) do update set
        entry_count = excluded.entry_count,
        fingerprint = excluded.fingerprint,
        modified_at = excluded.modified_at,
        last_seen_at = excluded.last_seen_at
    `,
      )
      .run(
        sharedIndexGroupId,
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

  touchSharedDirectorySnapshot(sharedIndexGroupId: number, dirPath: string, lastSeenAt: string) {
    this.db
      .prepare(
        `
        update shared_directory_snapshots
        set last_seen_at = ?
        where shared_index_group_id = ?
          and dir_path = ?
      `,
      )
      .run(lastSeenAt, sharedIndexGroupId, normalizeRootPath(dirPath));
  }

  clearDirectorySnapshots(profileId: number, ftpServerId?: number | null) {
    return this.db
      .prepare("delete from scan_directory_snapshots where profile_id = ? and (? is null or ftp_server_id = ?)")
      .run(profileId, ftpServerId ?? null, ftpServerId ?? null).changes;
  }

  clearSharedDirectorySnapshots(sharedIndexGroupId: number) {
    return this.db.prepare("delete from shared_directory_snapshots where shared_index_group_id = ?").run(sharedIndexGroupId).changes;
  }

  countDirectorySnapshots(profileId: number, ftpServerId?: number | null) {
    const row = this.db
      .prepare("select count(*) as count from scan_directory_snapshots where profile_id = ? and (? is null or ftp_server_id = ?)")
      .get(profileId, ftpServerId ?? null, ftpServerId ?? null) as { count: number };
    return row.count;
  }

  countSharedDirectorySnapshots(sharedIndexGroupId: number) {
    const row = this.db
      .prepare("select count(*) as count from shared_directory_snapshots where shared_index_group_id = ?")
      .get(sharedIndexGroupId) as { count: number };
    return row.count;
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

  markSharedSeenUnderRoot(sharedIndexGroupId: number, rootPath: string, seenAt: string) {
    const root = normalizeRootPath(rootPath);
    if (root === "/") {
      return this.db
        .prepare("update shared_media_files set last_seen_at = ? where shared_index_group_id = ?")
        .run(seenAt, sharedIndexGroupId).changes;
    }

    const rootWithSlash = `${root}/`;
    return this.db
      .prepare(
        `
        update shared_media_files
        set last_seen_at = ?
        where shared_index_group_id = ?
          and (ftp_path = ? or substr(ftp_path, 1, ?) = ?)
      `,
      )
      .run(seenAt, sharedIndexGroupId, root, rootWithSlash.length, rootWithSlash).changes;
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

  sharedCatalogEnrichmentCandidates(
    sharedIndexGroupId: number,
    ftpServerId: number,
    catalogKinds: Array<"movie" | "series" | "anime">,
  ): CatalogEnrichmentCandidate[] {
    if (!catalogKinds.length) return [];
    const rows = this.db
      .prepare(
        `
        select
          min(sm.id) as id,
          sm.media_kind,
          sm.catalog_kind,
          sm.parsed_title,
          sm.parsed_year,
          sm.imdb_id,
          max(sm.confidence) as max_confidence
        from shared_media_files sm
        where sm.shared_index_group_id = ?
          and sm.catalog_kind in (${catalogKinds.map(() => "?").join(", ")})
          and sm.parsed_title is not null
        group by sm.media_kind, sm.catalog_kind, sm.parsed_title, sm.parsed_year, sm.imdb_id
        order by max_confidence desc, sm.parsed_title asc
      `,
      )
      .all(sharedIndexGroupId, ...catalogKinds) as Array<{
      id: number;
      media_kind: "movie" | "series";
      catalog_kind: "movie" | "series" | "anime";
      parsed_title: string;
      parsed_year: number | null;
      imdb_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      ftpServerId,
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
        algorithm_version = case
          when catalog_enrichment.status = 'matched'
            and catalog_enrichment.algorithm_version < excluded.algorithm_version
          then catalog_enrichment.algorithm_version
          else excluded.algorithm_version
        end,
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
        select id, ftp_server_id, item_key, media_kind, catalog_kind, parsed_title, parsed_year, source_imdb_id, status
        from catalog_enrichment
        where profile_id = ?
          and ftp_server_id = ?
          and (
            status = 'pending'
            or (status = 'retry' and (next_attempt_at is null or next_attempt_at <= ?))
            or (status = 'matched' and algorithm_version < ?)
          )
        order by updated_at asc, id asc
        limit ?
      `,
      )
      .all(profileId, ftpServerId, nowIso, CATALOG_ENRICHMENT_ALGORITHM_VERSION, limit) as Array<{
      id: number;
      ftp_server_id: number;
      item_key: string;
      media_kind: "movie" | "series";
      catalog_kind: "movie" | "series" | "anime";
      parsed_title: string;
      parsed_year: number | null;
      source_imdb_id: string | null;
      status: "pending" | "matched" | "unmatched" | "retry";
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
      status: row.status,
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
            genres = ?,
            algorithm_version = ?,
            attempts = attempts + 1,
            error = null,
            next_attempt_at = null,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        meta.id,
        meta.type,
        meta.name,
        meta.poster ?? null,
        meta.background ?? null,
        meta.description ?? null,
        meta.releaseInfo ?? null,
        genresJson(meta.genres),
        CATALOG_ENRICHMENT_ALGORITHM_VERSION,
        nowIso,
        enrichmentId,
      );
  }

  saveCatalogEnrichmentUnmatched(enrichmentId: number, nowIso: string) {
    this.db
      .prepare(
        `
        update catalog_enrichment
        set status = 'unmatched',
            meta_id = null,
            meta_type = null,
            meta_name = null,
            poster = null,
            background = null,
            description = null,
            release_info = null,
            genres = null,
            algorithm_version = ?,
            attempts = attempts + 1,
            error = null,
            next_attempt_at = null,
            updated_at = ?
        where id = ?
      `,
      )
      .run(CATALOG_ENRICHMENT_ALGORITHM_VERSION, nowIso, enrichmentId);
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
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; search?: string; genre?: string; metaType?: "movie" | "series" } = {},
  ): PersistedCatalogMeta[] {
    const localServerFilter = mediaServerFilter("ce", options.ftpServerIds, options.includeLegacyNullServer);
    const sharedServerFilter = profileServerFilter("linked", options.ftpServerIds);
    const catalogFilter = catalogMetaFilter(catalogKind, options.metaType);
    const searchFilter = catalogSearchFilter("entry", options.search);
    const searchOrder = catalogSearchOrder("catalog", options.search);
    const genreFilter = catalogGenreFilter("entry", options.genre);
    const rows = this.db
      .prepare(
        `
        with catalog_entries as (
          select
            ce.id as source_id,
            ce.ftp_server_id as server_id,
            case when local_server.catalog_sort = 'newest' then 'newest' else 'alphabetical' end as catalog_sort,
            max(julianday(mf.modified_at)) as modified_julian,
            ce.catalog_kind,
            ce.status,
            ce.meta_id,
            ce.meta_type,
            ce.meta_name,
            ce.poster,
            ce.background,
            ce.description,
            ce.release_info,
            ce.genres
          from catalog_enrichment ce
          join profile_ftp_servers local_server on local_server.id = ce.ftp_server_id
          join media_files mf
            on mf.profile_id = ce.profile_id
           and mf.ftp_server_id = ce.ftp_server_id
           and ${catalogEnrichmentSqlKey("mf")} = ce.item_key
          where ce.profile_id = ?
            and local_server.shared_index_group_id is null
            ${localServerFilter.sql}
          group by ce.id, ce.ftp_server_id, local_server.catalog_sort, ce.catalog_kind, ce.status, ce.meta_id, ce.meta_type,
                   ce.meta_name, ce.poster, ce.background, ce.description, ce.release_info, ce.genres
          union all
          select
            ce.id as source_id,
            linked.id as server_id,
            case when linked.catalog_sort = 'newest' then 'newest' else 'alphabetical' end as catalog_sort,
            max(julianday(sm.modified_at)) as modified_julian,
            ce.catalog_kind,
            ce.status,
            ce.meta_id,
            ce.meta_type,
            ce.meta_name,
            ce.poster,
            ce.background,
            ce.description,
            ce.release_info,
            ce.genres
          from profile_ftp_servers linked
          join shared_index_groups g on g.id = linked.shared_index_group_id and g.enabled = 1
          join profile_ftp_servers master on master.id = g.master_profile_ftp_server_id
          join shared_media_files sm on sm.shared_index_group_id = g.id
          join catalog_enrichment ce
            on ce.profile_id = master.profile_id
           and ce.ftp_server_id = master.id
           and ce.item_key = ${catalogEnrichmentSqlKey("sm")}
          where linked.profile_id = ?
            ${sharedServerFilter.sql}
          group by linked.id, linked.catalog_sort, ce.id, ce.catalog_kind, ce.status, ce.meta_id, ce.meta_type,
                   ce.meta_name, ce.poster, ce.background, ce.description, ce.release_info, ce.genres
        ),
        filtered_entries as (
          select *
          from catalog_entries entry
          where entry.status = 'matched'
            and entry.meta_id is not null
            and entry.meta_name is not null
            ${catalogFilter.sql}
            ${searchFilter.sql}
            ${genreFilter.sql}
        ),
        grouped_catalog as (
          select
            entry.meta_id,
            entry.meta_type,
            min(entry.meta_name) as meta_name,
            max(entry.poster) as poster,
            max(entry.background) as background,
            max(entry.description) as description,
            max(entry.release_info) as release_info,
            max(entry.genres) as genres,
            min(entry.source_id) as first_id,
            max(case when entry.catalog_sort = 'newest' then 1 else 0 end) as has_newest,
            max(case when entry.catalog_sort = 'newest' then entry.modified_julian end) as newest_modified_julian
          from filtered_entries entry
          group by entry.meta_id, entry.meta_type
        )
        select
          catalog.meta_id,
          catalog.meta_type,
          catalog.meta_name,
          catalog.poster,
          catalog.background,
          catalog.description,
          catalog.release_info,
          catalog.genres
        from grouped_catalog catalog
        order by ${searchOrder.sql}
                 catalog.has_newest desc,
                 case
                   when catalog.has_newest = 1 and catalog.newest_modified_julian is not null then 0
                   when catalog.has_newest = 1 then 1
                   else 2
                 end asc,
                 catalog.newest_modified_julian desc,
                 lower(catalog.meta_name) collate nocase asc,
                 catalog.meta_id asc
        limit ? offset ?
      `,
      )
      .all(
        profileId,
        ...localServerFilter.params,
        profileId,
        ...sharedServerFilter.params,
        ...catalogFilter.params,
        ...searchFilter.params,
        ...genreFilter.params,
        ...searchOrder.params,
        limit,
        skip,
      ) as Array<{
      meta_id: string;
      meta_type: "movie" | "series";
      meta_name: string;
      poster: string | null;
      background: string | null;
      description: string | null;
      release_info: string | null;
      genres: string | null;
    }>;
    return rows.map((row) => ({
      id: row.meta_id,
      type: row.meta_type,
      name: row.meta_name,
      poster: row.poster ?? undefined,
      background: row.background ?? undefined,
      description: row.description ?? undefined,
      releaseInfo: row.release_info ?? undefined,
      genres: parseGenres(row.genres),
    }));
  }

  otherCatalogItems(
    profileId: number,
    limit: number,
    skip: number,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; includeUnenrichedServerIds?: number[]; search?: string } = {},
  ): OtherCatalogItem[] {
    const localServerFilter = mediaServerFilter("mf", options.ftpServerIds, options.includeLegacyNullServer);
    const sharedServerFilter = profileServerFilter("linked", options.ftpServerIds);
    const localUnenrichedFilter = unenrichedOtherFilter("mf", options.includeUnenrichedServerIds);
    const sharedUnenrichedFilter = unenrichedProfileServerFilter("linked", options.includeUnenrichedServerIds);
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, 'profile' as source, mf.media_kind, mf.filename, mf.ftp_path, mf.parsed_title, mf.parsed_year,
               mf.modified_at, case when local_server.catalog_sort = 'newest' then 'newest' else 'alphabetical' end as catalog_sort
        from media_files mf
        left join profile_ftp_servers local_server on local_server.id = mf.ftp_server_id
        left join catalog_enrichment ce
          on ce.profile_id = mf.profile_id
         and ce.ftp_server_id = mf.ftp_server_id
         and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
        where mf.profile_id = ?
          and (mf.ftp_server_id is null or local_server.shared_index_group_id is null)
          and mf.parsed_title is not null
          ${localServerFilter.sql}
          and (ce.status = 'unmatched'${localUnenrichedFilter.sql})
        union all
        select sm.id, linked.id as ftp_server_id, 'shared' as source, sm.media_kind, sm.filename, sm.ftp_path, sm.parsed_title, sm.parsed_year,
               sm.modified_at, case when linked.catalog_sort = 'newest' then 'newest' else 'alphabetical' end as catalog_sort
        from profile_ftp_servers linked
        join shared_index_groups g on g.id = linked.shared_index_group_id and g.enabled = 1
        join profile_ftp_servers master on master.id = g.master_profile_ftp_server_id
        join shared_media_files sm on sm.shared_index_group_id = g.id
        left join catalog_enrichment ce
          on ce.profile_id = master.profile_id
         and ce.ftp_server_id = master.id
         and ce.item_key = ${catalogEnrichmentSqlKey("sm")}
        where linked.profile_id = ?
          and sm.parsed_title is not null
          ${sharedServerFilter.sql}
          and (ce.status = 'unmatched'${sharedUnenrichedFilter.sql})
        order by 5 asc, 1 asc
      `,
      )
      .all(
        profileId,
        ...localServerFilter.params,
        ...localUnenrichedFilter.params,
        profileId,
        ...sharedServerFilter.params,
        ...sharedUnenrichedFilter.params,
      ) as OtherCatalogRow[];

    const search = normalizedSearch(options.search);
    return Array.from(groupOtherCatalogRows(rows).values())
      .filter((item) => !search || item.searchText.includes(search))
      .sort(compareOtherCatalogGroups)
      .slice(skip, skip + limit);
  }

  otherCatalogStreams(
    profileId: number,
    representativeFile: OtherCatalogFileRef,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; includeUnenrichedServerIds?: number[]; scopeToRepresentativeServer?: boolean } = {},
  ): MediaMatch[] {
    const base = this.otherCatalogBaseRow(profileId, representativeFile, options.includeUnenrichedServerIds);
    if (!base) return [];

    const folderKey = otherFolderKey(base.ftp_path, base.filename);
    const scopedFtpServerIds = options.scopeToRepresentativeServer && base.ftp_server_id !== null ? [base.ftp_server_id] : options.ftpServerIds;
    const includeScopedLegacy = options.scopeToRepresentativeServer ? base.ftp_server_id === null : options.includeLegacyNullServer;
    const localServerFilter = options.scopeToRepresentativeServer
      ? mediaServerFilter("mf", scopedFtpServerIds ?? [], includeScopedLegacy)
      : mediaServerFilter("mf", options.ftpServerIds, options.includeLegacyNullServer);
    const sharedServerFilter = profileServerFilter("linked", scopedFtpServerIds);
    const localUnenrichedFilter = unenrichedOtherFilter("mf", options.includeUnenrichedServerIds);
    const sharedUnenrichedFilter = unenrichedProfileServerFilter("linked", options.includeUnenrichedServerIds);
    const rows = this.db
      .prepare(
        `
        select mf.id, mf.ftp_server_id, null as shared_index_group_id, 'profile' as source,
               s.name as server_name, s.stream_delivery_mode, mf.ftp_path, mf.filename, mf.quality, mf.size_bytes
        from media_files mf
        left join profile_ftp_servers local_server on local_server.id = mf.ftp_server_id
        left join catalog_enrichment ce
          on ce.profile_id = mf.profile_id
         and ce.ftp_server_id = mf.ftp_server_id
         and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
        left join profile_ftp_servers s on s.id = mf.ftp_server_id
        where mf.profile_id = ?
          and (mf.ftp_server_id is null or local_server.shared_index_group_id is null)
          and mf.media_kind = ?
          ${localServerFilter.sql}
          and (ce.status = 'unmatched'${localUnenrichedFilter.sql})
        union all
        select sm.id, linked.id as ftp_server_id, sm.shared_index_group_id, 'shared' as source,
               linked.name as server_name, linked.stream_delivery_mode, sm.ftp_path, sm.filename, sm.quality, sm.size_bytes
        from profile_ftp_servers linked
        join shared_index_groups g on g.id = linked.shared_index_group_id and g.enabled = 1
        join profile_ftp_servers master on master.id = g.master_profile_ftp_server_id
        join shared_media_files sm on sm.shared_index_group_id = g.id
        left join catalog_enrichment ce
          on ce.profile_id = master.profile_id
         and ce.ftp_server_id = master.id
         and ce.item_key = ${catalogEnrichmentSqlKey("sm")}
        where linked.profile_id = ?
          and sm.media_kind = ?
          ${sharedServerFilter.sql}
          and (ce.status = 'unmatched'${sharedUnenrichedFilter.sql})
        order by 5 asc, 10 desc, 8 asc
      `,
      )
      .all(
        profileId,
        base.media_kind,
        ...localServerFilter.params,
        ...localUnenrichedFilter.params,
        profileId,
        base.media_kind,
        ...sharedServerFilter.params,
        ...sharedUnenrichedFilter.params,
      ) as MediaFileRow[];
    return rows.filter((row) => otherFolderKey(row.ftp_path, row.filename) === folderKey).map(toMediaMatch);
  }

  otherCatalogItem(
    profileId: number,
    representativeFile: OtherCatalogFileRef,
    options: { ftpServerIds?: number[]; includeLegacyNullServer?: boolean; includeUnenrichedServerIds?: number[]; scopeToRepresentativeServer?: boolean } = {},
  ): OtherCatalogItem | null {
    const base = this.otherCatalogBaseRow(profileId, representativeFile, options.includeUnenrichedServerIds);
    if (!base) return null;
    const scopedOptions = options.scopeToRepresentativeServer
      ? {
          ...options,
          ftpServerIds: base.ftp_server_id === null ? [] : [base.ftp_server_id],
          includeLegacyNullServer: base.ftp_server_id === null,
        }
      : options;
    return this.otherCatalogItems(profileId, Number.MAX_SAFE_INTEGER, 0, scopedOptions).find((item) => item.id === otherCatalogRowId(base)) ?? null;
  }

  private otherCatalogBaseRow(profileId: number, representativeFile: OtherCatalogFileRef, includeUnenrichedServerIds?: number[]) {
    if (typeof representativeFile === "number") {
      const unenrichedFilter = unenrichedOtherFilter("mf", includeUnenrichedServerIds);
      return this.db
        .prepare(
          `
          select mf.id, mf.ftp_server_id, 'profile' as source, mf.ftp_path, mf.filename, mf.media_kind
          from media_files mf
          left join profile_ftp_servers local_server on local_server.id = mf.ftp_server_id
          left join catalog_enrichment ce
            on ce.profile_id = mf.profile_id
           and ce.ftp_server_id = mf.ftp_server_id
           and ce.item_key = ${catalogEnrichmentSqlKey("mf")}
          where mf.profile_id = ?
            and mf.id = ?
            and (mf.ftp_server_id is null or local_server.shared_index_group_id is null)
            and (ce.status = 'unmatched'${unenrichedFilter.sql})
        `,
        )
        .get(profileId, representativeFile, ...unenrichedFilter.params) as OtherCatalogBaseRow | undefined;
    }

    const unenrichedFilter = unenrichedProfileServerFilter("linked", includeUnenrichedServerIds);
    return this.db
      .prepare(
        `
        select sm.id, linked.id as ftp_server_id, 'shared' as source, sm.ftp_path, sm.filename, sm.media_kind
        from profile_ftp_servers linked
        join shared_index_groups g on g.id = linked.shared_index_group_id and g.enabled = 1
        join profile_ftp_servers master on master.id = g.master_profile_ftp_server_id
        join shared_media_files sm on sm.shared_index_group_id = g.id
        left join catalog_enrichment ce
          on ce.profile_id = master.profile_id
         and ce.ftp_server_id = master.id
         and ce.item_key = ${catalogEnrichmentSqlKey("sm")}
        where linked.profile_id = ?
          and linked.id = ?
          and sm.id = ?
          and (ce.status = 'unmatched'${unenrichedFilter.sql})
      `,
      )
      .get(profileId, representativeFile.serverId, representativeFile.id, ...unenrichedFilter.params) as OtherCatalogBaseRow | undefined;
  }
}

type OtherCatalogRow = {
  id: number;
  ftp_server_id: number | null;
  source?: "profile" | "shared";
  media_kind: "movie" | "series";
  filename: string;
  ftp_path: string;
  parsed_title: string;
  parsed_year: number | null;
  modified_at: string | null;
  catalog_sort: "alphabetical" | "newest";
};

type OtherCatalogBaseRow = Pick<OtherCatalogRow, "id" | "ftp_server_id" | "source" | "ftp_path" | "filename" | "media_kind">;

type OtherCatalogGroup = OtherCatalogItem & {
  searchText: string;
  serverIds: Set<string>;
  sortKey: string;
  hasNewestContribution: boolean;
  newestModifiedAtMs: number | null;
};

function groupOtherCatalogRows(rows: OtherCatalogRow[]) {
  const groups = new Map<string, OtherCatalogGroup>();
  for (const row of rows) {
    const folderName = otherFolderName(row.ftp_path, row.filename, row.parsed_title);
    const folderKey = `${row.media_kind}:${normalizeFolderKey(folderName)}`;
    const newestModifiedAtMs = row.catalog_sort === "newest" ? validTimestampMs(row.modified_at) : null;
    const existing = groups.get(folderKey);
    if (!existing) {
      groups.set(folderKey, {
        id: otherCatalogRowId(row),
        mediaKind: row.media_kind,
        folderName,
        folderKey,
        parsedTitle: row.parsed_title,
        parsedYear: row.parsed_year,
        fileCount: 1,
        serverCount: 1,
        searchText: otherSearchText(folderName, row),
        serverIds: new Set([String(row.ftp_server_id ?? "legacy")]),
        sortKey: otherCatalogSortKey(row),
        hasNewestContribution: row.catalog_sort === "newest",
        newestModifiedAtMs,
      });
      continue;
    }
    existing.fileCount += 1;
    existing.serverIds.add(String(row.ftp_server_id ?? "legacy"));
    existing.serverCount = existing.serverIds.size;
    existing.searchText = `${existing.searchText} ${otherSearchText(folderName, row)}`;
    if (row.catalog_sort === "newest") {
      existing.hasNewestContribution = true;
      if (newestModifiedAtMs !== null && (existing.newestModifiedAtMs === null || newestModifiedAtMs > existing.newestModifiedAtMs)) {
        existing.newestModifiedAtMs = newestModifiedAtMs;
      }
    }
    const sortKey = otherCatalogSortKey(row);
    if (sortKey < existing.sortKey) {
      existing.id = otherCatalogRowId(row);
      existing.sortKey = sortKey;
    }
  }
  for (const group of groups.values()) {
    delete (group as Partial<OtherCatalogGroup>).serverIds;
  }
  return groups;
}

function compareOtherCatalogGroups(a: OtherCatalogGroup, b: OtherCatalogGroup) {
  if (a.hasNewestContribution !== b.hasNewestContribution) return a.hasNewestContribution ? -1 : 1;
  if (a.hasNewestContribution && b.hasNewestContribution) {
    const aDated = a.newestModifiedAtMs !== null;
    const bDated = b.newestModifiedAtMs !== null;
    if (aDated !== bDated) return aDated ? -1 : 1;
    if (a.newestModifiedAtMs !== b.newestModifiedAtMs) return (b.newestModifiedAtMs ?? 0) - (a.newestModifiedAtMs ?? 0);
  }
  return a.folderName.localeCompare(b.folderName) || a.sortKey.localeCompare(b.sortKey);
}

function validTimestampMs(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function otherCatalogRowId(row: Pick<OtherCatalogRow, "id" | "ftp_server_id" | "source">) {
  return row.source === "shared" ? `shared:${row.ftp_server_id}:${row.id}` : String(row.id);
}

function otherCatalogSortKey(row: Pick<OtherCatalogRow, "id" | "ftp_server_id" | "source">) {
  return `${row.source ?? "profile"}:${row.ftp_server_id ?? 0}:${row.id}`;
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

function profileServerFilter(alias: string, ftpServerIds: number[] | undefined) {
  if (!ftpServerIds) return { sql: "", params: [] as number[] };
  if (!ftpServerIds.length) return { sql: "and 1 = 0", params: [] as number[] };
  return {
    sql: `and ${alias}.id in (${ftpServerIds.map(() => "?").join(", ")})`,
    params: ftpServerIds,
  };
}

function catalogMetaFilter(catalogKind: "movie" | "series" | "anime", metaType: "movie" | "series" | undefined) {
  if (catalogKind === "anime") {
    return { sql: "and entry.catalog_kind = 'anime' and entry.meta_type = ?", params: [metaType ?? "series"] };
  }
  if (catalogKind === "movie") {
    return { sql: "and entry.meta_type = 'movie' and entry.catalog_kind != 'anime'", params: [] as string[] };
  }
  return { sql: "and entry.catalog_kind = ? and entry.meta_type = 'series'", params: [catalogKind] };
}

function unenrichedOtherFilter(alias: string, ftpServerIds: number[] | undefined) {
  if (!ftpServerIds?.length) return { sql: "", params: [] as number[] };
  return {
    sql: ` or ${alias}.ftp_server_id in (${ftpServerIds.map(() => "?").join(", ")})`,
    params: ftpServerIds,
  };
}

function unenrichedProfileServerFilter(alias: string, ftpServerIds: number[] | undefined) {
  if (!ftpServerIds?.length) return { sql: "", params: [] as number[] };
  return {
    sql: ` or ${alias}.id in (${ftpServerIds.map(() => "?").join(", ")})`,
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

function catalogSearchOrder(alias: string, search: string | undefined) {
  const normalized = search?.trim().toLowerCase();
  if (!normalized) return { sql: "", params: [] as string[] };
  return {
    sql: `case when lower(${alias}.meta_name) = ? then 0 else 1 end, instr(lower(${alias}.meta_name), ?),`,
    params: [normalized, normalized],
  };
}

function catalogGenreFilter(alias: string, genre: string | undefined) {
  const normalized = genre?.trim().toLowerCase();
  if (!normalized) return { sql: "", params: [] as string[] };
  return {
    sql: `and lower(coalesce(${alias}.genres, '')) like ? escape '\\'`,
    params: [`%"${escapeLike(normalized)}"%`],
  };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function genresJson(genres: string[] | undefined) {
  const normalized = Array.from(new Set((genres ?? []).map((genre) => genre.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  return normalized.length ? JSON.stringify(normalized) : null;
}

function parseGenres(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const genres = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return genres.length ? genres : undefined;
  } catch {
    return undefined;
  }
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
