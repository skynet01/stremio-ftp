import Database from "better-sqlite3";
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
    emptyProfileCleanupDays: 0,
    emptyProfileCleanupIntervalMs: 60000,
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

  it("promotes a profile to database admin and allows it to load admin summaries", async () => {
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

    const response = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "user-uid", passphrase: "passphrase" })
      .expect(200);
    expect(response.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browserUid: "user-uid", adminEnabled: true, adminSource: "database" }),
      ]),
    );
  });

  it("prevents database-only admins from demoting themselves", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/admin`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", adminEnabled: true })
      .expect(200);

    const response = await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/admin`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "user-uid", passphrase: "passphrase", adminEnabled: false })
      .expect(400);

    expect(response.body).toEqual({ error: "Cannot remove your only admin access" });
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
