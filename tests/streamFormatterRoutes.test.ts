import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import { MAX_STREAM_FORMATTER_TEMPLATE_LENGTH } from "../src/shared/streamFormatter";

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
    adminBrowserUids: new Set(),
    superAdminBrowserUids: new Set(),
    scanGlobalConcurrency: 1,
    scanQueueMax: 10,
    scanCooldownMs: 60000,
    scanMinRescanIntervalMinutes: 0,
    scanJobTimeoutMs: 1800000,
    scanSchedulerIntervalMs: 60000,
    scanProgressAverageItems: 2000,
    scanTransientRetryDelayMs: 300000,
  };
}

function customization(templates: { streamNameTemplate: string; streamDescriptionTemplate: string }) {
  return {
    addonName: "Archive 3D",
    addonLogoUrl: "",
    addonDescription: "Stream the archive from my FTP server.",
    catalogEnabled: false,
    catalogTmdbApiKey: "",
    catalogContentTypes: { movies: true, series: true, anime: false },
    libraryLayout: "auto",
    streamDeliveryMode: "proxy",
    ...templates,
  };
}

describe("stream formatter template limits on profile routes", () => {
  it("saves templates up to the length cap and rejects longer ones", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    const credentials = { browserUid: "browser-uid", passphrase: "passphrase" };
    const atCap = `{stream.filename}${"x".repeat(MAX_STREAM_FORMATTER_TEMPLATE_LENGTH - "{stream.filename}".length)}`;

    await request(app).post("/api/profile").set("x-setup-token", "setup-secret-123").send(credentials).expect(201);

    await request(app)
      .post("/api/profile/customization")
      .set("x-setup-token", "setup-secret-123")
      .send({ ...credentials, customization: customization({ streamNameTemplate: atCap, streamDescriptionTemplate: atCap }) })
      .expect(200);

    for (const field of ["streamNameTemplate", "streamDescriptionTemplate"] as const) {
      await request(app)
        .post("/api/profile/customization")
        .set("x-setup-token", "setup-secret-123")
        .send({
          ...credentials,
          customization: customization({ streamNameTemplate: atCap, streamDescriptionTemplate: atCap, [field]: `${atCap}x` }),
        })
        .expect(400);
    }

    const response = await request(app)
      .post("/api/profile/customization/load")
      .set("x-setup-token", "setup-secret-123")
      .send(credentials)
      .expect(200);

    expect(response.body.customization.streamNameTemplate).toBe(atCap);
    expect(response.body.customization.streamDescriptionTemplate).toBe(atCap);
  });
});
