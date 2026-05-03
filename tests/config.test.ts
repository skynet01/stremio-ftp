import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

describe("loadConfig", () => {
  it("normalizes required and optional environment values", () => {
    const config = loadConfig({
      BASE_URL: "https://example.test/",
      CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      SETUP_TOKEN: "setup-secret-123",
      TMDB_API_KEY: "tmdb-key",
      PORT: "8123",
      LOG_LEVEL: "debug",
      CONFIG_DIR: "/tmp/stremio-ftp-test",
    });

    expect(config.baseUrl).toBe("https://example.test");
    expect(config.port).toBe(8123);
    expect(config.logLevel).toBe("debug");
    expect(config.sqlitePath).toBe("/tmp/stremio-ftp-test/stremio-ftp.sqlite");
    expect(config.maxOnDemandSearchMs).toBe(4500);
    expect(config.scanGlobalConcurrency).toBe(2);
    expect(config.scanQueueMax).toBe(50);
    expect(config.scanCooldownMs).toBe(900000);
    expect(config.scanJobTimeoutMs).toBe(1800000);
    expect(config.scanSchedulerIntervalMs).toBe(60000);
    expect(config.scanProgressAverageItems).toBe(2000);
    expect(config.setupToken).toBe("setup-secret-123");
    expect(config.allowPublicProfileApi).toBe(false);
    expect(config.tmdbApiKey).toBe("tmdb-key");
  });

  it("loads scan queue environment values", () => {
    const config = loadConfig({
      BASE_URL: "https://example.test",
      CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      SETUP_TOKEN: "setup-secret-123",
      SCAN_GLOBAL_CONCURRENCY: "3",
      SCAN_QUEUE_MAX: "75",
      SCAN_COOLDOWN_MS: "120000",
      SCAN_JOB_TIMEOUT_MS: "900000",
      SCAN_SCHEDULER_INTERVAL_MS: "30000",
      SCAN_PROGRESS_AVERAGE_ITEMS: "5000",
    });

    expect(config.scanGlobalConcurrency).toBe(3);
    expect(config.scanQueueMax).toBe(75);
    expect(config.scanCooldownMs).toBe(120000);
    expect(config.scanJobTimeoutMs).toBe(900000);
    expect(config.scanSchedulerIntervalMs).toBe(30000);
    expect(config.scanProgressAverageItems).toBe(5000);
  });

  it("rejects an omitted setup token unless public profile APIs are explicitly enabled", () => {
    expect(() =>
      loadConfig({
        BASE_URL: "https://example.test",
        CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow("SETUP_TOKEN is required unless ALLOW_PUBLIC_PROFILE_API=true");
  });

  it("allows setup token to be omitted with explicit public profile API opt-in", () => {
    const config = loadConfig({
      BASE_URL: "https://example.test",
      CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      ALLOW_PUBLIC_PROFILE_API: "true",
    });

    expect(config.setupToken).toBeNull();
    expect(config.allowPublicProfileApi).toBe(true);
  });

  it("rejects invalid public profile API opt-in values", () => {
    expect(() =>
      loadConfig({
        BASE_URL: "https://example.test",
        CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        ALLOW_PUBLIC_PROFILE_API: "yes",
      }),
    ).toThrow("ALLOW_PUBLIC_PROFILE_API must be true or false");
  });

  it("rejects missing required values", () => {
    expect(() => loadConfig({})).toThrow("BASE_URL is required");
  });

  it("rejects fractional numeric values", () => {
    expect(() =>
      loadConfig({
        BASE_URL: "https://example.test",
        CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        SETUP_TOKEN: "setup-secret-123",
        CRAWLER_CONCURRENCY: "1.5",
      }),
    ).toThrow("CRAWLER_CONCURRENCY must be a positive integer");
  });

  it("rejects out-of-range ports", () => {
    expect(() =>
      loadConfig({
        BASE_URL: "https://example.test",
        CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        SETUP_TOKEN: "setup-secret-123",
        PORT: "65536",
      }),
    ).toThrow("PORT must be an integer from 1 to 65535");
  });

  it("rejects non-plain integer port syntax", () => {
    for (const port of ["1e3", "1.0", "0x10"]) {
      expect(() =>
        loadConfig({
          BASE_URL: "https://example.test",
          CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
          SETUP_TOKEN: "setup-secret-123",
          PORT: port,
        }),
      ).toThrow("PORT must be a positive integer");
    }
  });

  it("lists valid log levels when rejecting invalid LOG_LEVEL", () => {
    expect(() =>
      loadConfig({
        BASE_URL: "https://example.test",
        CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        SETUP_TOKEN: "setup-secret-123",
        LOG_LEVEL: "verbose",
      }),
    ).toThrow("LOG_LEVEL must be one of: debug, info, warn, error");
  });
});
