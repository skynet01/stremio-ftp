import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import { ProfileService } from "../src/server/profiles/profileService";
import { decryptJson, encryptJson } from "../src/server/security/crypto";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("returns JSON 500s for unexpected admin failures instead of auth or validation errors", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const updateFailure = vi.spyOn(ProfileService.prototype, "updateSharedIndexGroup").mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const updated = await request(app)
      .post("/api/admin/shared-index-groups/1/update")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", name: "Renamed" })
      .expect(500);
    expect(updated.body).toEqual({ error: "Internal server error" });
    updateFailure.mockRestore();

    const unlockFailure = vi.spyOn(ProfileService.prototype, "unlockProfile").mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    const listed = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(500);
    expect(listed.body).toEqual({ error: "Internal server error" });
    unlockFailure.mockRestore();
    errorSpy.mockRestore();
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
          lastManifestAccessedAt: null,
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

  it("returns the current admin stream status", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");

    const response = await request(app)
      .post("/api/admin/streams")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body).toEqual({
      activeStreams: [],
      summary: { active: 0, profile: 0, shared: 0 },
    });
  });

  it("counts linked shared indexes plus unlinked local indexes in admin profile summaries", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");
    await saveDefaultFtp(app, "user-uid", "shared.example.test");
    await createAndSaveFtpServer(app, "user-uid", "Local", "local.example.test");

    const sharedServerId = db.prepare("select id from profile_ftp_servers where profile_id = ? and name = 'Server 1'").pluck().get(user.body.profileId) as number;
    const localServerId = db.prepare("select id from profile_ftp_servers where profile_id = ? and name = 'Local'").pluck().get(user.body.profileId) as number;

    const createdGroup = await request(app)
      .post("/api/admin/shared-index-groups/create")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "admin-uid",
        passphrase: "passphrase",
        profileId: user.body.profileId,
        serverId: sharedServerId,
        name: "Shared Library",
        keyHint: "shared-library",
      })
      .expect(200);
    const groupId = createdGroup.body.group.id;

    db.prepare("update shared_index_groups set indexed_media_count = ?, last_indexed_at = ? where id = ?").run(1000, "2026-05-22T12:00:00.000Z", groupId);
    db.prepare("update profile_ftp_servers set indexed_media_count = ?, last_indexed_at = ? where id = ?").run(10, "2026-05-01T12:00:00.000Z", sharedServerId);
    db.prepare("update profile_ftp_servers set indexed_media_count = ?, last_indexed_at = ? where id = ?").run(25, "2026-05-02T12:00:00.000Z", localServerId);

    const response = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.summary.indexedItems).toBe(1025);
    expect(response.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: user.body.profileId,
          indexedItems: 1025,
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

    const listed = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(listed.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: user.body.profileId, lastManifestAccessedAt: expect.any(String) }),
      ]),
    );
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

  it("routes admin rescans of shared index servers to the shared group scan", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const master = await createProfile(app, "master-uid");
    const linked = await createProfile(app, "linked-uid");
    await saveDefaultFtp(app, "master-uid", "sputnik.whatbox.ca");
    await saveDefaultFtp(app, "linked-uid", "sputnik.whatbox.ca");
    const masterServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(master.body.profileId) as number;
    const linkedServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(linked.body.profileId) as number;
    const created = await request(app)
      .post("/api/admin/shared-index-groups/create")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: master.body.profileId, serverId: masterServerId, name: "Sputnik Main" })
      .expect(200);
    const groupId = created.body.group.id;
    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/link-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(200);
    db.prepare("delete from scan_jobs").run();

    for (const profileId of [master.body.profileId, linked.body.profileId]) {
      const response = await request(app)
        .post(`/api/admin/profiles/${profileId}/rescan`)
        .set("x-setup-token", "setup-secret-123")
        .send({ browserUid: "admin-uid", passphrase: "passphrase" })
        .expect(200);
      expect(response.body).toMatchObject({ profileId, scanStatus: { status: "queued", trigger: "manual" } });
    }

    expect(db.prepare("select target_kind, shared_index_group_id, status from scan_jobs").all()).toEqual([
      { target_kind: "shared_group", shared_index_group_id: groupId, status: "queued" },
    ]);
  });

  it("schedules a prompt local rescan when admin unlinks a server", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const master = await createProfile(app, "master-uid");
    const linked = await createProfile(app, "linked-uid");
    await saveDefaultFtp(app, "master-uid", "sputnik.whatbox.ca");
    await saveDefaultFtp(app, "linked-uid", "sputnik.whatbox.ca");
    const masterServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(master.body.profileId) as number;
    const linkedServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(linked.body.profileId) as number;
    const created = await request(app)
      .post("/api/admin/shared-index-groups/create")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: master.body.profileId, serverId: masterServerId, name: "Sputnik Main" })
      .expect(200);
    const groupId = created.body.group.id;
    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/link-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(200);

    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/unlink-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(200);

    const pendingScanAfter = db.prepare("select pending_scan_after from profile_ftp_servers where id = ?").pluck().get(linkedServerId) as string | null;
    expect(pendingScanAfter).toEqual(expect.any(String));
    expect(Date.parse(pendingScanAfter!)).toBeLessThanOrEqual(Date.now());
  });

  it("stops a queued local scan when admin links the server to a shared index", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const master = await createProfile(app, "master-uid");
    const linked = await createProfile(app, "linked-uid");
    await saveDefaultFtp(app, "master-uid", "sputnik.whatbox.ca");
    await saveDefaultFtp(app, "linked-uid", "sputnik.whatbox.ca");
    const masterServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(master.body.profileId) as number;
    const linkedServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(linked.body.profileId) as number;
    await request(app)
      .post(`/api/admin/profiles/${linked.body.profileId}/rescan`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    const created = await request(app)
      .post("/api/admin/shared-index-groups/create")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: master.body.profileId, serverId: masterServerId, name: "Sputnik Main" })
      .expect(200);

    await request(app)
      .post(`/api/admin/shared-index-groups/${created.body.group.id}/link-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(200);

    expect(
      db.prepare("select status from scan_jobs where target_kind = 'profile_server' and ftp_server_id = ? order by id").pluck().all(linkedServerId),
    ).toEqual(["cancelled"]);
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

  it("manages shared index groups without returning FTP credentials", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config({ scanGlobalConcurrency: 0 }), db);
    await createProfile(app, "admin-uid");
    const master = await createProfile(app, "master-uid", "passphrase", "US");
    const linked = await createProfile(app, "linked-uid", "passphrase", "CA");
    const other = await createProfile(app, "other-uid");
    await saveDefaultFtp(app, "master-uid", "sputnik.whatbox.ca");
    await saveDefaultFtp(app, "linked-uid", "sputnik.whatbox.ca");
    await saveDefaultFtp(app, "other-uid", "different.whatbox.ca");

    const masterServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(master.body.profileId) as number;
    const linkedServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(linked.body.profileId) as number;
    const otherServerId = db.prepare("select id from profile_ftp_servers where profile_id = ?").pluck().get(other.body.profileId) as number;

    const created = await request(app)
      .post("/api/admin/shared-index-groups/create")
      .set("x-setup-token", "setup-secret-123")
      .send({
        browserUid: "admin-uid",
        passphrase: "passphrase",
        profileId: master.body.profileId,
        serverId: masterServerId,
        name: "Sputnik Main",
        keyHint: "sputnik-main",
      })
      .expect(200);
    expect(created.body.sharedIndexKey).toHaveLength(43);
    expect(JSON.stringify(created.body)).not.toContain("secret");
    expect(created.body.group).toMatchObject({
      name: "Sputnik Main",
      keyHint: "sputnik-main",
      host: "sputnik.whatbox.ca",
      linkedServerCount: 1,
      masterServer: { profileId: master.body.profileId, browserUid: "master-uid", countryCode: "US", serverId: masterServerId, serverName: "Server 1" },
      scanSchedule: { intervalMinutes: 720, nextScheduledScanAt: expect.any(String) },
      scanStatus: expect.objectContaining({ status: "idle" }),
    });

    const groupId = created.body.group.id;
    const scheduled = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/schedule`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", intervalMinutes: 360 })
      .expect(200);
    expect(scheduled.body.group.scanSchedule.intervalMinutes).toBe(360);
    expect(scheduled.body.scanSchedule).toEqual({ intervalMinutes: 360, nextScheduledScanAt: expect.any(String) });

    const profileList = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(profileList.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: master.body.profileId,
          ftpServerDetails: expect.arrayContaining([
            expect.objectContaining({
              id: masterServerId,
              lastIndexedAt: null,
              sharedIndex: expect.objectContaining({ id: groupId, autoLinked: false, lastIndexedAt: null }),
            }),
          ]),
        }),
      ]),
    );

    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/link-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: other.body.profileId, serverId: otherServerId })
      .expect(400);

    db.prepare("update shared_index_groups set root_paths_json = ? where id = ?").run(JSON.stringify(["/"]), groupId);
    db.prepare("update profile_ftp_servers set encrypted_ftp_config = ? where id = ?").run(
      encryptJson({
        host: "sputnik.whatbox.ca",
        port: 21,
        username: "user",
        password: "secret",
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/JFC"],
      }, config().encryptionKey),
      linkedServerId,
    );
    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/link-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(400);

    const forcedResponse = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/link-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId, force: true })
      .expect(200);
    expect(forcedResponse.body.group.linkedServerCount).toBe(2);
    const forcedConfig = decryptJson<{ roots: string[] }>(
      db.prepare("select encrypted_ftp_config from profile_ftp_servers where id = ?").pluck().get(linkedServerId) as string,
      config().encryptionKey,
    );
    expect(forcedConfig.roots).toEqual(["/"]);

    const linkedResponse = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/link-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(200);
    expect(linkedResponse.body.group.linkedServerCount).toBe(2);
    expect(linkedResponse.body.group.linkedServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: master.body.profileId, countryCode: "US", serverId: masterServerId }),
        expect.objectContaining({ profileId: linked.body.profileId, countryCode: "CA", serverId: linkedServerId }),
      ]),
    );

    const listed = await request(app)
      .post("/api/admin/shared-index-groups")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(listed.body.groups).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.sharedIndexKey);
    expect(JSON.stringify(listed.body)).not.toContain("secret");

    const updated = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/update`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", name: "Sputnik Updated", autoLinkImports: false })
      .expect(200);
    expect(updated.body.group).toMatchObject({ name: "Sputnik Updated", autoLinkImports: false });

    const rotated = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/rotate-key`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(rotated.body.sharedIndexKey).toHaveLength(43);
    expect(rotated.body.sharedIndexKey).not.toBe(created.body.sharedIndexKey);

    const masterChanged = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/master`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(200);
    expect(masterChanged.body.group.masterServer).toMatchObject({ profileId: linked.body.profileId, serverId: linkedServerId });

    const rescanned = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/rescan`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(rescanned.body.scanStatus).toEqual(expect.objectContaining({ status: "queued", trigger: "manual" }));

    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/delete`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(400);

    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/update`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", enabled: false })
      .expect(200);

    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/delete`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(409);

    const cancelled = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/cancel-scan`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(cancelled.body.scanStatus).toEqual(expect.objectContaining({ status: "cancelled" }));

    const unlinked = await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/unlink-server`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase", profileId: linked.body.profileId, serverId: linkedServerId })
      .expect(200);
    expect(unlinked.body.group).toMatchObject({ linkedServerCount: 1, masterServer: null });

    await request(app)
      .post(`/api/admin/shared-index-groups/${groupId}/delete`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    const emptyList = await request(app)
      .post("/api/admin/shared-index-groups")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(emptyList.body.groups).toHaveLength(0);
  });
});
