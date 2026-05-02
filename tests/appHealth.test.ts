import Database from "better-sqlite3";
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
      port: 7000,
      logLevel: "error",
      crawlerConcurrency: 2,
      ftpTimeoutMs: 15000,
      indexRefreshIntervalMs: 21600000,
      maxOnDemandSearchMs: 4500,
      negativeCacheTtlMs: 300000,
      proxyIdleTimeoutMs: 30000,
    };
    const response = await request(createApp(config, db)).get("/health").expect(200);
    expect(response.body).toEqual({ ok: true, service: "stremio-ftp", baseUrl: "https://addon.example.test" });
  });
});
