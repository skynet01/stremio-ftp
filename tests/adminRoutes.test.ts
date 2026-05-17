import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
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
    ftpMaxConnections: 4,
    maxOnDemandSearchMs: 4500,
    profileRateLimitWindowMs: 60000,
    profileRateLimitMax: 30,
    tmdbApiKey: null,
    scanGlobalConcurrency: 1,
    scanQueueMax: 10,
    scanCooldownMs: 60000,
    scanMinRescanIntervalMinutes: 0,
    scanJobTimeoutMs: 1800000,
    scanSchedulerIntervalMs: 60000,
    scanProgressAverageItems: 2000,
    scanTransientRetryDelayMs: 300000,
    maxFtpServersPerProfile: 0,
    proxyStreamsDisabled: false,
    adminBrowserUids: new Set(["admin-uid"]),
    superAdminBrowserUids: new Set(["admin-uid"]),
    emptyProfileCleanupDays: 0,
    emptyProfileCleanupIntervalMs: 60000,
    ...overrides,
  };
}

async function createProfile(app: ReturnType<typeof createApp>, browserUid: string, passphrase = "passphrase", countryCode?: string) {
  return request(app)
    .post("/api/profile")
    .set("x-setup-token", "setup-secret-123")
    .set(countryCode ? { "cf-ipcountry": countryCode } : {})
    .send({ browserUid, passphrase })
    .expect(201);
}

async function saveDefaultFtp(app: ReturnType<typeof createApp>, browserUid: string, host = "ftp.example.test") {
  return request(app)
    .post("/api/profile/ftp")
    .set("x-setup-token", "setup-secret-123")
    .send({
      browserUid,
      passphrase: "passphrase",
      ftpConfig: {
        host,
        port: 21,
        username: "user",
        password: "secret",
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/"],
      },
    })
    .expect(200);
}

async function createAndSaveFtpServer(app: ReturnType<typeof createApp>, browserUid: string, name: string, host: string) {
  const created = await request(app)
    .post("/api/profile/servers")
    .set("x-setup-token", "setup-secret-123")
    .send({ browserUid, passphrase: "passphrase" })
    .expect(201);

  return request(app)
    .post("/api/profile/servers/save")
    .set("x-setup-token", "setup-secret-123")
    .send({
      browserUid,
      passphrase: "passphrase",
      serverId: created.body.server.id,
      name,
      ftpConfig: {
        host,
        port: 21,
        username: "user",
        password: "secret",
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/"],
      },
      customization: {
        catalogEnabled: false,
        catalogContentTypes: { movies: true, series: true, anime: false },
        libraryLayout: "auto",
        streamDeliveryMode: "proxy",
      },
    })
    .expect(200);
}

describe("admin routes", () => {
  it("requires setup token and admin profile credentials", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    await createProfile(app, "user-uid");

    await request(app).post("/api/admin/profiles").send({ browserUid: "admin-uid", passphrase: "passphrase" }).expect(403);
    await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "user-uid", passphrase: "passphrase" })
      .expect(403);
    await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "wrong-passphrase" })
      .expect(401);
  });

  it("requires super admin env access instead of admin-enabled access for admin APIs", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ adminBrowserUids: new Set(["admin-uid"]), superAdminBrowserUids: new Set(["super-admin-uid"]) }), db);
    await createProfile(app, "admin-uid");
    await createProfile(app, "super-admin-uid");

    await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(403);

    await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "super-admin-uid", passphrase: "passphrase" })
      .expect(200);
  });

  it("lists profile summaries for an admin", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid", "passphrase", "CA");

    const response = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.summary.profiles).toBe(2);
    expect(response.body.summary.ftpServers).toBe(2);
    expect(response.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: user.body.profileId,
          browserUid: "user-uid",
          ftpServers: 1,
          configuredFtpServers: 0,
          indexedItems: 0,
          activeScans: 0,
          pendingScans: 0,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "CA",
          adminEnabled: false,
          adminSource: null,
        }),
      ]),
    );
    expect(response.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          browserUid: "admin-uid",
          adminEnabled: true,
          adminSource: "environment",
        }),
      ]),
    );
  });

  it("promotes a profile to database admin without granting admin API access", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    const promoted = await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/admin`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", adminEnabled: true })
      .expect(200);

    expect(promoted.body).toEqual({ profileId: user.body.profileId, adminEnabled: true, adminSource: "database" });

    await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "user-uid", passphrase: "passphrase" })
      .expect(403);

    const response = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(response.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browserUid: "user-uid", adminEnabled: true, adminSource: "database" }),
      ]),
    );
  });

  it("issues a fresh manifest URL and keeps it usable", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    const response = await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/manifest-token`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.manifestUrl).toMatch(/^https:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
    const token = String(response.body.manifestUrl).match(/\/u\/([^/]+)\/manifest\.json$/)?.[1];
    expect(token).toBeTruthy();
    await request(app).get(`/u/${token}/manifest.json`).expect(200);
  });

  it("queues a profile rescan for a super admin", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    const response = await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/rescan`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.profileId).toBe(user.body.profileId);
    expect(response.body.scanStatus).toEqual(expect.objectContaining({ status: "queued", trigger: "manual" }));
  });

  it("runs bulk admin actions for selected profiles", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const first = await createProfile(app, "first-user-uid");
    const second = await createProfile(app, "second-user-uid");
    await saveDefaultFtp(app, "first-user-uid", "first.example.test");
    await saveDefaultFtp(app, "second-user-uid", "second.example.test");

    db.prepare("update profiles set stream_delivery_mode = 'direct' where id in (?, ?)").run(first.body.profileId, second.body.profileId);
    db.prepare("update profile_ftp_servers set stream_delivery_mode = 'direct' where profile_id in (?, ?)").run(first.body.profileId, second.body.profileId);

    const converted = await request(app)
      .post("/api/admin/profiles/bulk")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [first.body.profileId, second.body.profileId], action: "convert_to_proxy" })
      .expect(200);
    expect(converted.body).toMatchObject({
      action: "convert_to_proxy",
      profileIds: [first.body.profileId, second.body.profileId],
      converted: 2,
      summary: { profiles: 2, servers: 2, converted: 2 },
    });
    expect(
      db.prepare("select count(*) as count from profiles where id in (?, ?) and stream_delivery_mode = 'proxy'").get(first.body.profileId, second.body.profileId),
    ).toEqual({ count: 2 });
    expect(
      db.prepare("select count(*) as count from profile_ftp_servers where profile_id in (?, ?) and stream_delivery_mode = 'proxy'").get(first.body.profileId, second.body.profileId),
    ).toEqual({ count: 2 });

    const rescanned = await request(app)
      .post("/api/admin/profiles/bulk")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [first.body.profileId, second.body.profileId], action: "rescan" })
      .expect(200);
    expect(rescanned.body.summary).toMatchObject({ profiles: 2, servers: 2, queued: 2, skipped: 0 });

    const deleted = await request(app)
      .post("/api/admin/profiles/bulk")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [first.body.profileId, second.body.profileId], action: "delete" })
      .expect(200);
    expect(deleted.body).toMatchObject({
      action: "delete",
      profileIds: [first.body.profileId, second.body.profileId],
      deleted: 2,
      summary: { profiles: 2, deleted: 2 },
    });
  });

  it("bulk rescans and cancels every configured FTP server in selected profiles", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");
    await saveDefaultFtp(app, "user-uid", "main.example.test");
    await createAndSaveFtpServer(app, "user-uid", "Mirror", "mirror.example.test");

    const rescanned = await request(app)
      .post("/api/admin/profiles/bulk")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [user.body.profileId], action: "rescan" })
      .expect(200);
    expect(rescanned.body.summary).toMatchObject({ profiles: 1, servers: 2, queued: 2, skipped: 0 });
    expect(rescanned.body.scans).toEqual([
      expect.objectContaining({ profileId: user.body.profileId, scanStatus: expect.objectContaining({ status: "queued" }) }),
      expect.objectContaining({ profileId: user.body.profileId, scanStatus: expect.objectContaining({ status: "queued" }) }),
    ]);

    const listed = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(listed.body.profiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: user.body.profileId, activeScans: 0, pendingScans: 2 })]),
    );

    const cancelled = await request(app)
      .post("/api/admin/profiles/bulk")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [user.body.profileId], action: "cancel_scan" })
      .expect(200);
    expect(cancelled.body.summary).toMatchObject({ profiles: 1, servers: 2, cancelled: 2 });
  });

  it("bulk cancel clears scheduled retry scans", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");
    await saveDefaultFtp(app, "user-uid", "main.example.test");
    const serverId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(user.body.profileId) as number;
    db.prepare("update profile_ftp_servers set pending_scan_after = ? where id = ?").run("2026-05-17T12:00:00.000Z", serverId);

    const cancelled = await request(app)
      .post("/api/admin/profiles/bulk")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [user.body.profileId], action: "cancel_scan" })
      .expect(200);

    expect(cancelled.body.summary).toMatchObject({ profiles: 1, servers: 1, cancelled: 1 });
    expect(db.prepare("select pending_scan_after from profile_ftp_servers where id = ?").pluck().get(serverId)).toBeNull();
  });

  it("deletes a target profile", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/delete`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    const response = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(response.body.profiles.map((profile: { browserUid: string }) => profile.browserUid)).not.toContain("user-uid");
  });
});
