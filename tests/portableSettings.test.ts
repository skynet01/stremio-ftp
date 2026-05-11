import { describe, expect, it } from "vitest";
import {
  applyImportLimits,
  hasCompleteFtpCreds,
  parsePortableSettings,
  serializePortableSettings,
  type ExportContext,
} from "../src/web/portableSettings";

const idleScanStatus = {
  id: null,
  status: "idle" as const,
  trigger: null,
  progressPercent: 0,
  entriesSeen: 0,
  filesSeen: 0,
  directoriesSeen: 0,
  currentPath: null,
  estimatedSecondsRemaining: null,
  message: null,
  error: null,
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  mediaItems: 0,
  mediaItemsAdded: 0,
  scanMode: null,
};

const baseExportContext: ExportContext = {
  addonName: "Stremio FTP Addon",
  addonLogoUrl: "",
  addonDescription: "Stream movies and series episodes from your own FTP server.",
  catalogTmdbApiKey: "tmdb-key",
  streamNameTemplate: "FTP {stream.serverPrefix}{stream.quality}",
  streamDescriptionTemplate: "{stream.filename}",
  servers: [
    {
      id: 1,
      name: "Home FTP",
      host: "ftp.example.test",
      port: "21",
      username: "user",
      password: "secret",
      passwordConfigured: true,
      tlsMode: "explicit",
      allowInvalidCertificate: false,
      rootPaths: "/Movies\n/TV",
      catalogEnabled: true,
      catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
      libraryLayout: "auto",
      streamDeliveryMode: "proxy",
      indexStatus: { lastScanAt: null, mediaItems: 0 },
      scanStatus: idleScanStatus,
      scanSchedule: { intervalMinutes: 60, nextScheduledScanAt: null },
      connectionStatus: { lastTestedAt: null, ok: null },
      pendingScanAfter: null,
      message: "",
    },
  ],
};

describe("portableSettings", () => {
  it("serializes and parses a settings payload round-trip", () => {
    const payload = serializePortableSettings(baseExportContext, false);
    const reparsed = parsePortableSettings(JSON.parse(JSON.stringify(payload)));
    expect(reparsed.schemaVersion).toBe(1);
    expect(reparsed.customization?.addonName).toBe("Stremio FTP Addon");
    expect(reparsed.customization?.catalogTmdbApiKey).toBe("tmdb-key");
    expect(reparsed.servers?.length).toBe(1);
    const [server] = reparsed.servers!;
    expect(server.host).toBe("ftp.example.test");
    expect(server.username).toBe("user");
    expect(server.password).toBe("secret");
    expect(server.rootPaths).toEqual(["/Movies", "/TV"]);
    expect(server.streamDeliveryMode).toBe("proxy");
    expect(server.scanIntervalMinutes).toBe(60);
  });

  it("strips credentials when requested", () => {
    const payload = serializePortableSettings(baseExportContext, true);
    expect(payload.servers?.[0].username).toBeUndefined();
    expect(payload.servers?.[0].password).toBeUndefined();
    expect(payload.servers?.[0].host).toBe("ftp.example.test");
    expect(payload.servers?.[0].rootPaths).toEqual(["/Movies", "/TV"]);
  });

  it("rejects invalid schema versions", () => {
    expect(() => parsePortableSettings({ schemaVersion: 2 })).toThrow();
    expect(() => parsePortableSettings(null)).toThrow();
  });

  it("downgrades proxy to direct when proxy is disabled", () => {
    const parsed = parsePortableSettings(serializePortableSettings(baseExportContext, false));
    const summary = applyImportLimits(parsed, { maxFtpServersPerProfile: 0, proxyStreamsDisabled: true });
    expect(summary.proxyDowngradedCount).toBe(1);
    expect(summary.servers[0].streamDeliveryMode).toBe("direct");
  });

  it("drops trailing servers beyond the configured cap", () => {
    const many: ExportContext = {
      ...baseExportContext,
      servers: Array.from({ length: 5 }, (_, index) => ({
        ...baseExportContext.servers[0],
        id: index + 1,
        name: `Server ${index + 1}`,
      })),
    };
    const summary = applyImportLimits(
      parsePortableSettings(serializePortableSettings(many, false)),
      { maxFtpServersPerProfile: 2, proxyStreamsDisabled: false },
    );
    expect(summary.servers.length).toBe(2);
    expect(summary.droppedServerCount).toBe(3);
    expect(summary.servers.map((s) => s.name)).toEqual(["Server 1", "Server 2"]);
  });

  it("flags partial servers as missing credentials", () => {
    const stripped = serializePortableSettings(baseExportContext, true);
    const summary = applyImportLimits(parsePortableSettings(stripped), {
      maxFtpServersPerProfile: 0,
      proxyStreamsDisabled: false,
    });
    expect(hasCompleteFtpCreds(summary.servers[0])).toBe(false);
    expect(summary.servers[0].host).toBe("ftp.example.test");
  });
});
