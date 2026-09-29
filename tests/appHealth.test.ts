import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { openDatabase } from "../src/server/db/database";
import { migrate } from "../src/server/db/schema";
import { ProfileService } from "../src/server/profiles/profileService";
import { ScanQueue } from "../src/server/scanner/scanQueue";

describe("app health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves health response", async () => {
    const db = new Database(":memory:");
    migrate(db);
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
    const response = await request(createApp(config, db)).get("/health").expect(200);
    expect(response.body).toEqual({ ok: true, service: "stremio-ftp", baseUrl: "https://addon.example.test" });
  });

  it("allows external HTTPS addon avatar images in the portal CSP", async () => {
    const db = new Database(":memory:");
    migrate(db);
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

    const response = await request(createApp(config, db)).get("/health").expect(200);

    expect(response.header["content-security-policy"]).toContain("img-src 'self' data: https:");
    expect(response.header["content-security-policy"]).toContain("connect-src 'self' https://api.github.com");
  });

  it("does not force HTTPS upgrades when serving over plain HTTP", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const config: AppConfig = {
      baseUrl: "http://192.168.66.174:7021",
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

    const response = await request(createApp(config, db)).get("/health").expect(200);

    expect(response.header["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });

  it("serves the configuration portal at /configure", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const publicDir = path.join(tmpdir(), `stremio-ftp-public-${Date.now()}`);
    mkdirSync(publicDir);
    writeFileSync(path.join(publicDir, "index.html"), "<html><body>configure app</body></html>");
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

    const response = await request(createApp(config, db, { publicDir }))
      .get("/configure")
      .query({ setup: "setup-secret-123" })
      .expect(200);

    expect(response.text).toContain("configure app");
  });

  it("serves the configuration shell without the setup token", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const publicDir = path.join(tmpdir(), `stremio-ftp-public-${Date.now()}`);
    mkdirSync(publicDir);
    writeFileSync(path.join(publicDir, "index.html"), "<html><body>configure app</body></html>");
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

    const missingToken = await request(createApp(config, db, { publicDir })).get("/configure").expect(200);
    const withToken = await request(createApp(config, db, { publicDir })).get("/configure").query({ setup: "setup-secret-123" }).expect(200);

    expect(missingToken.text).toContain("configure app");
    expect(withToken.text).toContain("configure app");
  });

  it("validates setup tokens before unlocking configuration APIs", async () => {
    const db = new Database(":memory:");
    migrate(db);
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
    const app = createApp(config, db);

    await request(app).get("/api/setup/validate").set("x-setup-token", "wrong-token").expect(403);
    const response = await request(app).get("/api/setup/validate").set("x-setup-token", "setup-secret-123").expect(200);

    expect(response.body).toEqual({ ok: true });
  });

  it("keeps running when a scheduled scan tick throws", () => {
    vi.useFakeTimers();
    try {
      const db = new Database(":memory:");
      migrate(db);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const tick = vi.spyOn(ScanQueue.prototype, "enqueueDueScheduledScans").mockImplementation(() => {
        throw new Error("Shared index group has no valid master server password=hunter2");
      });
      createApp({ ...loadMinimalConfig(), scanSchedulerIntervalMs: 1000 }, db);

      expect(() => vi.advanceTimersByTime(2500)).not.toThrow();

      expect(tick).toHaveBeenCalledTimes(2);
      const logged = errorSpy.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("Shared index group has no valid master server");
      expect(logged).not.toContain("hunter2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens file databases in WAL mode with normal synchronous writes", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "stremio-ftp-db-"));
    const db = openDatabase(path.join(directory, "app.sqlite"));
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns JSON errors for malformed request bodies", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(loadMinimalConfig(), db);

    const response = await request(app)
      .post("/api/profile/unlock")
      .set("x-setup-token", "setup-secret-123")
      .set("Content-Type", "application/json")
      .send('{"browserUid":"browser-uid","passphrase":"super-secret-pass"')
      .expect(400);

    expect(response.header["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Invalid request body" });
    expect(response.text).not.toContain("super-secret-pass");
  });

  it("returns redacted JSON 500s for unexpected route errors", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, loadMinimalConfig().encryptionKey);
    const created = await service.createProfile("browser-uid", "passphrase");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = vi.spyOn(ProfileService.prototype, "getAddonCustomization").mockImplementation(() => {
      throw new Error("database disk image is malformed token=abcdefghijklmnopqrstuvwxyz123456");
    });
    const app = createApp(loadMinimalConfig(), db);

    const response = await request(app).get(`/u/${created.installUrlToken}/manifest.json`).expect(500);

    expect(response.header["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Internal server error" });
    const logged = errorSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("database disk image is malformed");
    expect(logged).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(logged).not.toContain(created.installUrlToken);
    failure.mockRestore();
    errorSpy.mockRestore();
  });

  it("separates admin restrictions from super admin dashboard access", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const config = {
      ...loadMinimalConfig(),
      adminBrowserUids: new Set(["admin-uid"]),
      superAdminBrowserUids: new Set(["super-admin-uid"]),
      maxFtpServersPerProfile: 2,
      proxyStreamsDisabled: true,
    };
    const app = createApp(config, db);

    const adminResponse = await request(app).get("/api/setup").query({ browserUid: "admin-uid" }).expect(200);
    expect(adminResponse.body).toEqual(
      expect.objectContaining({
        maxFtpServersPerProfile: 0,
        proxyStreamsDisabled: false,
        isAdmin: true,
        isSuperAdmin: false,
      }),
    );

    const superAdminResponse = await request(app).get("/api/setup").query({ browserUid: "super-admin-uid" }).expect(200);
    expect(superAdminResponse.body).toEqual(
      expect.objectContaining({
        maxFtpServersPerProfile: 2,
        proxyStreamsDisabled: true,
        isAdmin: false,
        isSuperAdmin: true,
      }),
    );
  });
});

function loadMinimalConfig(): AppConfig {
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
    profileRateLimitWindowMs: 600000,
    profileRateLimitMax: 30,
    tmdbApiKey: null,
  };
}
