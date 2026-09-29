import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";
import { parseMediaPath, PARSER_VERSION } from "../src/server/media/parser";

let profileSequence = 0;

function createProfile(db: Database.Database) {
  profileSequence += 1;
  return Number(
    db
      .prepare(
        "insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at) values (?, 'v', ?, 'n', 'n')",
      )
      .run(`uid-${profileSequence}`, `h-${profileSequence}`).lastInsertRowid,
  );
}

function createServer(
  db: Database.Database,
  profileId: number,
  options: { catalogEnabled?: boolean; movies?: boolean; series?: boolean; anime?: boolean; catalogSort?: "alphabetical" | "newest" } = {},
) {
  return Number(
    db
      .prepare(
        `
        insert into profile_ftp_servers (
          profile_id, name, catalog_enabled, catalog_content_movies, catalog_content_series,
          catalog_content_anime, catalog_sort, library_layout, stream_delivery_mode, created_at, updated_at
        ) values (?, 'Server 1', ?, ?, ?, ?, ?, 'auto', 'proxy', 'n', 'n')
      `,
      )
      .run(
        profileId,
        options.catalogEnabled === false ? 0 : 1,
        options.movies === false ? 0 : 1,
        options.series === false ? 0 : 1,
        options.anime === true ? 1 : 0,
        options.catalogSort ?? "alphabetical",
      ).lastInsertRowid,
  );
}

function createSharedGroup(db: Database.Database, serverId: number, suffix: string) {
  const groupId = Number(
    db
      .prepare(
        `
        insert into shared_index_groups (
          key_hint, name, shared_index_key_hash, host, port, tls_mode, allow_invalid_certificate,
          root_paths_json, library_layout, catalog_content_json, enabled, auto_link_imports,
          master_profile_ftp_server_id, created_at, updated_at
        ) values (?, ?, ?, 'ftp.example.test', 21, 'none', 0, '["/"]', 'auto', ?, 1, 1, ?, 'n', 'n')
      `,
      )
      .run(`shared-${suffix}`, `Shared ${suffix}`, `hash-${suffix}`, JSON.stringify({ movies: true, series: true, anime: true, uncategorized: true }), serverId)
      .lastInsertRowid,
  );
  db.prepare("update profile_ftp_servers set shared_index_group_id = ? where id = ?").run(groupId, serverId);
  return groupId;
}

describe("MediaRepository", () => {
  it("reparses old profile and shared rows from stored paths once without deleting files", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const groupId = createSharedGroup(db, serverId, "reparse");
    db.prepare("update profile_ftp_servers set library_layout = 'folders' where id = ?").run(serverId);
    db.prepare("update shared_index_groups set library_layout = 'folders' where id = ?").run(groupId);
    const repo = new MediaRepository(db);
    const profilePath = "/TV Shows/The Mandalorian (2019)/MandoS1E1.1080p.mkv";
    const sharedPath = "/Movies/Avatar (2025)/Avatar FS3D 1920x1080.mkv";
    repo.upsertParsedFile(profileId, { ...parseMediaPath(profilePath)!, ftpServerId: serverId });
    repo.upsertSharedParsedFile(groupId, parseMediaPath(sharedPath)!);
    db.prepare("update media_files set parser_version = 0, media_kind = 'movie', parsed_title = 'mando', season = null, episode = null").run();
    db.prepare("update shared_media_files set parser_version = 0, parsed_year = 1920").run();

    expect(repo.reparseOutdatedBatch(1)).toBe(1);
    expect(repo.reparseOutdatedBatch(1)).toBe(1);
    expect(repo.reparseOutdatedBatch(1)).toBe(0);
    expect(db.prepare("select media_kind, parsed_title, season, episode, parser_version from media_files").get()).toMatchObject({
      media_kind: "series", parsed_title: "mandalorian", season: 1, episode: 1, parser_version: PARSER_VERSION,
    });
    expect(db.prepare("select parsed_year, parser_version from shared_media_files").get()).toMatchObject({ parsed_year: 2025, parser_version: PARSER_VERSION });
    expect(db.prepare("select count(*) as count from media_files").get()).toEqual({ count: 1 });
    expect(db.prepare("select count(*) as count from shared_media_files").get()).toEqual({ count: 1 });
  });

  it("stamps an unmatched item after one algorithm recheck while preserving a prior match if recheck finds none", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const repo = new MediaRepository(db);
    const candidates = ["lost movie", "known movie"].map((parsedTitle, id) => ({ id: id + 1, ftpServerId: serverId, itemKey: parsedTitle, mediaKind: "movie" as const, catalogKind: "movie" as const, parsedTitle, parsedYear: 2020, imdbId: null }));
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, candidates, "2026-01-01");
    const initial = repo.pendingCatalogEnrichment(profileId, serverId, "2026-01-01", 10);
    repo.saveCatalogEnrichmentUnmatched(initial[0].id, "2026-01-01");
    repo.saveCatalogEnrichmentMatch(initial[1].id, { id: "tt1111111", type: "movie", name: "Known Movie" }, "2026-01-01");
    db.prepare("update catalog_enrichment set algorithm_version = 6").run();
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, candidates, "2026-01-02");
    const pending = repo.pendingCatalogEnrichment(profileId, serverId, "2026-01-02", 10);
    expect(pending.map((row) => row.parsedTitle).sort()).toEqual(["known movie", "lost movie"]);
    for (const row of pending) repo.saveCatalogEnrichmentUnmatched(row.id, "2026-01-02");
    expect(repo.pendingCatalogEnrichment(profileId, serverId, "2026-01-02", 10)).toEqual([]);
    expect(db.prepare("select status, meta_id from catalog_enrichment where parsed_title = 'known movie'").get()).toEqual({ status: "matched", meta_id: "tt1111111" });
  });

  it("keeps a filename title alternative through the enrichment queue", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    db.prepare("update profile_ftp_servers set library_layout = 'folders' where id = ?").run(serverId);
    const repo = new MediaRepository(db);
    const path = "/Movies/Novacaine (2025)/Novocaine.2025.mkv";
    repo.upsertParsedFile(profileId, { ...parseMediaPath(path, { libraryLayout: "folders" })!, ftpServerId: serverId });
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.catalogEnrichmentCandidates(profileId, serverId, ["movie"]), "2026-01-01");
    expect(repo.pendingCatalogEnrichment(profileId, serverId, "2026-01-01", 10)[0]).toMatchObject({ alternateTitle: "novocaine", alternateYear: 2025 });
  });
  it("upserts and queries episode rows", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);

    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Show.Name.S02E05.1080p.mkv",
      filename: "Show.Name.S02E05.1080p.mkv",
      normalizedFilename: "show name s02e05 1080p",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "show name",
      parsedYear: null,
      season: 2,
      episode: 5,
      imdbId: null,
      quality: "1080p",
      confidence: 95,
    });

    expect(repo.findEpisode(profileId, "show name", 2, 5)).toHaveLength(1);
  });

  it("updates an existing file row on upsert", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);

    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Show.Name.S02E05.mkv",
      filename: "Show.Name.S02E05.mkv",
      normalizedFilename: "show name s02e05",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "show name",
      parsedYear: null,
      season: 2,
      episode: 5,
      imdbId: null,
      quality: "720p",
      confidence: 80,
      sizeBytes: 1000,
      lastSeenAt: "2026-05-02T00:00:00.000Z",
    });

    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Show.Name.S02E05.mkv",
      filename: "Show.Name.S02E05.mkv",
      normalizedFilename: "show name s02e05",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "show name",
      parsedYear: null,
      season: 2,
      episode: 5,
      imdbId: null,
      quality: "1080p",
      confidence: 95,
      sizeBytes: 2000,
      lastSeenAt: "2026-05-02T01:00:00.000Z",
    });

    expect(repo.findEpisode(profileId, "show name", 2, 5)).toEqual([
      expect.objectContaining({ filename: "Show.Name.S02E05.mkv", quality: "1080p", sizeBytes: 2000 }),
    ]);
  });

  it("orders movie matches by confidence and size", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);

    for (const file of [
      { ftpPath: "/Movies/Show.Name.2020.small.mkv", confidence: 90, sizeBytes: 1000 },
      { ftpPath: "/Movies/Show.Name.2020.large.mkv", confidence: 90, sizeBytes: 2000 },
      { ftpPath: "/Movies/Show.Name.2020.low.mkv", confidence: 70, sizeBytes: 5000 },
    ]) {
      repo.upsertParsedFile(profileId, {
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: "show name 2020",
        extension: "mkv",
        mediaKind: "movie",
        parsedTitle: "show name",
        parsedYear: 2020,
        season: null,
        episode: null,
        imdbId: "tt1234567",
        quality: "1080p",
        confidence: file.confidence,
        sizeBytes: file.sizeBytes,
      });
    }

    expect(repo.findMovie(profileId, "tt1234567", "show name", 2020).map((match) => match.ftpPath)).toEqual([
      "/Movies/Show.Name.2020.large.mkv",
      "/Movies/Show.Name.2020.small.mkv",
      "/Movies/Show.Name.2020.low.mkv",
    ]);
  });

  it("aggregates unique catalog counts and parser-review catalog entries", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);

    for (const file of [
      { ftpPath: "/Movies/The.Matrix.1999.1080p.mkv", mediaKind: "movie", catalogKind: "movie", title: "matrix", year: 1999, imdbId: "tt0133093" },
      { ftpPath: "/Movies/The.Matrix.1999.2160p.mkv", mediaKind: "movie", catalogKind: "movie", title: "matrix", year: 1999, imdbId: "tt0133093" },
      { ftpPath: "/TV/Show.Name.S01E01.mkv", mediaKind: "series", catalogKind: "series", title: "show name", year: null, imdbId: "tt7654321" },
      { ftpPath: "/TV/Show.Name.S01E02.mkv", mediaKind: "series", catalogKind: "series", title: "show name", year: null, imdbId: "tt7654321" },
      { ftpPath: "/Anime/Afro.Samurai.01.mkv", mediaKind: "series", catalogKind: "anime", title: "afro samurai", year: null, imdbId: null },
      { ftpPath: "/Other/Mystery.File.2020.mkv", mediaKind: "movie", catalogKind: "movie", title: "mystery file", year: 2020, imdbId: null, confidence: 70 },
      { ftpPath: "/Other/Unknown.Clip.mkv", mediaKind: "movie", catalogKind: "movie", title: "unknown clip", year: null, imdbId: null, confidence: 45 },
    ] as const) {
      repo.upsertParsedFile(profileId, {
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: file.title,
        extension: "mkv",
        mediaKind: file.mediaKind,
        catalogKind: file.catalogKind,
        parsedTitle: file.title,
        parsedYear: file.year,
        season: file.mediaKind === "series" ? 1 : null,
        episode: file.mediaKind === "series" ? (file.ftpPath.includes("E02") ? 2 : 1) : null,
        imdbId: file.imdbId,
        quality: null,
        confidence: file.confidence ?? 90,
      });
    }

    expect(repo.aggregateCountsForProfile(profileId)).toEqual({
      total: 7,
      movies: 1,
      series: 1,
      anime: 1,
      uncategorized: 2,
    });
  });

  it("uses persisted enrichment state for catalog and uncategorized counts when available", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const repo = new MediaRepository(db);

    for (const file of [
      { ftpPath: "/Movies/The.Matrix.1999.mkv", title: "matrix", year: 1999 },
      { ftpPath: "/Other/Home.Video.2024.mp4", title: "home video", year: 2024 },
    ]) {
      repo.upsertParsedFile(profileId, {
        ftpServerId: serverId,
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: file.title,
        extension: file.ftpPath.endsWith(".mp4") ? "mp4" : "mkv",
        mediaKind: "movie",
        catalogKind: "movie",
        parsedTitle: file.title,
        parsedYear: file.year,
        season: null,
        episode: null,
        imdbId: null,
        quality: null,
        confidence: 70,
      });
    }

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.catalogEnrichmentCandidates(profileId, serverId, ["movie"]), seenAt);
    const pending = repo.pendingCatalogEnrichment(profileId, serverId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(pending.find((item) => item.parsedTitle === "matrix")!.id, { id: "tt0133093", type: "movie", name: "The Matrix" }, seenAt);
    repo.saveCatalogEnrichmentUnmatched(pending.find((item) => item.parsedTitle === "home video")!.id, seenAt);

    expect(repo.aggregateCountsForProfile(profileId)).toEqual({
      total: 2,
      movies: 1,
      series: 0,
      anime: 0,
      uncategorized: 1,
    });

    db.prepare("update catalog_enrichment set algorithm_version = 1, genres = '[\"Drama\"]' where status = 'matched'").run();
    db.prepare("update catalog_enrichment set algorithm_version = 1 where status <> 'matched'").run();
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.catalogEnrichmentCandidates(profileId, serverId, ["movie"]), "2026-05-05T00:00:00.000Z");

    expect(repo.pendingCatalogEnrichment(profileId, serverId, "2026-05-05T00:00:00.000Z", 10).map((item) => item.parsedTitle).sort()).toEqual([
      "home video",
      "matrix",
    ]);
  });

  it("uses shared master enrichment for linked shared index catalog counts", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const groupId = createSharedGroup(db, serverId, "main");
    const repo = new MediaRepository(db);

    for (const file of [
      { ftpPath: "/Movies/The.Matrix.1999.1080p.mkv", title: "matrix", year: 1999 },
      { ftpPath: "/Movies/The.Matrix.1999.2160p.mkv", title: "matrix", year: 1999 },
      { ftpPath: "/Other/Home.Video.2024.mp4", title: "home video", year: 2024 },
    ]) {
      repo.upsertSharedParsedFile(groupId, {
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: file.title,
        extension: file.ftpPath.endsWith(".mp4") ? "mp4" : "mkv",
        mediaKind: "movie",
        catalogKind: "movie",
        parsedTitle: file.title,
        parsedYear: file.year,
        season: null,
        episode: null,
        imdbId: null,
        quality: null,
        confidence: 70,
      });
    }

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.sharedCatalogEnrichmentCandidates(groupId, serverId, ["movie"]), seenAt);
    const pending = repo.pendingCatalogEnrichment(profileId, serverId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(pending.find((item) => item.parsedTitle === "matrix")!.id, { id: "tt0133093", type: "movie", name: "The Matrix" }, seenAt);
    repo.saveCatalogEnrichmentUnmatched(pending.find((item) => item.parsedTitle === "home video")!.id, seenAt);

    expect(repo.aggregateCountsForProfileWithSharedIndexes(profileId, [groupId])).toEqual({
      total: 3,
      movies: 1,
      series: 0,
      anime: 0,
      uncategorized: 1,
    });
  });

  it("uses shared master enrichment for linked shared index catalog metas", () => {
    const db = new Database(":memory:");
    migrate(db);
    const masterProfileId = createProfile(db);
    const masterServerId = createServer(db, masterProfileId);
    const groupId = createSharedGroup(db, masterServerId, "catalog-metas");
    const linkedProfileId = createProfile(db);
    const linkedServerId = createServer(db, linkedProfileId);
    db.prepare("update profile_ftp_servers set shared_index_group_id = ? where id = ?").run(groupId, linkedServerId);
    const repo = new MediaRepository(db);

    repo.upsertSharedParsedFile(groupId, {
      ftpPath: "/TV/Shared.Show/Shared.Show.S01E01.mkv",
      filename: "Shared.Show.S01E01.mkv",
      normalizedFilename: "shared show s01e01",
      extension: "mkv",
      mediaKind: "series",
      catalogKind: "series",
      parsedTitle: "shared show",
      parsedYear: null,
      season: 1,
      episode: 1,
      imdbId: null,
      quality: null,
      confidence: 85,
    });
    repo.upsertParsedFile(linkedProfileId, {
      ftpServerId: linkedServerId,
      ftpPath: "/TV/Stale.Show/Stale.Show.S01E01.mkv",
      filename: "Stale.Show.S01E01.mkv",
      normalizedFilename: "stale show s01e01",
      extension: "mkv",
      mediaKind: "series",
      catalogKind: "series",
      parsedTitle: "stale show",
      parsedYear: null,
      season: 1,
      episode: 1,
      imdbId: null,
      quality: null,
      confidence: 85,
    });

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(
      masterProfileId,
      masterServerId,
      repo.sharedCatalogEnrichmentCandidates(groupId, masterServerId, ["series"]),
      seenAt,
    );
    repo.syncCatalogEnrichmentCandidates(linkedProfileId, linkedServerId, repo.catalogEnrichmentCandidates(linkedProfileId, linkedServerId, ["series"]), seenAt);
    repo.saveCatalogEnrichmentMatch(repo.pendingCatalogEnrichment(masterProfileId, masterServerId, seenAt, 10)[0].id, {
      id: "tt1111111",
      type: "series",
      name: "Shared Show",
    }, seenAt);
    repo.saveCatalogEnrichmentMatch(repo.pendingCatalogEnrichment(linkedProfileId, linkedServerId, seenAt, 10)[0].id, {
      id: "tt2222222",
      type: "series",
      name: "Stale Show",
    }, seenAt);

    expect(repo.catalogMetas(linkedProfileId, "series", 10, 0, { ftpServerIds: [linkedServerId] })).toEqual([
      expect.objectContaining({ id: "tt1111111", type: "series", name: "Shared Show" }),
    ]);
    expect(repo.catalogMetas(linkedProfileId, "series", 10, 0, { ftpServerIds: [linkedServerId], search: "stale" })).toEqual([]);
  });

  it("uses shared master movie enrichment even when the shared parser row was misclassified", () => {
    const db = new Database(":memory:");
    migrate(db);
    const masterProfileId = createProfile(db);
    const masterServerId = createServer(db, masterProfileId);
    const groupId = createSharedGroup(db, masterServerId, "movie-streams");
    const linkedProfileId = createProfile(db);
    const linkedServerId = createServer(db, linkedProfileId);
    db.prepare("update profile_ftp_servers set shared_index_group_id = ? where id = ?").run(groupId, linkedServerId);
    const repo = new MediaRepository(db);

    for (const filename of [
      "Ghost in the Shell S.A.C. Solid State Society (2006).FSBS.mkv",
      "Ghost in the Shell S.A.C. Solid State Society (2006).HSBS.mkv",
    ]) {
      repo.upsertSharedParsedFile(groupId, {
        ftpPath: `/Anime Movies/Ghost in the Shell S.A.C. Solid State Society (2006)/${filename}`,
        filename,
        normalizedFilename: filename.toLowerCase(),
        extension: "mkv",
        mediaKind: "series",
        catalogKind: "anime",
        parsedTitle: "ghost in shell s a c solid state society",
        parsedYear: 2006,
        season: null,
        episode: null,
        imdbId: null,
        quality: null,
        confidence: 70,
      });
    }

    const seenAt = "2026-06-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(
      masterProfileId,
      masterServerId,
      repo.sharedCatalogEnrichmentCandidates(groupId, masterServerId, ["anime"]),
      seenAt,
    );
    const [candidate] = repo.pendingCatalogEnrichment(masterProfileId, masterServerId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(candidate.id, {
      id: "tt0856797",
      type: "movie",
      name: "Ghost in the Shell: Stand Alone Complex - Solid State Society",
      releaseInfo: "2007",
    }, seenAt);

    expect(repo.findMovie(linkedProfileId, "tt0856797", "ghost in shell stand alone complex solid state society", 2007)).toEqual([
      expect.objectContaining({
        id: expect.any(Number),
        source: "shared",
        ftpServerId: linkedServerId,
        filename: "Ghost in the Shell S.A.C. Solid State Society (2006).FSBS.mkv",
      }),
      expect.objectContaining({
        id: expect.any(Number),
        source: "shared",
        ftpServerId: linkedServerId,
        filename: "Ghost in the Shell S.A.C. Solid State Society (2006).HSBS.mkv",
      }),
    ]);
  });

  it("serves other catalog items and streams from linked shared indexes", () => {
    const db = new Database(":memory:");
    migrate(db);
    const masterProfileId = createProfile(db);
    const masterServerId = createServer(db, masterProfileId, { movies: false, series: false, anime: false });
    const groupId = createSharedGroup(db, masterServerId, "shared-other");
    const linkedProfileId = createProfile(db);
    const linkedServerId = createServer(db, linkedProfileId, { movies: false, series: false, anime: false });
    db.prepare("update profile_ftp_servers set shared_index_group_id = ? where id = ?").run(groupId, linkedServerId);
    const repo = new MediaRepository(db);

    repo.upsertSharedParsedFile(groupId, {
      ftpPath: "/Adult/Scenes/Scene.One.3D.mp4",
      filename: "Scene.One.3D.mp4",
      normalizedFilename: "scene one 3d",
      extension: "mp4",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "scene one",
      parsedYear: null,
      season: null,
      episode: null,
      imdbId: null,
      quality: "1080p",
      confidence: 45,
      sizeBytes: 1024,
    });

    const items = repo.otherCatalogItems(linkedProfileId, 10, 0, {
      ftpServerIds: [linkedServerId],
      includeUnenrichedServerIds: [linkedServerId],
    });
    expect(items).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^shared:\d+:\d+$/),
        folderName: "Scenes",
        fileCount: 1,
        serverCount: 1,
      }),
    ]);

    const streams = repo.otherCatalogStreams(linkedProfileId, { source: "shared", serverId: linkedServerId, id: Number(items[0].id.split(":")[2]) }, {
      ftpServerIds: [linkedServerId],
      includeUnenrichedServerIds: [linkedServerId],
      scopeToRepresentativeServer: true,
    });
    expect(streams).toEqual([
      expect.objectContaining({
        source: "shared",
        ftpServerId: linkedServerId,
        filename: "Scene.One.3D.mp4",
      }),
    ]);
  });

  it("falls back to parser counts for shared indexes that have no enrichment yet", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const enrichedServerId = createServer(db, profileId);
    const enrichedGroupId = createSharedGroup(db, enrichedServerId, "enriched");
    const rawServerId = createServer(db, profileId);
    const rawGroupId = createSharedGroup(db, rawServerId, "raw");
    const repo = new MediaRepository(db);

    repo.upsertSharedParsedFile(enrichedGroupId, {
      ftpPath: "/Movies/The.Matrix.1999.mkv",
      filename: "The.Matrix.1999.mkv",
      normalizedFilename: "matrix",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 70,
    });
    repo.upsertSharedParsedFile(rawGroupId, {
      ftpPath: "/Movies/Shared.Movie.2020.mkv",
      filename: "Shared.Movie.2020.mkv",
      normalizedFilename: "shared movie",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "shared movie",
      parsedYear: 2020,
      season: null,
      episode: null,
      imdbId: "tt1234567",
      quality: null,
      confidence: 90,
    });

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(
      profileId,
      enrichedServerId,
      repo.sharedCatalogEnrichmentCandidates(enrichedGroupId, enrichedServerId, ["movie"]),
      seenAt,
    );
    const [candidate] = repo.pendingCatalogEnrichment(profileId, enrichedServerId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(candidate.id, { id: "tt0133093", type: "movie", name: "The Matrix" }, seenAt);

    expect(repo.aggregateCountsForProfileWithSharedIndexes(profileId, [enrichedGroupId, rawGroupId])).toEqual({
      total: 2,
      movies: 2,
      series: 0,
      anime: 0,
      uncategorized: 0,
    });
  });

  it("does not count uncategorized-only shared indexes as unresolved fallback", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const catalogServerId = createServer(db, profileId);
    const catalogGroupId = createSharedGroup(db, catalogServerId, "catalog");
    const otherServerId = createServer(db, profileId, { movies: false, series: false, anime: false });
    const otherGroupId = createSharedGroup(db, otherServerId, "other");
    const repo = new MediaRepository(db);

    repo.upsertSharedParsedFile(catalogGroupId, {
      ftpPath: "/Movies/The.Matrix.1999.mkv",
      filename: "The.Matrix.1999.mkv",
      normalizedFilename: "matrix",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 70,
    });
    repo.upsertSharedParsedFile(otherGroupId, {
      ftpPath: "/Adult/Clip.2024.mp4",
      filename: "Clip.2024.mp4",
      normalizedFilename: "clip",
      extension: "mp4",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "clip",
      parsedYear: 2024,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 70,
    });

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(profileId, catalogServerId, repo.sharedCatalogEnrichmentCandidates(catalogGroupId, catalogServerId, ["movie"]), seenAt);
    const [candidate] = repo.pendingCatalogEnrichment(profileId, catalogServerId, seenAt, 10);
    repo.saveCatalogEnrichmentUnmatched(candidate.id, seenAt);

    expect(repo.aggregateCountsForProfileWithSharedIndexes(profileId, [catalogGroupId, otherGroupId])).toEqual({
      total: 2,
      movies: 0,
      series: 0,
      anime: 0,
      uncategorized: 1,
    });
  });

  it("combines enriched shared counts with raw fallback for unenriched unlinked servers", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const sharedServerId = createServer(db, profileId);
    const sharedGroupId = createSharedGroup(db, sharedServerId, "shared");
    const localServerId = createServer(db, profileId);
    const repo = new MediaRepository(db);

    repo.upsertSharedParsedFile(sharedGroupId, {
      ftpPath: "/Movies/The.Matrix.1999.mkv",
      filename: "The.Matrix.1999.mkv",
      normalizedFilename: "matrix",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 70,
    });
    repo.upsertParsedFile(profileId, {
      ftpServerId: localServerId,
      ftpPath: "/Movies/Local.Movie.2020.mkv",
      filename: "Local.Movie.2020.mkv",
      normalizedFilename: "local movie",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "local movie",
      parsedYear: 2020,
      season: null,
      episode: null,
      imdbId: "tt1234567",
      quality: null,
      confidence: 90,
    });

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(profileId, sharedServerId, repo.sharedCatalogEnrichmentCandidates(sharedGroupId, sharedServerId, ["movie"]), seenAt);
    const [candidate] = repo.pendingCatalogEnrichment(profileId, sharedServerId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(candidate.id, { id: "tt0133093", type: "movie", name: "The Matrix" }, seenAt);

    expect(repo.aggregateCountsForProfileWithSharedIndexes(profileId, [sharedGroupId])).toEqual({
      total: 2,
      movies: 2,
      series: 0,
      anime: 0,
      uncategorized: 0,
    });
  });

  it("serves movie fallback enrichment from the movie catalog and movie stream lookup", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const repo = new MediaRepository(db);

    repo.upsertParsedFile(profileId, {
      ftpServerId: serverId,
      ftpPath: "/TV Shows/The Animatrix (2003)/The Animatrix.S1E01_3DFF_FSBS.mkv",
      filename: "The Animatrix.S1E01_3DFF_FSBS.mkv",
      normalizedFilename: "animatrix",
      extension: "mkv",
      mediaKind: "series",
      catalogKind: "series",
      parsedTitle: "animatrix",
      parsedYear: null,
      season: 1,
      episode: 1,
      imdbId: null,
      quality: null,
      confidence: 80,
    });

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.catalogEnrichmentCandidates(profileId, serverId, ["series"]), seenAt);
    const [candidate] = repo.pendingCatalogEnrichment(profileId, serverId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(candidate.id, { id: "tt0328832", type: "movie", name: "The Animatrix" }, seenAt);

    expect(repo.catalogMetas(profileId, "series", 10, 0)).toEqual([]);
    expect(repo.catalogMetas(profileId, "movie", 10, 0)).toEqual([expect.objectContaining({ id: "tt0328832", type: "movie", name: "The Animatrix" })]);
    expect(repo.findMovie(profileId, "tt0328832", "animatrix", 2003)).toEqual([
      expect.objectContaining({ filename: "The Animatrix.S1E01_3DFF_FSBS.mkv" }),
    ]);
  });

  it("persists and filters matched catalog metas by TMDB genre", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const repo = new MediaRepository(db);

    for (const [title, year] of [
      ["waterworld", 1995],
      ["toy story", 1995],
    ] as const) {
      repo.upsertParsedFile(profileId, {
        ftpServerId: serverId,
        ftpPath: `/Movies/${title}.${year}.mkv`,
        filename: `${title}.${year}.mkv`,
        normalizedFilename: `${title} ${year}`,
        extension: "mkv",
        mediaKind: "movie",
        catalogKind: "movie",
        parsedTitle: title,
        parsedYear: year,
        season: null,
        episode: null,
        imdbId: null,
        quality: null,
        confidence: 70,
      });
    }

    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.catalogEnrichmentCandidates(profileId, serverId, ["movie"]), seenAt);
    const pending = repo.pendingCatalogEnrichment(profileId, serverId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(
      pending.find((item) => item.parsedTitle === "waterworld")!.id,
      { id: "tt0114898", type: "movie", name: "Waterworld", genres: ["Action", "Adventure", "Science Fiction"] },
      seenAt,
    );
    repo.saveCatalogEnrichmentMatch(
      pending.find((item) => item.parsedTitle === "toy story")!.id,
      { id: "tt0114709", type: "movie", name: "Toy Story", genres: ["Animation", "Family"] },
      seenAt,
    );

    expect(repo.catalogMetas(profileId, "movie", 10, 0, { genre: "Science Fiction" })).toEqual([
      expect.objectContaining({ id: "tt0114898", name: "Waterworld", genres: ["Action", "Adventure", "Science Fiction"] }),
    ]);
  });

  it("orders and paginates typed catalogs after mixed-server aggregation", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const alphabeticalServerId = createServer(db, profileId, { catalogSort: "alphabetical" });
    const newestServerId = createServer(db, profileId, { catalogSort: "newest" });
    const repo = new MediaRepository(db);

    const files = [
      { serverId: alphabeticalServerId, title: "alpha", id: "tt0000001", modifiedAt: "2026-06-01T00:00:00.000Z" },
      { serverId: alphabeticalServerId, title: "zulu", id: "tt0000004", modifiedAt: "2026-07-01T00:00:00.000Z" },
      { serverId: newestServerId, title: "bravo", id: "tt0000002", modifiedAt: "2026-05-01T00:00:00.000Z" },
      { serverId: newestServerId, title: "charlie", id: "tt0000003", modifiedAt: null },
      { serverId: newestServerId, title: "alpha copy", id: "tt0000001", modifiedAt: "2026-04-01T00:00:00.000Z" },
    ];
    for (const file of files) {
      repo.upsertParsedFile(profileId, {
        ftpServerId: file.serverId,
        ftpPath: `/Movies/${file.title}.mkv`,
        filename: `${file.title}.mkv`,
        normalizedFilename: file.title,
        extension: "mkv",
        mediaKind: "movie",
        catalogKind: "movie",
        parsedTitle: file.title,
        parsedYear: 2026,
        season: null,
        episode: null,
        imdbId: null,
        quality: null,
        confidence: 70,
        modifiedAt: file.modifiedAt,
      });
    }
    const seenAt = "2026-07-17T00:00:00.000Z";
    for (const serverId of [alphabeticalServerId, newestServerId]) {
      repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.catalogEnrichmentCandidates(profileId, serverId, ["movie"]), seenAt);
      for (const candidate of repo.pendingCatalogEnrichment(profileId, serverId, seenAt, 20)) {
        const file = files.find((entry) => entry.serverId === serverId && entry.title === candidate.parsedTitle)!;
        repo.saveCatalogEnrichmentMatch(candidate.id, { id: file.id, type: "movie", name: file.id === "tt0000001" ? "Alpha" : titleCase(file.title) }, seenAt);
      }
    }

    expect(repo.catalogMetas(profileId, "movie", 10, 0).map((meta) => meta.name)).toEqual(["Bravo", "Alpha", "Charlie", "Zulu"]);
    expect(repo.catalogMetas(profileId, "movie", 2, 1).map((meta) => meta.name)).toEqual(["Alpha", "Charlie"]);
    expect(repo.catalogMetas(profileId, "movie", 10, 0, { search: "alpha" }).map((meta) => meta.id)).toEqual(["tt0000001"]);
  });

  it("orders shared newest contributions ahead of alphabetical local contributions", () => {
    const db = new Database(":memory:");
    migrate(db);
    const masterProfileId = createProfile(db);
    const masterServerId = createServer(db, masterProfileId);
    const groupId = createSharedGroup(db, masterServerId, "sort");
    const profileId = createProfile(db);
    const linkedServerId = createServer(db, profileId, { catalogSort: "newest" });
    db.prepare("update profile_ftp_servers set shared_index_group_id = ? where id = ?").run(groupId, linkedServerId);
    const localServerId = createServer(db, profileId, { catalogSort: "alphabetical" });
    const repo = new MediaRepository(db);

    repo.upsertSharedParsedFile(groupId, {
      ftpPath: "/Movies/Shared.Recent.mkv",
      filename: "Shared.Recent.mkv",
      normalizedFilename: "shared recent",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "shared recent",
      parsedYear: 2026,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 70,
      modifiedAt: "2026-07-01T00:00:00.000Z",
    });
    repo.upsertParsedFile(profileId, {
      ftpServerId: localServerId,
      ftpPath: "/Movies/Alphabetical.mkv",
      filename: "Alphabetical.mkv",
      normalizedFilename: "alphabetical",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "alphabetical",
      parsedYear: 2026,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 70,
      modifiedAt: "2026-07-10T00:00:00.000Z",
    });
    const seenAt = "2026-07-17T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(
      masterProfileId,
      masterServerId,
      repo.sharedCatalogEnrichmentCandidates(groupId, masterServerId, ["movie"]),
      seenAt,
    );
    repo.saveCatalogEnrichmentMatch(repo.pendingCatalogEnrichment(masterProfileId, masterServerId, seenAt, 10)[0].id, {
      id: "tt0000010",
      type: "movie",
      name: "Shared Recent",
    }, seenAt);
    repo.syncCatalogEnrichmentCandidates(profileId, localServerId, repo.catalogEnrichmentCandidates(profileId, localServerId, ["movie"]), seenAt);
    repo.saveCatalogEnrichmentMatch(repo.pendingCatalogEnrichment(profileId, localServerId, seenAt, 10)[0].id, {
      id: "tt0000011",
      type: "movie",
      name: "Alphabetical",
    }, seenAt);

    expect(repo.catalogMetas(profileId, "movie", 10, 0).map((meta) => meta.name)).toEqual(["Shared Recent", "Alphabetical"]);
  });

  it("orders Other folders by mixed per-server preferences with stable null handling", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const alphabeticalServerId = createServer(db, profileId, { catalogSort: "alphabetical" });
    const newestServerId = createServer(db, profileId, { catalogSort: "newest" });
    const repo = new MediaRepository(db);
    const files = [
      { serverId: alphabeticalServerId, folder: "Alpha", modifiedAt: "2026-07-10T00:00:00.000Z" },
      { serverId: alphabeticalServerId, folder: "Zulu", modifiedAt: "2026-07-11T00:00:00.000Z" },
      { serverId: newestServerId, folder: "Recent", modifiedAt: "2026-07-01T00:00:00.000Z" },
      { serverId: newestServerId, folder: "Broken", modifiedAt: "not-a-date" },
      { serverId: newestServerId, folder: "Missing", modifiedAt: null },
    ];
    for (const file of files) {
      repo.upsertParsedFile(profileId, {
        ftpServerId: file.serverId,
        ftpPath: `/${file.folder}/${file.folder}.mkv`,
        filename: `${file.folder}.mkv`,
        normalizedFilename: file.folder.toLowerCase(),
        extension: "mkv",
        mediaKind: "movie",
        catalogKind: "movie",
        parsedTitle: file.folder.toLowerCase(),
        parsedYear: null,
        season: null,
        episode: null,
        imdbId: null,
        quality: null,
        confidence: 45,
        modifiedAt: file.modifiedAt,
      });
    }

    const options = { ftpServerIds: [alphabeticalServerId, newestServerId], includeUnenrichedServerIds: [alphabeticalServerId, newestServerId] };
    expect(repo.otherCatalogItems(profileId, 10, 0, options).map((item) => item.folderName)).toEqual([
      "Recent",
      "Broken",
      "Missing",
      "Alpha",
      "Zulu",
    ]);
    expect(repo.otherCatalogItems(profileId, 2, 1, options).map((item) => item.folderName)).toEqual(["Broken", "Missing"]);
  });

  it("deletes stale files under a root and treats slash root as the whole profile", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const oldSeen = "2026-05-02T00:00:00.000Z";
    const currentSeen = "2026-05-02T01:00:00.000Z";

    for (const file of [
      { ftpPath: "/TV/Stale.Show.S01E01.mkv", title: "stale show", lastSeenAt: oldSeen },
      { ftpPath: "/TV/Current.Show.S01E01.mkv", title: "current show", lastSeenAt: currentSeen },
      { ftpPath: "/Movies/Stale.Movie.2020.mkv", title: "stale movie", lastSeenAt: oldSeen },
    ]) {
      repo.upsertParsedFile(profileId, {
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: file.title,
        extension: "mkv",
        mediaKind: "series",
        parsedTitle: file.title,
        parsedYear: null,
        season: 1,
        episode: 1,
        imdbId: null,
        quality: null,
        confidence: 80,
        lastSeenAt: file.lastSeenAt,
      });
    }

    expect(repo.deleteStaleUnderRoot(profileId, "/TV", currentSeen)).toBe(1);
    expect(repo.findEpisode(profileId, "stale show", 1, 1)).toHaveLength(0);
    expect(repo.findEpisode(profileId, "current show", 1, 1)).toHaveLength(1);
    expect(repo.findEpisode(profileId, "stale movie", 1, 1)).toHaveLength(1);

    expect(repo.deleteStaleUnderRoot(profileId, "/", currentSeen)).toBe(1);
    expect(repo.findEpisode(profileId, "stale movie", 1, 1)).toHaveLength(0);
  });
});

function titleCase(value: string) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function scanFile(ftpPath: string, lastSeenAt: string) {
  return {
    ftpPath,
    filename: ftpPath.split("/").at(-1) ?? "",
    normalizedFilename: "movie 2020",
    extension: "mkv",
    mediaKind: "movie" as const,
    parsedTitle: "movie",
    parsedYear: 2020,
    season: null,
    episode: null,
    imdbId: null,
    quality: null,
    confidence: 80,
    lastSeenAt,
  };
}

describe("MediaRepository scan writes", () => {
  it("reuses prepared statements across repeated scan writes", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const groupId = createSharedGroup(db, serverId, "statements");
    const repo = new MediaRepository(db);
    const seenAt = "2026-05-02T00:00:00.000Z";
    const prepareSpy = vi.spyOn(db, "prepare");

    for (let index = 0; index < 50; index += 1) {
      const file = scanFile(`/Movies/Movie.${index}.2020.mkv`, seenAt);
      const snapshot = { dirPath: `/Movies/${index}`, entryCount: 1, fingerprint: "f", lastSeenAt: seenAt };
      repo.upsertParsedFile(profileId, { ...file, ftpServerId: serverId });
      repo.upsertParsedFile(profileId, file);
      repo.upsertSharedParsedFile(groupId, file);
      repo.saveDirectorySnapshot(profileId, { ...snapshot, ftpServerId: serverId });
      repo.saveSharedDirectorySnapshot(groupId, snapshot);
      repo.directorySnapshotMatchesFingerprint(profileId, serverId, snapshot.dirPath, 1, "f");
      repo.sharedDirectorySnapshotMatchesFingerprint(groupId, snapshot.dirPath, 1, "f");
      repo.markSeenUnderRoot(profileId, "/Movies", seenAt, serverId);
      repo.markSharedSeenUnderRoot(groupId, "/Movies", seenAt);
    }

    expect(prepareSpy.mock.calls.length).toBeLessThanOrEqual(15);
    expect(repo.countForServer(profileId, serverId)).toBe(50);
    expect(repo.countForSharedIndexGroup(groupId)).toBe(50);
  });
});

describe("MediaRepository scan predicates", () => {
  function captureQueryPlans(db: Database.Database) {
    const prepare = db.prepare.bind(db);
    const prepared: string[] = [];
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    return (call: () => unknown) => {
      prepared.length = 0;
      call();
      return prepared.map((sql) => {
        const params = Array.from({ length: sql.match(/\?/g)?.length ?? 0 }, () => 1);
        const rows = prepare(`explain query plan ${sql}`).all(...params) as Array<{ detail: string }>;
        return rows.map((row) => row.detail).join(" | ");
      });
    };
  }

  it("uses the server and path indexes for scan write predicates", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const groupId = createSharedGroup(db, serverId, "plans");
    const repo = new MediaRepository(db);
    const plansFor = captureQueryPlans(db);
    const seenAt = "2026-05-02T00:00:00.000Z";
    const serverPathIndex = /\(profile_id=\? AND ftp_server_id=\? AND ftp_path(=\?|>\? AND ftp_path<\?)\)/;
    const serverIndex = /\(profile_id=\? AND ftp_server_id=\?/;
    const sharedPathIndex = /\(shared_index_group_id=\? AND ftp_path(=\?|>\? AND ftp_path<\?)\)/;

    for (const plans of [
      plansFor(() => repo.markSeenUnderRoot(profileId, "/Movies", seenAt, serverId)),
      plansFor(() => repo.deleteStaleUnderRoot(profileId, "/Movies", seenAt, serverId)),
    ]) {
      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) expect(plan).toMatch(serverPathIndex);
      expect(plans.join("\n")).toContain("ftp_path>? AND ftp_path<?");
    }
    for (const plans of [
      plansFor(() => repo.markSharedSeenUnderRoot(groupId, "/Movies", seenAt)),
      plansFor(() => repo.deleteSharedStaleUnderRoot(groupId, "/Movies", seenAt)),
    ]) {
      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) expect(plan).toMatch(sharedPathIndex);
      expect(plans.join("\n")).toContain("ftp_path>? AND ftp_path<?");
    }
    for (const plans of [
      plansFor(() => repo.markSeenUnderRoot(profileId, "/", seenAt, serverId)),
      plansFor(() => repo.deleteStaleUnderRoot(profileId, "/", seenAt, serverId)),
      plansFor(() => repo.countDirectorySnapshots(profileId, serverId)),
      plansFor(() => repo.clearDirectorySnapshots(profileId, serverId)),
    ]) {
      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) expect(plan).toMatch(serverIndex);
    }
    const snapshotPlans = plansFor(() => repo.directorySnapshotMatchesFingerprint(profileId, serverId, "/Movies", 1, "f"));
    expect(snapshotPlans).toEqual([expect.stringMatching(/\(profile_id=\? AND ftp_server_id=\? AND dir_path=\?\)/)]);
  });

  it("matches only the root itself and paths below it, per server or across the profile", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const otherServerId = createServer(db, profileId);
    const groupId = createSharedGroup(db, serverId, "prefix");
    const repo = new MediaRepository(db);
    const oldSeen = "2026-05-01T00:00:00.000Z";
    const newSeen = "2026-05-02T00:00:00.000Z";
    const paths = [
      "/Movies",
      "/Movies/a.mkv",
      "/Movies/Sub/b.mkv",
      "/Movies/é.mkv",
      "/Movies 4K/c.mkv",
      "/Movies-Old/d.mkv",
      "/Movies.Extra/e.mkv",
      "/Movies0/f.mkv",
      "/MoviesZ/g.mkv",
      "/Moviesé/h.mkv",
      "/Movie/i.mkv",
      "/Other/j.mkv",
    ];
    const reset = () => {
      for (const path of paths) {
        repo.upsertParsedFile(profileId, { ...scanFile(path, oldSeen), ftpServerId: serverId });
        repo.upsertSharedParsedFile(groupId, scanFile(path, oldSeen));
      }
      repo.upsertParsedFile(profileId, { ...scanFile("/Movies/other-server.mkv", oldSeen), ftpServerId: otherServerId });
    };
    const seenPaths = (table: "media_files" | "shared_media_files") =>
      (db.prepare(`select ftp_path from ${table} where last_seen_at = ? order by ftp_path`).all(newSeen) as Array<{ ftp_path: string }>).map(
        (row) => row.ftp_path,
      );
    const underMovies = ["/Movies", "/Movies/Sub/b.mkv", "/Movies/a.mkv", "/Movies/é.mkv"];

    reset();
    expect(repo.markSeenUnderRoot(profileId, "/Movies/", newSeen, serverId)).toBe(4);
    expect(seenPaths("media_files")).toEqual(underMovies);
    expect(repo.deleteStaleUnderRoot(profileId, "/Movies", newSeen, serverId)).toBe(0);
    expect(repo.deleteStaleUnderRoot(profileId, "/Movies", newSeen)).toBe(1);
    expect(repo.countForServer(profileId, otherServerId)).toBe(0);

    db.prepare("delete from media_files").run();
    reset();
    expect(repo.markSeenUnderRoot(profileId, "Movies", newSeen)).toBe(5);
    expect(repo.deleteStaleUnderRoot(profileId, "/", newSeen, serverId)).toBe(paths.length - 4);
    expect(repo.countForServer(profileId, serverId)).toBe(4);
    expect(repo.countForServer(profileId, otherServerId)).toBe(1);
    expect(repo.markSeenUnderRoot(profileId, "/", "2026-05-03T00:00:00.000Z", serverId)).toBe(4);
    expect(repo.markSeenUnderRoot(profileId, "/", "2026-05-03T00:00:00.000Z")).toBe(5);

    expect(repo.markSharedSeenUnderRoot(groupId, "/Movies", newSeen)).toBe(4);
    expect(seenPaths("shared_media_files")).toEqual(underMovies);
    expect(repo.deleteSharedStaleUnderRoot(groupId, "/Movies", newSeen)).toBe(0);
    expect(repo.deleteSharedStaleUnderRoot(groupId, "/", newSeen)).toBe(paths.length - 4);
    expect(repo.countForSharedIndexGroup(groupId)).toBe(4);
  });

  it("scopes directory snapshots to a server or the whole profile", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const otherServerId = createServer(db, profileId);
    const repo = new MediaRepository(db);
    const snapshot = { dirPath: "/Movies/", entryCount: 2, fingerprint: "f", lastSeenAt: "2026-05-02T00:00:00.000Z" };
    repo.saveDirectorySnapshot(profileId, { ...snapshot, ftpServerId: serverId });
    repo.saveDirectorySnapshot(profileId, { ...snapshot, dirPath: "/TV", ftpServerId: otherServerId });

    expect(repo.directorySnapshotMatchesFingerprint(profileId, serverId, "/Movies", 2, "f")).toBe(true);
    expect(repo.directorySnapshotMatchesFingerprint(profileId, serverId, "/Movies", 3, "f")).toBe(false);
    expect(repo.directorySnapshotMatchesFingerprint(profileId, otherServerId, "/Movies", 2, "f")).toBe(false);
    expect(repo.directorySnapshotMatchesFingerprint(profileId, null, "/Movies", 2, "f")).toBe(true);
    expect(repo.countDirectorySnapshots(profileId, serverId)).toBe(1);
    expect(repo.countDirectorySnapshots(profileId)).toBe(2);
    expect(repo.clearDirectorySnapshots(profileId, otherServerId)).toBe(1);
    expect(repo.countDirectorySnapshots(profileId)).toBe(1);
    expect(repo.clearDirectorySnapshots(profileId)).toBe(1);
    expect(repo.countDirectorySnapshots(profileId)).toBe(0);
  });
});

describe("MediaRepository shared index count queries", () => {
  function sharedMovie(title: string, year: number) {
    const filename = `${titleCase(title).replace(/ /g, ".")}.${year}.mkv`;
    return {
      ftpPath: `/Movies/${filename}`,
      filename,
      normalizedFilename: title,
      extension: "mkv",
      mediaKind: "movie" as const,
      catalogKind: "movie" as const,
      parsedTitle: title,
      parsedYear: year,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 90,
    };
  }

  it("finds unenriched shared groups through the enrichment unique index instead of a table scan", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const serverId = createServer(db, profileId);
    const groupId = createSharedGroup(db, serverId, "plan");
    const repo = new MediaRepository(db);
    repo.upsertSharedParsedFile(groupId, sharedMovie("matrix", 1999));

    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    repo.aggregateCountsForProfileWithSharedIndexes(profileId, [groupId]);
    db.prepare = prepare;

    const fullEnrichmentScans = statements.flatMap((sql) => {
      const parameterCount = sql.match(/\?/g)?.length ?? 0;
      const plan = prepare(`explain query plan ${sql}`).all(...Array(parameterCount).fill(groupId)) as Array<{ detail: string }>;
      return plan.map((row) => row.detail).filter((detail) => /^SCAN (ce|catalog_enrichment)\b/.test(detail));
    });
    expect(fullEnrichmentScans).toEqual([]);
  });

  it("treats groups whose master enrichment only covers other items as unenriched", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const staleServerId = createServer(db, profileId);
    const staleGroupId = createSharedGroup(db, staleServerId, "stale");
    const orphanServerId = createServer(db, profileId);
    const orphanGroupId = createSharedGroup(db, orphanServerId, "orphan");
    db.prepare("update shared_index_groups set master_profile_ftp_server_id = null where id = ?").run(orphanGroupId);
    const repo = new MediaRepository(db);

    repo.upsertSharedParsedFile(staleGroupId, sharedMovie("old movie", 2001));
    const seenAt = "2026-05-04T00:00:00.000Z";
    repo.syncCatalogEnrichmentCandidates(profileId, staleServerId, repo.sharedCatalogEnrichmentCandidates(staleGroupId, staleServerId, ["movie"]), seenAt);
    const [candidate] = repo.pendingCatalogEnrichment(profileId, staleServerId, seenAt, 10);
    repo.saveCatalogEnrichmentMatch(candidate.id, { id: "tt0000001", type: "movie", name: "Old Movie" }, seenAt);
    db.prepare("delete from shared_media_files where shared_index_group_id = ?").run(staleGroupId);
    repo.upsertSharedParsedFile(staleGroupId, sharedMovie("new movie", 2024));
    repo.upsertSharedParsedFile(orphanGroupId, sharedMovie("orphan movie", 2023));

    expect(repo.aggregateCountsForProfileWithSharedIndexes(profileId, [staleGroupId, orphanGroupId])).toEqual({
      total: 2,
      movies: 2,
      series: 0,
      anime: 0,
      uncategorized: 0,
    });
  });
});
