import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";

function createProfile(db: Database.Database) {
  return Number(
    db
      .prepare(
        "insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at) values ('uid', 'v', 'h', 'n', 'n')",
      )
      .run().lastInsertRowid,
  );
}

function createServer(db: Database.Database, profileId: number) {
  return Number(
    db
      .prepare(
        `
        insert into profile_ftp_servers (
          profile_id, name, catalog_enabled, catalog_content_movies, catalog_content_series,
          catalog_content_anime, library_layout, stream_delivery_mode, created_at, updated_at
        ) values (?, 'Server 1', 1, 1, 1, 0, 'auto', 'proxy', 'n', 'n')
      `,
      )
      .run(profileId).lastInsertRowid,
  );
}

describe("MediaRepository", () => {
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

    db.prepare("update catalog_enrichment set algorithm_version = 1").run();
    repo.syncCatalogEnrichmentCandidates(profileId, serverId, repo.catalogEnrichmentCandidates(profileId, serverId, ["movie"]), "2026-05-05T00:00:00.000Z");

    expect(repo.pendingCatalogEnrichment(profileId, serverId, "2026-05-05T00:00:00.000Z", 10).map((item) => item.parsedTitle)).toEqual(["home video"]);
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
