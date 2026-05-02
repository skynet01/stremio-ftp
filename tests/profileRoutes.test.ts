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
    port: 7000,
    logLevel: "error",
    crawlerConcurrency: 2,
    ftpTimeoutMs: 15000,
    maxOnDemandSearchMs: 4500,
    profileRateLimitWindowMs: 60000,
    profileRateLimitMax: 30,
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

    expect(response.body).toEqual({ profileId: created.body.profileId });
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

  it("saves FTP settings and refreshes the media index", async () => {
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

    expect(response.body).toEqual({ filesSeen: 1 });
  });

  it("loads saved FTP settings without exposing the password", async () => {
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
    });
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
      passwordConfigured: true,
      tlsMode: "none",
      roots: ["/TV"],
    });
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
