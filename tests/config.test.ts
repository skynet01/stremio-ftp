import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

describe("loadConfig", () => {
  it("normalizes required and optional environment values", () => {
    const config = loadConfig({
      BASE_URL: "https://example.test/",
      CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      SETUP_TOKEN: "setup-secret-123",
      PORT: "8123",
      LOG_LEVEL: "debug",
      CONFIG_DIR: "/tmp/stremio-ftp-test",
    });

    expect(config.baseUrl).toBe("https://example.test");
    expect(config.port).toBe(8123);
    expect(config.logLevel).toBe("debug");
    expect(config.sqlitePath).toBe("/tmp/stremio-ftp-test/stremio-ftp.sqlite");
    expect(config.maxOnDemandSearchMs).toBe(4500);
    expect(config.setupToken).toBe("setup-secret-123");
  });

  it("rejects missing required values", () => {
    expect(() => loadConfig({})).toThrow("BASE_URL is required");
    expect(() =>
      loadConfig({
        BASE_URL: "https://example.test",
        CONFIG_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow("SETUP_TOKEN is required");
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
});
