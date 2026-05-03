import Database from "better-sqlite3";
import { Readable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";

function config(): AppConfig {
  return {
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
    maxOnDemandSearchMs: 4500,
    profileRateLimitWindowMs: 60000,
    profileRateLimitMax: 30,
    tmdbApiKey: null,
    scanGlobalConcurrency: 1,
    scanQueueMax: 10,
    scanCooldownMs: 60000,
    scanJobTimeoutMs: 1800000,
    scanSchedulerIntervalMs: 60000,
    scanProgressAverageItems: 2000,
  };
}

describe("profile routes", () => {
  it("creates a profile and returns install URLs", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    const response = await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    expect(response.body.manifestUrl).toMatch(/^https:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
    expect(response.body.stremioInstallUrl).toMatch(/^stremio:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
  });

  it("returns 400 for an invalid create payload", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    const response = await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "short", passphrase: "short" })
      .expect(400);

    expect(response.body).toEqual({ error: "Invalid profile request" });
  });

  it("returns 409 for duplicate browser uid creation", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);
    const response = await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(409);

    expect(response.body).toEqual({ error: "Profile already exists" });
  });

  it("unlocks a profile and returns the profile id", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    const created = await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);
    const response = await request(app)
      .post("/api/profile/unlock")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.profileId).toBe(created.body.profileId);
    expect(response.body.manifestUrl).toMatch(/^https:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
    expect(response.body.stremioInstallUrl).toMatch(/^stremio:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
  });

  it("keeps the previous install token valid after unlocking a profile", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    const created = await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);
    const originalToken = String(created.body.manifestUrl).match(/\/u\/([^/]+)\/manifest\.json$/)?.[1];
    expect(originalToken).toBeTruthy();

    const unlocked = await request(app)
      .post("/api/profile/unlock")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);
    const unlockedToken = String(unlocked.body.manifestUrl).match(/\/u\/([^/]+)\/manifest\.json$/)?.[1];
    expect(unlockedToken).toBeTruthy();
    expect(unlockedToken).not.toBe(originalToken);

    const originalManifest = await request(app).get(`/u/${originalToken}/manifest.json`).expect(200);
    const unlockedManifest = await request(app).get(`/u/${unlockedToken}/manifest.json`).expect(200);
    expect(originalManifest.body.name).toBe("Stremio FTP Addon");
    expect(unlockedManifest.body.name).toBe("Stremio FTP Addon");
  });

  it("returns 401 for an incorrect unlock passphrase", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);
    const response = await request(app)
      .post("/api/profile/unlock")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "incorrect" })
      .expect(401);

    expect(response.body).toEqual({ error: "Invalid passphrase" });
  });

  it("rate limits repeated profile creation attempts from the same client", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp({ ...config(), profileRateLimitMax: 2 }, db);

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid-1", passphrase: "passphrase" })
      .expect(201);
    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid-2", passphrase: "passphrase" })
      .expect(201);
    const response = await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid-3", passphrase: "passphrase" })
      .expect(429);

    expect(response.body).toEqual({ error: "Too many profile attempts" });
  });

  it("saves FTP settings and enqueues a background media index refresh", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db, {
      ftpClientFactory: async () => ({
        list: async (path) =>
          path === "/Movies"
            ? [
                {
                  name: "The.Matrix.1999.1080p.mkv",
                  path: "/Movies/The.Matrix.1999.1080p.mkv",
                  type: "file",
                  size: 1024,
                },
              ]
            : [],
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
    });

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);
    const ftpConfig = {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "explicit",
      allowInvalidCertificate: true,
      roots: ["/Movies"],
    };

    await request(app)
      .post("/api/profile/ftp")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase", ftpConfig })
      .expect(200);
    const response = await request(app)
      .post("/api/profile/index/rescan")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.scanStatus).toMatchObject({
      id: expect.any(Number),
      status: expect.stringMatching(/queued|running|succeeded/),
      trigger: "manual",
    });

    let status = response.body.scanStatus;
    for (let attempt = 0; attempt < 20 && status.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const statusResponse = await request(app)
        .post("/api/profile/index/status")
        .set("x-setup-token", "setup-secret-123")
        .send({ browserUid: "browser-uid", passphrase: "passphrase" })
        .expect(200);
      status = statusResponse.body.scanStatus;
    }

    expect(status.filesSeen).toBe(1);
    expect(status.mediaItems).toBe(1);
    expect(status.finishedAt).toEqual(expect.any(String));

    const loaded = await request(app)
      .post("/api/profile/ftp/load")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);

    expect(loaded.body.indexStatus.mediaItems).toBe(1);
    expect(loaded.body.scanStatus.status).toBe("succeeded");
    expect(loaded.body.scanSchedule).toEqual({ intervalMinutes: 0, nextScheduledScanAt: null });
  });

  it("saves scan schedule settings", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    const response = await request(app)
      .post("/api/profile/index/schedule")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase", intervalMinutes: 360 })
      .expect(200);

    expect(response.body.scanSchedule.intervalMinutes).toBe(360);
    expect(response.body.scanSchedule.nextScheduledScanAt).toEqual(expect.any(String));
  });

  it("loads saved FTP settings with the saved password after authentication", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    await request(app)
      .post("/api/profile/ftp")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 2121,
          username: "user",
          password: "secret",
          tlsMode: "explicit",
          allowInvalidCertificate: true,
          roots: ["/Movies", "/TV"],
        },
      })
      .expect(200);

    const response = await request(app)
      .post("/api/profile/ftp/load")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body).toEqual({
      ftpConfig: {
        host: "ftp.example.test",
        port: 2121,
        username: "user",
        password: "",
        passwordConfigured: true,
        tlsMode: "explicit",
        allowInvalidCertificate: true,
        roots: ["/Movies", "/TV"],
      },
      indexStatus: {
        lastScanAt: null,
        mediaItems: 0,
      },
      scanStatus: {
        id: null,
        status: "idle",
        trigger: null,
        progressPercent: 0,
        entriesSeen: 0,
        filesSeen: 0,
        directoriesSeen: 0,
        currentPath: null,
        estimatedSecondsRemaining: null,
        message: null,
        error: null,
        queuedAt: null,
        startedAt: null,
        finishedAt: null,
        mediaItems: 0,
      },
      scanSchedule: {
        intervalMinutes: 0,
        nextScheduledScanAt: null,
      },
      connectionStatus: {
        lastTestedAt: null,
        ok: null,
      },
    });
  });

  it("rejects profile APIs without a setup token by default", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp({ ...config(), setupToken: null }, db);

    const response = await request(app)
      .post("/api/profile")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(403);

    expect(response.body).toEqual({ error: "Invalid setup token" });
  });

  it("allows profile APIs without a setup token when public profile APIs are explicitly enabled", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp({ ...config(), setupToken: null, allowPublicProfileApi: true }, db);

    const response = await request(app)
      .post("/api/profile")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    expect(response.body.manifestUrl).toMatch(/^https:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
  });

  it("does not accept setup tokens from query strings on profile APIs", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    const response = await request(app)
      .post("/api/profile?setup=setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(403);

    expect(response.body).toEqual({ error: "Invalid setup token" });
  });

  it("preserves the stored FTP password when editing with a blank password", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    await request(app)
      .post("/api/profile/ftp")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "secret",
          tlsMode: "explicit",
          allowInvalidCertificate: true,
          roots: ["/Movies"],
        },
      })
      .expect(200);

    await request(app)
      .post("/api/profile/ftp")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp2.example.test",
          port: 2121,
          username: "user2",
          password: "",
          tlsMode: "none",
          allowInvalidCertificate: false,
          roots: ["/TV"],
        },
      })
      .expect(200);

    const response = await request(app)
      .post("/api/profile/ftp/load")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.ftpConfig).toMatchObject({
      host: "ftp2.example.test",
      port: 2121,
      username: "user2",
      password: "",
      passwordConfigured: true,
      tlsMode: "none",
      roots: ["/TV"],
    });
  });

  it("tests FTP settings with the stored password when the password field is blank", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db, {
      ftpClientFactory: async (ftpConfig) => {
        if (ftpConfig.password !== "secret") throw new Error("Expected saved password");
        return {
          list: async () => [],
          openReadStream: async () => Readable.from("not used"),
          close: async () => undefined,
        };
      },
    });

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    await request(app)
      .post("/api/profile/ftp")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "secret",
          tlsMode: "explicit",
          allowInvalidCertificate: true,
          roots: ["/Movies"],
        },
      })
      .expect(200);

    const testResponse = await request(app)
      .post("/api/profile/ftp/test")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "",
          tlsMode: "explicit",
          allowInvalidCertificate: true,
          roots: ["/Movies"],
        },
      })
      .expect(200);

    expect(testResponse.body).toEqual({
      ok: true,
      connectionStatus: {
        lastTestedAt: expect.any(String),
        ok: true,
      },
    });

    const loaded = await request(app)
      .post("/api/profile/ftp/load")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);

    expect(loaded.body.connectionStatus).toEqual(testResponse.body.connectionStatus);
  });

  it("saves and loads profile addon customization", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    await request(app)
      .post("/api/profile/customization")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        customization: {
          addonName: "Archive 3D",
          addonLogoUrl: "https://cdn.example.test/logo.png",
          addonDescription: "Stream the archive from my FTP server.",
          catalogEnabled: true,
          catalogTmdbApiKey: "profile-tmdb-key",
          catalogContentTypes: { movies: true, series: false, anime: true },
          libraryLayout: "folders",
          streamDeliveryMode: "direct",
        },
      })
      .expect(200);

    const response = await request(app)
      .post("/api/profile/customization/load")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body).toEqual({
      customization: {
        addonName: "Archive 3D",
        addonLogoUrl: "https://cdn.example.test/logo.png",
        addonDescription: "Stream the archive from my FTP server.",
        catalogEnabled: true,
        catalogTmdbApiKey: "profile-tmdb-key",
        catalogContentTypes: { movies: true, series: false, anime: true },
        libraryLayout: "folders",
        streamDeliveryMode: "direct",
      },
    });
  });

  it("returns the FTP list error when testing an invalid root path", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db, {
      ftpClientFactory: async () => ({
        list: async (path) => {
          throw new Error(`450 ${path}: No such file or directory`);
        },
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
    });

    await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);

    const response = await request(app)
      .post("/api/profile/ftp/test")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "secret",
          tlsMode: "explicit",
          allowInvalidCertificate: true,
          roots: ["/media"],
        },
      })
      .expect(400);

    expect(response.body).toEqual({ error: "FTP error: 450 /media: No such file or directory" });
  });

  it("proxies indexed FTP files for the matching install token", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db, {
      ftpClientFactory: async () => ({
        list: async () => [],
        openReadStream: async (_path, { start, end }) => Readable.from(Buffer.from("0123456789").subarray(start, end + 1)),
        close: async () => undefined,
      }),
    });

    const created = await request(app)
      .post("/api/profile")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(201);
    const token = String(created.body.manifestUrl).match(/\/u\/([^/]+)\/manifest\.json$/)?.[1];
    expect(token).toBeTruthy();

    await request(app)
      .post("/api/profile/ftp")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "browser-uid",
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "secret",
          tlsMode: "explicit",
          allowInvalidCertificate: true,
          roots: ["/Movies"],
        },
      })
      .expect(200);

    const fileId = Number(
      db
        .prepare(
          `
          insert into media_files (
            profile_id, ftp_path, filename, normalized_filename, extension, media_kind, parsed_title,
            parsed_year, season, episode, imdb_id, quality, confidence, size_bytes, last_seen_at
          ) values (1, '/Movies/video.mkv', 'video.mkv', 'video', 'mkv', 'movie', 'video',
            null, null, null, null, null, 90, 10, 'now')
        `,
        )
        .run().lastInsertRowid,
    );

    const response = await request(app).get(`/proxy/${token}/${fileId}`).set("Range", "bytes=2-5").expect(206);

    expect(response.text ?? Buffer.from(response.body).toString("utf8")).toBe("2345");
  });

  it("rejects profile APIs without the setup token", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);

    const response = await request(app)
      .post("/api/profile")
      .send({ browserUid: "browser-uid", passphrase: "passphrase" })
      .expect(403);

    expect(response.body).toEqual({ error: "Invalid setup token" });
  });
});
