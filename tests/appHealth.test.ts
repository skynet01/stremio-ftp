import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";

describe("app health", () => {
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
});
