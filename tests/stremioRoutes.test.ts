import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";
import { clearTmdbCatalogCache } from "../src/server/metadata/tmdbClient";
import { ProfileService } from "../src/server/profiles/profileService";
import { stremioRoutes } from "../src/server/stremio/routes";

const config: AppConfig = {
  baseUrl: "https://addon.example.test",
  configDir: "/tmp",
  sqlitePath: ":memory:",
  encryptionKey: "0123456789abcdef0123456789abcdef",
  setupToken: "setup-secret-123",
  allowPublicProfileApi: false,
  port: 7000,
  logLevel: "error",
  crawlerConcurrency: 2,
  ftpTimeoutMs: 15000,
  ftpMaxConnections: 4,
  maxOnDemandSearchMs: 4500,
  profileRateLimitWindowMs: 600000,
  profileRateLimitMax: 30,
  tmdbApiKey: null,
};

const CATALOG_EXTRAS = [{ name: "skip" }, { name: "search" }];

function attachRowsToDefaultServer(db: Database.Database, profileId: number, service: ProfileService) {
  const serverId = service.defaultFtpServerId(profileId);
  db.prepare("update media_files set ftp_server_id = ? where profile_id = ? and ftp_server_id is null").run(serverId, profileId);
  return serverId;
}

function persistMatchedCatalog(
  repository: MediaRepository,
  profileId: number,
  serverId: number,
  catalogKind: "movie" | "series" | "anime",
  meta: { id: string; type: "movie" | "series"; name: string; poster?: string; background?: string; description?: string; releaseInfo?: string },
) {
  const seenAt = new Date().toISOString();
  const candidates = repository.catalogEnrichmentCandidates(profileId, serverId, [catalogKind]);
  repository.syncCatalogEnrichmentCandidates(profileId, serverId, candidates, seenAt);
  for (const candidate of repository.pendingCatalogEnrichment(profileId, serverId, seenAt, 100)) {
    repository.saveCatalogEnrichmentMatch(candidate.id, meta, seenAt);
  }
}

function persistUnmatchedCatalog(repository: MediaRepository, profileId: number, serverId: number, catalogKind: "movie" | "series" | "anime" = "movie") {
  const seenAt = new Date().toISOString();
  const candidates = repository.catalogEnrichmentCandidates(profileId, serverId, [catalogKind]);
  repository.syncCatalogEnrichmentCandidates(profileId, serverId, candidates, seenAt);
  for (const candidate of repository.pendingCatalogEnrichment(profileId, serverId, seenAt, 100)) {
    repository.saveCatalogEnrichmentUnmatched(candidate.id, seenAt);
  }
}

describe("stremio routes", () => {
  afterEach(() => {
    clearTmdbCatalogCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns per-token manifest", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(200);
    const otherProfile = await service.createProfile("uid-87654321", "passphrase");
    const otherResponse = await request(app).get(`/u/${otherProfile.installUrlToken}/manifest.json`).expect(200);

    expect(response.body).toMatchObject({
      version: "0.4.32",
      resources: ["stream"],
      types: ["movie", "series"],
      idPrefixes: ["tt"],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
    expect(response.body.id).toMatch(/^community\.stremio-ftp\.[a-f0-9]{12}$/);
    expect(otherResponse.body.id).toMatch(/^community\.stremio-ftp\.[a-f0-9]{12}$/);
    expect(otherResponse.body.id).not.toBe(response.body.id);
    expect(response.header["access-control-allow-origin"]).toBe("*");
    expect(response.header["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("uses saved profile branding in the token manifest", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "https://cdn.example.test/logo.png",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: false,
    });
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(200);

    expect(response.body.name).toBe("Archive 3D");
    expect(response.body.logo).toBe("https://cdn.example.test/logo.png");
    expect(response.body.description).toBe("Stream the archive from my FTP server.");
  });

  it("serves an optional FTP catalog with TMDB poster metadata", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      ftpPath: "/movies/The.Matrix.1999.1080p.mkv",
      filename: "The.Matrix.1999.1080p.mkv",
      normalizedFilename: "the matrix 1999 1080p",
      extension: "mkv",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: "tt0133093",
      quality: "1080p",
      confidence: 95,
      sizeBytes: 1024 * 1024,
    });
    const serverId = attachRowsToDefaultServer(db, created.profileId, service);
    persistMatchedCatalog(repository, created.profileId, serverId, "movie", {
      id: "tt0133093",
      type: "movie",
      name: "The Matrix",
      poster: "https://image.tmdb.org/t/p/w500/poster.jpg",
      background: "https://image.tmdb.org/t/p/w500/backdrop.jpg",
      description: "A hacker discovers reality.",
      releaseInfo: "1999",
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        movie_results: [
          {
            title: "The Matrix",
            overview: "A hacker discovers reality.",
            poster_path: "/poster.jpg",
            backdrop_path: "/backdrop.jpg",
            release_date: "1999-03-31",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const manifest = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(200);
    const catalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);

    expect(manifest.body.resources).toEqual(["stream", "catalog", "meta"]);
    expect(manifest.body.catalogs).toEqual([
      { type: "movie", id: "ftp-movies", name: "Archive 3D Movies", extra: CATALOG_EXTRAS },
      { type: "series", id: "ftp-series", name: "Archive 3D Series", extra: CATALOG_EXTRAS },
      { type: "movie", id: "ftp-other", name: "Archive 3D Other", extra: CATALOG_EXTRAS },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(catalog.body.metas).toEqual([
      {
        id: "tt0133093",
        type: "movie",
        name: "The Matrix",
        poster: "https://image.tmdb.org/t/p/w500/poster.jpg",
        background: "https://image.tmdb.org/t/p/w500/backdrop.jpg",
        description: "A hacker discovers reality.",
        releaseInfo: "1999",
      },
    ]);
  });

  it("omits the Other catalog when uncategorized content is disabled", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
      catalogContentTypes: { movies: true, series: false, anime: false, uncategorized: false },
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      catalogKind: "movie",
      ftpPath: "/Home Videos/Home.Video.2024.mp4",
      filename: "Home.Video.2024.mp4",
      normalizedFilename: "home video 2024",
      extension: "mp4",
      parsedTitle: "home video",
      parsedYear: 2024,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 45,
      sizeBytes: 1024 * 1024,
    });
    persistUnmatchedCatalog(repository, created.profileId, attachRowsToDefaultServer(db, created.profileId, service));
    const app = createApp(config, db);

    const manifest = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(200);
    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(manifest.body.catalogs.map((catalog: { id: string }) => catalog.id)).toEqual(["ftp-movies"]);
    expect(otherCatalog.body.metas).toEqual([]);
  });

  it("filters typed Stremio catalogs by search extra without TMDB calls", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
      catalogContentTypes: { movies: true, series: false, anime: false },
    });
    const repository = new MediaRepository(db);
    for (const [title, year] of [
      ["matrix", 1999],
      ["animatrix", 2003],
      ["fight club", 1999],
    ] as const) {
      repository.upsertParsedFile(created.profileId, {
        mediaKind: "movie",
        catalogKind: "movie",
        ftpPath: `/Movies/${title}.${year}.mkv`,
        filename: `${title}.${year}.mkv`,
        normalizedFilename: `${title} ${year}`,
        extension: "mkv",
        parsedTitle: title,
        parsedYear: year,
        season: null,
        episode: null,
        imdbId: null,
        quality: "1080p",
        confidence: 70,
      });
    }
    const serverId = attachRowsToDefaultServer(db, created.profileId, service);
    const seenAt = new Date().toISOString();
    repository.syncCatalogEnrichmentCandidates(created.profileId, serverId, repository.catalogEnrichmentCandidates(created.profileId, serverId, ["movie"]), seenAt);
    for (const candidate of repository.pendingCatalogEnrichment(created.profileId, serverId, seenAt, 100)) {
      const metaByTitle = {
        matrix: { id: "tt0133093", type: "movie" as const, name: "The Matrix" },
        animatrix: { id: "tt0328832", type: "movie" as const, name: "The Animatrix" },
        "fight club": { id: "tt0137523", type: "movie" as const, name: "Fight Club" },
      };
      repository.saveCatalogEnrichmentMatch(candidate.id, metaByTitle[candidate.parsedTitle as keyof typeof metaByTitle], seenAt);
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const catalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies/search=matrix.json`).expect(200);

    expect(catalog.body.metas.map((meta: { name: string }) => meta.name)).toEqual(["The Matrix", "The Animatrix"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only scans catalog-enabled servers for catalog pages and TMDB lookups", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    const enabledServerId = service.defaultFtpServerId(created.profileId);
    service.saveFtpServer(created.profileId, enabledServerId, {
      name: "Catalog Server",
      customization: {
        catalogEnabled: true,
        catalogContentTypes: { movies: true, series: false, anime: false },
      },
    });
    const disabledServer = service.createFtpServer(created.profileId, {
      name: "Stream Only Server",
      customization: {
        catalogEnabled: false,
        catalogContentTypes: { movies: true, series: false, anime: false },
      },
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      ftpServerId: enabledServerId,
      mediaKind: "movie",
      catalogKind: "movie",
      ftpPath: "/movies/Enabled.Movie.2024.mkv",
      filename: "Enabled.Movie.2024.mkv",
      normalizedFilename: "enabled movie 2024",
      extension: "mkv",
      parsedTitle: "enabled movie",
      parsedYear: 2024,
      season: null,
      episode: null,
      imdbId: "tt0000001",
      quality: "1080p",
      confidence: 95,
      sizeBytes: 1024,
    });
    repository.upsertParsedFile(created.profileId, {
      ftpServerId: disabledServer.id,
      mediaKind: "movie",
      catalogKind: "movie",
      ftpPath: "/movies/Disabled.Movie.2024.mkv",
      filename: "Disabled.Movie.2024.mkv",
      normalizedFilename: "disabled movie 2024",
      extension: "mkv",
      parsedTitle: "disabled movie",
      parsedYear: 2024,
      season: null,
      episode: null,
      imdbId: "tt0000002",
      quality: "1080p",
      confidence: 95,
      sizeBytes: 1024,
    });
    persistMatchedCatalog(repository, created.profileId, enabledServerId, "movie", {
      id: "tt0000001",
      type: "movie",
      name: "Enabled Movie",
      releaseInfo: "2024",
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        movie_results: [
          {
            title: "Enabled Movie",
            release_date: "2024-01-01",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const catalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);

    expect(catalog.body.metas).toEqual([
      {
        id: "tt0000001",
        type: "movie",
        name: "Enabled Movie",
        releaseInfo: "2024",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches TMDB catalog metadata between repeated catalog page requests", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      catalogKind: "movie",
      ftpPath: "/movies/The.Matrix.1999.1080p.mkv",
      filename: "The.Matrix.1999.1080p.mkv",
      normalizedFilename: "the matrix 1999 1080p",
      extension: "mkv",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: "tt0133093",
      quality: "1080p",
      confidence: 95,
      sizeBytes: 1024 * 1024,
    });
    const serverId = attachRowsToDefaultServer(db, created.profileId, service);
    persistMatchedCatalog(repository, created.profileId, serverId, "movie", {
      id: "tt0133093",
      type: "movie",
      name: "The Matrix",
      releaseInfo: "1999",
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        movie_results: [
          {
            title: "The Matrix",
            release_date: "1999-03-31",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);
    await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves catalog items without filename IMDb ids through TMDB search", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      ftpPath: "/movies/Zack.Snyders.Justice.League.2021.1080p.mkv",
      filename: "Zack.Snyders.Justice.League.2021.1080p.mkv",
      normalizedFilename: "zack snyders justice league 2021 1080p",
      extension: "mkv",
      parsedTitle: "zack snyders justice league",
      parsedYear: 2021,
      season: null,
      episode: null,
      imdbId: null,
      quality: "1080p",
      confidence: 70,
      sizeBytes: 1024 * 1024,
    });
    const serverId = attachRowsToDefaultServer(db, created.profileId, service);
    persistMatchedCatalog(repository, created.profileId, serverId, "movie", {
      id: "tt12361974",
      type: "movie",
      name: "Zack Snyder's Justice League",
      poster: "https://image.tmdb.org/t/p/w500/justice.jpg",
      background: "https://image.tmdb.org/t/p/w500/justice-bg.jpg",
      description: "Determined to ensure Superman's sacrifice was not in vain.",
      releaseInfo: "2021",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 791373,
              title: "Zack Snyder's Justice League",
              overview: "Determined to ensure Superman's sacrifice was not in vain.",
              poster_path: "/justice.jpg",
              backdrop_path: "/justice-bg.jpg",
              release_date: "2021-03-18",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt12361974" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const catalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(catalog.body.metas).toEqual([
      {
        id: "tt12361974",
        type: "movie",
        name: "Zack Snyder's Justice League",
        poster: "https://image.tmdb.org/t/p/w500/justice.jpg",
        background: "https://image.tmdb.org/t/p/w500/justice-bg.jpg",
        description: "Determined to ensure Superman's sacrifice was not in vain.",
        releaseInfo: "2021",
      },
    ]);
  });

  it("serves unrecognized indexed files in a separate Other catalog with direct streams", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      ftpPath: "/Home Videos/Home.Video.2024.mp4",
      filename: "Home.Video.2024.mp4",
      normalizedFilename: "home video 2024",
      extension: "mp4",
      parsedTitle: "home video",
      parsedYear: 2024,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 45,
      sizeBytes: 1024 * 1024,
    });
    persistUnmatchedCatalog(repository, created.profileId, attachRowsToDefaultServer(db, created.profileId, service));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const movieCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);
    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(movieCatalog.body.metas).toEqual([]);
    expect(otherCatalog.body.metas).toHaveLength(1);
    expect(otherCatalog.body.metas[0]).toMatchObject({
      id: expect.stringMatching(/^ftp-folder:\d+$/),
      type: "movie",
      name: "Home Videos",
      description: "1 file across 1 server",
      poster: "https://addon.example.test/assets/default-folder-poster.png",
    });

    const stream = await request(app)
      .get(`/u/${created.installUrlToken}/stream/movie/${otherCatalog.body.metas[0].id}.json`)
      .expect(200);
    expect(stream.body.streams).toEqual([
      {
        name: "FTP Server 1 - Source",
        description: "Server 1\nHome.Video.2024.mp4\n1 MB",
        url: expect.stringMatching(new RegExp(`^https://addon\\.example\\.test/proxy/${created.installUrlToken}/\\d+$`)),
        behaviorHints: {
          notWebReady: true,
          filename: "Home.Video.2024.mp4",
          videoSize: 1024 * 1024,
        },
      },
    ]);
  });

  it("does not query TMDB while serving the Other catalog", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      catalogKind: "movie",
      ftpPath: "/Vacation Archive/random-clip.mp4",
      filename: "random-clip.mp4",
      normalizedFilename: "random clip",
      extension: "mp4",
      parsedTitle: "random clip",
      parsedYear: null,
      season: null,
      episode: null,
      imdbId: null,
      quality: null,
      confidence: 35,
      sizeBytes: 1024 * 1024,
    });
    persistUnmatchedCatalog(repository, created.profileId, attachRowsToDefaultServer(db, created.profileId, service));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(otherCatalog.body.metas).toEqual([
      {
        id: expect.stringMatching(/^ftp-folder:\d+$/),
        type: "movie",
        name: "Vacation Archive",
        description: "1 file across 1 server",
        poster: "https://addon.example.test/assets/default-folder-poster.png",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters Other catalog folder groups by folder name and filename without TMDB checks", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
    });
    const repository = new MediaRepository(db);
    for (const file of [
      { ftpPath: "/Vacation Archive/random-clip.mp4", title: "random clip" },
      { ftpPath: "/Family Videos/Birthday.Surprise.2024.mp4", title: "birthday surprise", year: 2024 },
      { ftpPath: "/Concerts/Matrix.Stage.Show.2024.mp4", title: "matrix stage show", year: 2024 },
    ]) {
      repository.upsertParsedFile(created.profileId, {
        mediaKind: "movie",
        catalogKind: "movie",
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: file.title,
        extension: "mp4",
        parsedTitle: file.title,
        parsedYear: file.year ?? null,
        season: null,
        episode: null,
        imdbId: null,
        quality: null,
        confidence: 35,
        sizeBytes: 1024 * 1024,
      });
    }
    persistUnmatchedCatalog(repository, created.profileId, attachRowsToDefaultServer(db, created.profileId, service));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const byFolder = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other/search=vacation.json`).expect(200);
    const byFilename = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other/search=matrix.json`).expect(200);

    expect(byFolder.body.metas.map((meta: { name: string }) => meta.name)).toEqual(["Vacation Archive"]);
    expect(byFilename.body.metas.map((meta: { name: string }) => meta.name)).toEqual(["Concerts"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("groups duplicate unresolved Other catalog variants into one item with multiple streams", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
    });
    const server1Id = service.defaultFtpServerId(created.profileId);
    const server2 = service.createFtpServer(created.profileId, {
      name: "Server 2",
      customization: {
        catalogEnabled: true,
        catalogContentTypes: { movies: true, series: true, anime: false },
      },
    });
    const repository = new MediaRepository(db);
    for (const [ftpServerId, prefix, filename] of [
      [server1Id, "/Family Videos", "Home.Video.2024.1080p.mp4"],
      [server2.id, "/archive/Family Videos", "Home.Video.2024.2160p.mkv"],
    ] as const) {
      repository.upsertParsedFile(created.profileId, {
        ftpServerId,
        mediaKind: "movie",
        catalogKind: "movie",
        ftpPath: `${prefix}/${filename}`,
        filename,
        normalizedFilename: filename.toLowerCase(),
        extension: filename.endsWith(".mp4") ? "mp4" : "mkv",
        parsedTitle: "home video",
        parsedYear: 2024,
        season: null,
        episode: null,
        imdbId: null,
        quality: filename.includes("2160p") ? "2160p" : "1080p",
        confidence: 45,
        sizeBytes: 1024 * 1024,
      });
    }
    persistUnmatchedCatalog(repository, created.profileId, server1Id);
    persistUnmatchedCatalog(repository, created.profileId, server2.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [] }),
      })),
    );
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(otherCatalog.body.metas).toHaveLength(1);
    expect(otherCatalog.body.metas[0]).toMatchObject({
      id: expect.stringMatching(/^ftp-folder:\d+$/),
      name: "Family Videos",
      description: "2 files across 2 servers",
    });

    const stream = await request(app)
      .get(`/u/${created.installUrlToken}/stream/movie/${otherCatalog.body.metas[0].id}.json`)
      .expect(200);
    expect(stream.body.streams).toHaveLength(2);
    expect(stream.body.streams.map((item: { behaviorHints: { filename: string } }) => item.behaviorHints.filename).sort()).toEqual([
      "Home.Video.2024.1080p.mp4",
      "Home.Video.2024.2160p.mkv",
    ]);
  });

  it("uses profile TMDB key and anime content settings for anime catalog lookup", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
      catalogTmdbApiKey: "profile-tmdb-key",
      catalogContentTypes: { movies: false, series: false, anime: true },
      libraryLayout: "auto",
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "series",
      catalogKind: "anime",
      ftpPath: "/anime/Afro.Samurai.01.1080p.mkv",
      filename: "Afro.Samurai.01.1080p.mkv",
      normalizedFilename: "afro samurai 01 1080p",
      extension: "mkv",
      parsedTitle: "afro samurai",
      parsedYear: null,
      season: 1,
      episode: 1,
      imdbId: null,
      quality: "1080p",
      confidence: 82,
      sizeBytes: 1024 * 1024,
    });
    const animeServerId = attachRowsToDefaultServer(db, created.profileId, service);
    persistMatchedCatalog(repository, created.profileId, animeServerId, "anime", {
      id: "tt0465316",
      type: "series",
      name: "Afro Samurai",
      poster: "https://image.tmdb.org/t/p/w500/afro.jpg",
      background: "https://image.tmdb.org/t/p/w500/afro-bg.jpg",
      description: "A warrior seeks revenge.",
      releaseInfo: "2007",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 37858,
              name: "Afro Samurai",
              overview: "A warrior seeks revenge.",
              poster_path: "/afro.jpg",
              backdrop_path: "/afro-bg.jpg",
              first_air_date: "2007-01-04",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt0465316" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "env-key" }, db);

    const manifest = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(200);
    const catalog = await request(app).get(`/u/${created.installUrlToken}/catalog/series/ftp-anime.json`).expect(200);

    expect(manifest.body.catalogs).toEqual([
      { type: "series", id: "ftp-anime", name: "Archive 3D Anime", extra: CATALOG_EXTRAS },
      { type: "movie", id: "ftp-other", name: "Archive 3D Other", extra: CATALOG_EXTRAS },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(catalog.body.metas).toEqual([
      {
        id: "tt0465316",
        type: "series",
        name: "Afro Samurai",
        poster: "https://image.tmdb.org/t/p/w500/afro.jpg",
        background: "https://image.tmdb.org/t/p/w500/afro-bg.jpg",
        description: "A warrior seeks revenge.",
        releaseInfo: "2007",
      },
    ]);
  });

  it("keeps duplicate unresolved folder formats grouped in the Other catalog without TMDB checks", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
      catalogContentTypes: { movies: true, series: true, anime: false },
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      catalogKind: "movie",
      ftpPath: "/movies/Ready.Player.One.2018.3D.HSBS.mkv",
      filename: "Ready.Player.One.2018.3D.HSBS.mkv",
      normalizedFilename: "ready player one 2018 3d hsbs",
      extension: "mkv",
      parsedTitle: "ready player one",
      parsedYear: 2018,
      season: null,
      episode: null,
      imdbId: null,
      quality: "1080p",
      confidence: 70,
      sizeBytes: 1024 * 1024,
    });
    persistUnmatchedCatalog(repository, created.profileId, attachRowsToDefaultServer(db, created.profileId, service));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(otherCatalog.body.metas).toHaveLength(1);
    expect(otherCatalog.body.metas[0]).toMatchObject({
      id: expect.stringMatching(/^ftp-folder:\d+$/),
      name: "Movies",
      description: "1 file across 1 server",
      poster: "https://addon.example.test/assets/default-folder-poster.png",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves previously indexed anime variants from Other without TMDB checks", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
      catalogContentTypes: { movies: true, series: true, anime: true },
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "series",
      catalogKind: "anime",
      ftpPath: "/Anime Shows/Cyberpunk - Edgerunners (2022)/Cyberpunk - Edgerunners.S1.01.H264.FSBS.3DFF.mkv",
      filename: "Cyberpunk - Edgerunners.S1.01.H264.FSBS.3DFF.mkv",
      normalizedFilename: "cyberpunk edgerunners s1 01 h264 fsbs 3dff",
      extension: "mkv",
      parsedTitle: "cyberpunk edgerunners s1",
      parsedYear: null,
      season: 1,
      episode: 1,
      imdbId: null,
      quality: null,
      confidence: 82,
      sizeBytes: 1024 * 1024,
    });
    persistUnmatchedCatalog(repository, created.profileId, attachRowsToDefaultServer(db, created.profileId, service), "anime");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(otherCatalog.body.metas).toHaveLength(1);
    expect(otherCatalog.body.metas[0]).toMatchObject({
      id: expect.stringMatching(/^ftp-folder:\d+$/),
      name: "Cyberpunk Edgerunners (2022)",
      poster: "https://addon.example.test/assets/default-folder-poster.png",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves Other catalog pages without TMDB concurrency work", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
      catalogContentTypes: { movies: true, series: false, anime: false },
    });
    const repository = new MediaRepository(db);
    for (const [index, title, year] of [
      [0, "fight club", 1999],
      [1, "unmatched one", 2024],
      [2, "unmatched two", 2024],
      [3, "unmatched three", 2024],
      [4, "unmatched four", 2024],
      [5, "unmatched five", 2024],
    ] as const) {
      repository.upsertParsedFile(created.profileId, {
        mediaKind: "movie",
        catalogKind: "movie",
        ftpPath: `/Other/${title.replace(/\s+/g, ".")}.${year}.mkv`,
        filename: `${title.replace(/\s+/g, ".")}.${year}.mkv`,
        normalizedFilename: `${title} ${year}`,
        extension: "mkv",
        parsedTitle: title,
        parsedYear: year,
        season: null,
        episode: null,
        imdbId: null,
        quality: "1080p",
        confidence: 70 - index,
        sizeBytes: 1024,
      });
    }
    persistUnmatchedCatalog(repository, created.profileId, attachRowsToDefaultServer(db, created.profileId, service));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(otherCatalog.body.metas).toHaveLength(1);
    expect(otherCatalog.body.metas[0]).toMatchObject({
      name: "Other",
      description: "6 files across 1 server",
      poster: "https://addon.example.test/assets/default-folder-poster.png",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns CORS headers for public manifest and stream routes", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config, db);

    const manifestResponse = await request(app).get("/manifest.json").expect(200);
    const streamResponse = await request(app).get("/u/not-real/stream/movie/tt0133093.json").expect(200);

    expect(manifestResponse.header["access-control-allow-origin"]).toBe("*");
    expect(streamResponse.header["access-control-allow-origin"]).toBe("*");
    expect(manifestResponse.header["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(streamResponse.header["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("returns empty streams for invalid tokens", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config, db);
    const response = await request(app).get("/u/not-real/stream/movie/tt0133093.json").expect(200);
    expect(response.body).toEqual({ streams: [] });
  });

  it("fetches series metadata by base imdb id and resolves episode streams", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "series",
      ftpPath: "/tv/The.Big.Bang.Theory.S09E17.1080p.mkv",
      filename: "The.Big.Bang.Theory.S09E17.1080p.mkv",
      normalizedFilename: "big bang theory s09e17 1080p",
      extension: "mkv",
      parsedTitle: "big bang theory",
      parsedYear: null,
      season: 9,
      episode: 17,
      imdbId: "tt0898266",
      quality: "1080p",
      confidence: 95,
      sizeBytes: 1024,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ meta: { id: "tt0898266", name: "The Big Bang Theory" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/stream/series/tt0898266:9:17.json`).expect(200);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://v3-cinemeta.strem.io/meta/series/tt0898266.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://v3-cinemeta.strem.io/meta/series/tt0898266:9:17.json",
      expect.anything(),
    );
    expect(response.body.streams).toHaveLength(1);
    expect(response.body.streams[0].url).toMatch(
      new RegExp(`^https://addon\\.example\\.test/proxy/${created.installUrlToken}/\\d+$`),
    );
  });

  it("returns direct FTP stream URLs when profile stream delivery is direct", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveFtpConfig(created.profileId, {
      host: "ftp.example.test",
      port: 2121,
      username: "user name",
      password: "p@ss/word",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/movies"],
    });
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: false,
      streamDeliveryMode: "direct",
    });
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      mediaKind: "movie",
      ftpPath: "/movies/The.Matrix.1999.1080p.mkv",
      filename: "The.Matrix.1999.1080p.mkv",
      normalizedFilename: "the matrix 1999 1080p",
      extension: "mkv",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: "tt0133093",
      quality: "1080p",
      confidence: 95,
      sizeBytes: 1024,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ meta: { id: "tt0133093", name: "The Matrix", releaseInfo: "1999" } }),
      })),
    );
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/stream/movie/tt0133093.json`).expect(200);

    expect(response.body.streams[0].url).toBe(
      "ftp://user%20name:p%40ss%2Fword@ftp.example.test:2121/movies/The.Matrix.1999.1080p.mkv",
    );
  });

  it("returns duplicate title streams from every configured FTP server", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    const server1Id = service.defaultFtpServerId(created.profileId);
    service.saveFtpServer(created.profileId, server1Id, {
      name: "Server 1",
      ftpConfig: {
        host: "server1.example.test",
        port: 21,
        username: "user1",
        password: "secret1",
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/movies"],
      },
      customization: {
        catalogEnabled: true,
        catalogContentTypes: { movies: true, series: true, anime: false },
        streamDeliveryMode: "proxy",
      },
    });
    const server2 = service.createFtpServer(created.profileId, {
      name: "Server 2",
      ftpConfig: {
        host: "server2.example.test",
        port: 21,
        username: "user2",
        password: "secret2",
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/movies"],
      },
      customization: {
        catalogEnabled: true,
        catalogContentTypes: { movies: true, series: true, anime: false },
        streamDeliveryMode: "proxy",
      },
    });
    const repository = new MediaRepository(db);
    for (const [ftpServerId, filename] of [
      [server1Id, "The.Matrix.1999.1080p.mkv"],
      [server1Id, "The.Matrix.1999.2160p.mkv"],
      [server2.id, "The.Matrix.1999.720p.mkv"],
      [server2.id, "The.Matrix.1999.1080p.BluRay.mkv"],
      [server2.id, "The.Matrix.1999.2160p.HDR.mkv"],
    ] as const) {
      repository.upsertParsedFile(created.profileId, {
        ftpServerId,
        mediaKind: "movie",
        catalogKind: "movie",
        ftpPath: `/movies/${filename}`,
        filename,
        normalizedFilename: filename.toLowerCase(),
        extension: "mkv",
        parsedTitle: "matrix",
        parsedYear: 1999,
        season: null,
        episode: null,
        imdbId: "tt0133093",
        quality: filename.includes("2160p") ? "2160p" : filename.includes("720p") ? "720p" : "1080p",
        confidence: 95,
        sizeBytes: 1024,
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ meta: { id: "tt0133093", name: "The Matrix", releaseInfo: "1999" } }),
      })),
    );
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/stream/movie/tt0133093.json`).expect(200);

    expect(response.body.streams).toHaveLength(5);
    expect(response.body.streams.map((stream: { name: string }) => stream.name)).toEqual(
      expect.arrayContaining([
        "FTP Server 1 - 1080p",
        "FTP Server 1 - 2160p",
        "FTP Server 2 - 720p",
        "FTP Server 2 - 1080p",
        "FTP Server 2 - 2160p",
      ]),
    );
    expect(response.body.streams.map((stream: { description: string }) => stream.description)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Server 1\nThe.Matrix.1999.1080p.mkv"),
        expect.stringContaining("Server 2\nThe.Matrix.1999.2160p.HDR.mkv"),
      ]),
    );
  });

  it("uses saved custom stream formatter templates in Stremio stream results", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: false,
      streamNameTemplate: "{addon.name} | {stream.serverName} | {stream.quality}",
      streamDescriptionTemplate: "{stream.filename}{tools.newLine}{stream.size::bytes}{tools.newLine}{stream.deliveryMode::upper}",
    });
    const serverId = service.defaultFtpServerId(created.profileId);
    service.renameFtpServer(created.profileId, serverId, "Main FTP");
    const repository = new MediaRepository(db);
    repository.upsertParsedFile(created.profileId, {
      ftpServerId: serverId,
      mediaKind: "movie",
      ftpPath: "/movies/The.Matrix.1999.2160p.mkv",
      filename: "The.Matrix.1999.2160p.mkv",
      normalizedFilename: "the matrix 1999 2160p",
      extension: "mkv",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: "tt0133093",
      quality: "2160p",
      confidence: 95,
      sizeBytes: 5368709120,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ meta: { id: "tt0133093", name: "The Matrix", releaseInfo: "1999" } }),
      })),
    );
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/stream/movie/tt0133093.json`).expect(200);

    expect(response.header["cache-control"]).toContain("no-store");
    expect(response.body.streams[0]).toMatchObject({
      name: "Archive 3D | Main FTP | 2160p",
      description: "The.Matrix.1999.2160p.mkv\n5.0 GB\nPROXY",
    });
    expect(response.body.streams[0]).not.toHaveProperty("title");
  });

  it("keeps catalogs in the token manifest when direct FTP stream delivery is enabled", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    service.saveAddonCustomization(created.profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive from my FTP server.",
      catalogEnabled: true,
      catalogContentTypes: { movies: true, series: true, anime: true },
      streamDeliveryMode: "direct",
    });
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(200);

    expect(response.body.resources).toEqual(["stream", "catalog", "meta"]);
    expect(response.body.catalogs).toEqual([
      { type: "movie", id: "ftp-movies", name: "Archive 3D Movies", extra: CATALOG_EXTRAS },
      { type: "series", id: "ftp-series", name: "Archive 3D Series", extra: CATALOG_EXTRAS },
      { type: "series", id: "ftp-anime", name: "Archive 3D Anime", extra: CATALOG_EXTRAS },
      { type: "movie", id: "ftp-other", name: "Archive 3D Other", extra: CATALOG_EXTRAS },
    ]);
  });

  it("returns empty streams without fetching metadata for malformed Stremio ids", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(config, db);

    const response = await request(app).get(`/u/${created.installUrlToken}/stream/movie/not-imdb.json`).expect(200);

    expect(response.body).toEqual({ streams: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs unexpected stream resolution errors without exposing secrets", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, config.encryptionKey);
    const created = await service.createProfile("uid-12345678", "passphrase");
    const app = express();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ meta: { id: "tt0133093", name: "The Matrix", releaseInfo: "1999" } }),
      })),
    );

    app.use(
      stremioRoutes(config, service, {
        findMovie: () => {
          throw new Error("resolver failed token=abcdefghijklmnopqrstuvwxyz123456");
        },
      } as unknown as MediaRepository),
    );

    const response = await request(app).get(`/u/${created.installUrlToken}/stream/movie/tt0133093.json`).expect(200);

    expect(response.body).toEqual({ streams: [] });
    expect(errorSpy).toHaveBeenCalledWith("Stream resolution error:", expect.stringContaining("resolver failed"));
    expect(String(errorSpy.mock.calls[0][1])).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});
