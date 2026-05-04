import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";
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

describe("stremio routes", () => {
  afterEach(() => {
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
    expect(response.body).toMatchObject({
      id: "community.stremio-ftp",
      version: "0.4.13",
      resources: ["stream"],
      types: ["movie", "series"],
      idPrefixes: ["tt"],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
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
      { type: "movie", id: "ftp-movies", name: "Archive 3D Movies", extra: [{ name: "skip" }] },
      { type: "series", id: "ftp-series", name: "Archive 3D Series", extra: [{ name: "skip" }] },
      { type: "movie", id: "ftp-other", name: "Archive 3D Other", extra: [{ name: "skip" }] },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/3/find/tt0133093");
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

    expect(String(fetchMock.mock.calls[0][0])).toContain("/3/search/movie");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/3/movie/791373/external_ids");
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
      ftpPath: "/misc/Home.Video.2024.mp4",
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
      id: expect.stringMatching(/^ftp:\d+$/),
      type: "movie",
      name: "Home Video",
      description: "Home.Video.2024.mp4",
      releaseInfo: "2024",
    });

    const stream = await request(app)
      .get(`/u/${created.installUrlToken}/stream/movie/${otherCatalog.body.metas[0].id}.json`)
      .expect(200);
    expect(stream.body.streams).toEqual([
      {
        name: "FTP Source",
        title: "FTP Source",
        description: "Home.Video.2024.mp4\n1 MB",
        url: `https://addon.example.test/proxy/${created.installUrlToken}/${otherCatalog.body.metas[0].id.replace("ftp:", "")}`,
        behaviorHints: {
          notWebReady: true,
          filename: "Home.Video.2024.mp4",
          videoSize: 1024 * 1024,
        },
      },
    ]);
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
    const repository = new MediaRepository(db);
    for (const filename of ["Home.Video.2024.1080p.mp4", "Home.Video.2024.2160p.mkv"]) {
      repository.upsertParsedFile(created.profileId, {
        mediaKind: "movie",
        catalogKind: "movie",
        ftpPath: `/misc/${filename}`,
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
      id: expect.stringMatching(/^ftp:\d+$/),
      name: "Home Video",
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
      { type: "series", id: "ftp-anime", name: "Archive 3D Anime", extra: [{ name: "skip" }] },
      { type: "movie", id: "ftp-other", name: "Archive 3D Other", extra: [{ name: "skip" }] },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api_key=profile-tmdb-key");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/3/search/tv");
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

  it("keeps TMDB-resolved duplicate formats out of the Other catalog", async () => {
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ id: 333339, title: "Ready Player One", release_date: "2018-03-29" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt1677720" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ ...config, tmdbApiKey: "tmdb-key" }, db);

    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(otherCatalog.body.metas).toEqual([]);
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

    expect(response.body.streams[0]).toMatchObject({
      name: "Archive 3D | Main FTP | 2160p",
      title: "Archive 3D | Main FTP | 2160p",
      description: "The.Matrix.1999.2160p.mkv\n5.0 GB\nPROXY",
    });
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
      { type: "movie", id: "ftp-movies", name: "Archive 3D Movies", extra: [{ name: "skip" }] },
      { type: "series", id: "ftp-series", name: "Archive 3D Series", extra: [{ name: "skip" }] },
      { type: "series", id: "ftp-anime", name: "Archive 3D Anime", extra: [{ name: "skip" }] },
      { type: "movie", id: "ftp-other", name: "Archive 3D Other", extra: [{ name: "skip" }] },
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
