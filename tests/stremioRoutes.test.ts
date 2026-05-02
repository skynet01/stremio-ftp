import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";
import { ProfileService } from "../src/server/profiles/profileService";

const config: AppConfig = {
  baseUrl: "https://addon.example.test",
  configDir: "/tmp",
  sqlitePath: ":memory:",
  encryptionKey: "0123456789abcdef0123456789abcdef",
  setupToken: "setup-secret-123",
  port: 7000,
  logLevel: "error",
  crawlerConcurrency: 2,
  ftpTimeoutMs: 15000,
  maxOnDemandSearchMs: 4500,
  profileRateLimitWindowMs: 600000,
  profileRateLimitMax: 30,
};

describe("stremio routes", () => {
  afterEach(() => {
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
      resources: ["stream"],
      types: ["movie", "series"],
      idPrefixes: ["tt"],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
    expect(response.header["access-control-allow-origin"]).toBe("*");
    expect(response.header["cross-origin-resource-policy"]).toBe("cross-origin");
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
});
