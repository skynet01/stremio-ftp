import Database from "better-sqlite3";
import { Readable } from "node:stream";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import type { FtpClientFactory } from "../src/server/ftp/ftpTypes";
import { MediaRepository } from "../src/server/media/mediaRepository";
import { clearTmdbCatalogCache } from "../src/server/metadata/tmdbClient";
import { ProfileService } from "../src/server/profiles/profileService";
import { ScanQueue } from "../src/server/scanner/scanQueue";

const baseConfig: AppConfig = {
  baseUrl: "https://addon.example.test",
  configDir: "/tmp",
  sqlitePath: ":memory:",
  encryptionKey: "0123456789abcdef0123456789abcdef",
  setupToken: null,
  allowPublicProfileApi: true,
  tmdbApiKey: null,
  port: 7000,
  logLevel: "error",
  crawlerConcurrency: 2,
  ftpTimeoutMs: 15000,
  ftpMaxConnections: 4,
  maxOnDemandSearchMs: 4500,
  profileRateLimitWindowMs: 60000,
  profileRateLimitMax: 30,
  scanGlobalConcurrency: 1,
  scanQueueMax: 10,
  scanCooldownMs: 60000,
  scanMinRescanIntervalMinutes: 0,
  scanJobTimeoutMs: 1800000,
  scanSchedulerIntervalMs: 60000,
  scanProgressAverageItems: 4,
  scanTransientRetryDelayMs: 60000,
};

function createHarness(factory: FtpClientFactory, config: AppConfig = baseConfig) {
  const db = new Database(":memory:");
  migrate(db);
  const profileService = new ProfileService(db, config.encryptionKey);
  const mediaRepository = new MediaRepository(db);
  const queue = new ScanQueue(config, profileService, mediaRepository, factory);
  return { db, profileService, mediaRepository, queue };
}

async function createProfileWithFtp(profileService: ProfileService) {
  const created = await profileService.createProfile(`browser-${Math.random()}`, "passphrase");
  profileService.saveFtpConfig(created.profileId, {
    host: "ftp.example.test",
    port: 21,
    username: "user",
    password: "secret",
    tlsMode: "none",
    allowInvalidCertificate: false,
    roots: ["/"],
  });
  return created.profileId;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitForStatus(queue: ScanQueue, profileId: number, status: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const current = queue.getProfileScanStatus(profileId);
    if (current.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

async function waitForNextStatus(queue: ScanQueue, profileId: number, previousId: number | null, status: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const current = queue.getProfileScanStatus(profileId);
    if (current.id !== previousId && current.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for next ${status}`);
}

async function waitForEstimatedStatus(queue: ScanQueue, profileId: number) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const current = queue.getProfileScanStatus(profileId);
    if (current.status === "running" && current.estimatedSecondsRemaining !== null) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scan estimate");
}

async function waitForProgressPath(queue: ScanQueue, profileId: number, currentPath: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const current = queue.getProfileScanStatus(profileId);
    if (current.status === "running" && current.currentPath === currentPath) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for scan progress at ${currentPath}`);
}

async function waitForMessage(queue: ScanQueue, profileId: number, messageText: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const current = queue.getProfileScanStatus(profileId);
    if (current.status === "running" && current.message?.includes(messageText)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for scan message containing ${messageText}`);
}

describe("ScanQueue", () => {
  afterEach(() => {
    clearTmdbCatalogCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("locks duplicate scans for the same profile while a scan is running", async () => {
    let listCalls = 0;
    const releaseList = deferred<Array<{ name: string; path: string; type: "file"; size: number }>>();
    const { profileService, queue } = createHarness(async () => ({
      list: async () => {
        listCalls += 1;
        return releaseList.promise;
      },
      openReadStream: async () => Readable.from("not used"),
      close: async () => undefined,
    }));
    const profileId = await createProfileWithFtp(profileService);

    const first = queue.enqueueProfileScan(profileId, "manual");
    await waitForStatus(queue, profileId, "running");
    const duplicate = queue.enqueueProfileScan(profileId, "manual");

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.status).toBe("running");
    expect(listCalls).toBe(1);

    releaseList.resolve([{ name: "Movie.2020.mkv", path: "/Movie.2020.mkv", type: "file", size: 1000 }]);
    const finished = await waitForStatus(queue, profileId, "succeeded");
    expect(finished.filesSeen).toBe(1);
  });

  it("cancels a running profile scan and closes the FTP client", async () => {
    let closeCalls = 0;
    const closeStarted = deferred<void>();
    const { profileService, queue } = createHarness(async () => ({
      list: async () => {
        await closeStarted.promise;
        throw new Error("FTP list aborted");
      },
      openReadStream: async () => Readable.from("not used"),
      close: async () => {
        closeCalls += 1;
        closeStarted.resolve();
      },
    }));
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");
    await waitForStatus(queue, profileId, "running");
    const halting = queue.cancelProfileScan(profileId);

    expect(halting.status).toBe("running");
    expect(halting.message).toBe("Halting scan.");
    const cancelled = await waitForStatus(queue, profileId, "cancelled");
    expect(cancelled.message).toBe("Scan halted.");
    expect(closeCalls).toBeGreaterThan(0);
  });

  it("applies manual scan cooldown after a successful scan", async () => {
    let listCalls = 0;
    const { profileService, queue } = createHarness(async () => ({
      list: async () => {
        listCalls += 1;
        return [{ name: "Movie.2020.mkv", path: "/Movie.2020.mkv", type: "file", size: 1000 }];
      },
      openReadStream: async () => Readable.from("not used"),
      close: async () => undefined,
    }));
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");
    await waitForStatus(queue, profileId, "succeeded");
    const cooldown = queue.enqueueProfileScan(profileId, "manual");

    expect(cooldown.status).toBe("skipped");
    expect(cooldown.message).toContain("cooldown");
    expect(cooldown.message).toMatch(/Try again in \d+m\./);
    expect(listCalls).toBe(1);
  });

  it("uses incremental snapshots for repeated manual scans", async () => {
    const listings = new Map<string, number>();
    const { profileService, queue } = createHarness(
      async () => ({
        list: async (path) => {
          listings.set(path, (listings.get(path) ?? 0) + 1);
          if (path === "/") return [{ name: "Movies", path: "/Movies", type: "directory", modifiedAt: "2026-05-01T00:00:00.000Z" }];
          if (path === "/Movies") return [{ name: "Movie.2020.mkv", path: "/Movies/Movie.2020.mkv", type: "file", size: 1000 }];
          return [];
        },
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
      { ...baseConfig, scanCooldownMs: 0 },
    );
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");
    await waitForStatus(queue, profileId, "succeeded");
    queue.enqueueProfileScan(profileId, "manual");
    await waitForStatus(queue, profileId, "succeeded");

    expect(listings.get("/")).toBe(2);
    expect(listings.get("/Movies")).toBe(1);
  });

  it("force manual scans clear snapshots and bypass cooldown", async () => {
    const listings = new Map<string, number>();
    const { profileService, queue } = createHarness(async () => ({
      list: async (path) => {
        listings.set(path, (listings.get(path) ?? 0) + 1);
        if (path === "/") return [{ name: "Movies", path: "/Movies", type: "directory", modifiedAt: "2026-05-01T00:00:00.000Z" }];
        if (path === "/Movies") return [{ name: "Movie.2020.mkv", path: "/Movies/Movie.2020.mkv", type: "file", size: 1000 }];
        return [];
      },
      openReadStream: async () => Readable.from("not used"),
      close: async () => undefined,
    }));
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");
    await waitForStatus(queue, profileId, "succeeded");
    const forced = queue.enqueueProfileScan(profileId, "manual", profileService.defaultFtpServerId(profileId), { force: true });
    await waitForStatus(queue, profileId, "succeeded");

    expect(["queued", "running"]).toContain(forced.status);
    expect(listings.get("/")).toBe(2);
    expect(listings.get("/Movies")).toBe(2);
  });

  it("schedules a delayed retry for transient FTP disconnects", async () => {
    const { profileService, queue } = createHarness(async () => ({
      list: async () => {
        throw new Error("Server sent FIN packet unexpectedly, closing connection.");
      },
      openReadStream: async () => Readable.from("not used"),
      close: async () => undefined,
    }));
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");
    const failed = await waitForStatus(queue, profileId, "failed");
    const server = profileService.getFtpServer(profileId, profileService.defaultFtpServerId(profileId));

    expect(failed.message).toBe("Scan failed: Server sent FIN packet unexpectedly, closing connection. Requeued to rescan in 1m.");
    expect(server.pendingScanAfter).toEqual(expect.any(String));
  });

  it("uses the previous successful scan size as the repeated scan progress baseline", async () => {
    const releaseNestedList = deferred<Array<{ name: string; path: string; type: "file"; size: number }>>();
    const { db, profileService, queue } = createHarness(
      async () => ({
        list: async (path) => {
          if (path === "/") return [{ name: "Movies", path: "/Movies", type: "directory" }];
          return releaseNestedList.promise;
        },
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
      { ...baseConfig, scanProgressAverageItems: 1000 },
    );
    const profileId = await createProfileWithFtp(profileService);
    const ftpServerId = profileService.defaultFtpServerId(profileId);
    db.prepare(
      `
      insert into scan_jobs (
        profile_id, ftp_server_id, status, trigger, progress_percent,
        entries_seen, files_seen, directories_seen, queued_at, started_at, finished_at
      )
      values (?, ?, 'succeeded', 'manual', 100, 2, 2, 2, ?, ?, ?)
    `,
    ).run(profileId, ftpServerId, "2026-05-04T00:00:00.000Z", "2026-05-04T00:00:00.000Z", "2026-05-04T00:01:00.000Z");

    queue.enqueueProfileScan(profileId, "manual");

    try {
      const running = await waitForProgressPath(queue, profileId, "/Movies");
      expect(running.progressPercent).toBeGreaterThanOrEqual(70);
      expect(running.estimatedSecondsRemaining).not.toBe(0);
    } finally {
      releaseNestedList.resolve([{ name: "Avatar.2009.mkv", path: "/Movies/Avatar.2009.mkv", type: "file", size: 2000 }]);
      await waitForStatus(queue, profileId, "succeeded").catch(() => undefined);
    }
  });

  it("persists scan progress and media count", async () => {
    const { profileService, queue } = createHarness(async () => ({
      list: async (path) =>
        path === "/"
          ? [
              { name: "Movies", path: "/Movies", type: "directory" },
              { name: "Matrix.1999.mkv", path: "/Matrix.1999.mkv", type: "file", size: 1000 },
            ]
          : [{ name: "Avatar.2009.mkv", path: "/Movies/Avatar.2009.mkv", type: "file", size: 2000 }],
      openReadStream: async () => Readable.from("not used"),
      close: async () => undefined,
    }));
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");
    const finished = await waitForStatus(queue, profileId, "succeeded");

    expect(finished.progressPercent).toBe(100);
    expect(finished.filesSeen).toBe(2);
    expect(finished.mediaItems).toBe(2);
    expect(finished.finishedAt).toEqual(expect.any(String));
    expect(profileService.getIndexStatus(profileId).mediaItems).toBe(2);
  });

  it("persists TMDB enrichment during scan and serves catalogs without live TMDB calls", async () => {
    const releaseTmdb = deferred<void>();
    const { db, profileService, queue } = createHarness(
      async () => ({
        list: async (path) =>
          path === "/"
            ? [{ name: "Movies", path: "/Movies", type: "directory" }]
            : [
                { name: "The.Matrix.1999.mkv", path: "/Movies/The.Matrix.1999.mkv", type: "file", size: 1024 * 1024 },
                { name: "Home.Video.2024.mp4", path: "/Movies/Home Videos/Home.Video.2024.mp4", type: "file", size: 512 * 1024 },
              ],
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
      { ...baseConfig, tmdbApiKey: "tmdb-key", scanCooldownMs: 0 },
    );
    const created = await profileService.createProfile(`browser-${Math.random()}`, "passphrase");
    const profileId = created.profileId;
    profileService.saveFtpConfig(profileId, {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/"],
    });
    profileService.saveAddonCustomization(profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive.",
      catalogEnabled: true,
    });

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("query=matrix")) {
        await releaseTmdb.promise;
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 603,
                title: "The Matrix",
                overview: "A hacker discovers reality.",
                poster_path: "/matrix.jpg",
                backdrop_path: "/matrix-bg.jpg",
                release_date: "1999-03-31",
              },
            ],
          }),
        };
      }
      if (url.includes("/3/movie/603/external_ids")) {
        return { ok: true, json: async () => ({ imdb_id: "tt0133093" }) };
      }
      return { ok: true, json: async () => ({ results: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    queue.enqueueProfileScan(profileId, "manual");
    const enriching = await waitForMessage(queue, profileId, "Enriching TMDB metadata");
    expect(enriching.progressPercent).toBeGreaterThanOrEqual(95);
    releaseTmdb.resolve();
    const finished = await waitForStatus(queue, profileId, "succeeded");

    expect(finished.message).toContain("Enriched 1 title");
    expect(finished.message).toContain("1 unresolved");
    fetchMock.mockClear();

    const app = createApp({ ...baseConfig, tmdbApiKey: "tmdb-key" }, db);
    const movieCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);
    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(movieCatalog.body.metas).toEqual([
      {
        id: "tt0133093",
        type: "movie",
        name: "The Matrix",
        poster: "https://image.tmdb.org/t/p/w500/matrix.jpg",
        background: "https://image.tmdb.org/t/p/w500/matrix-bg.jpg",
        description: "A hacker discovers reality.",
        releaseInfo: "1999",
      },
    ]);
    expect(otherCatalog.body.metas).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^ftp-folder:\d+$/),
        type: "movie",
        name: "Home Videos",
        poster: "https://addon.example.test/assets/default-folder-poster.png",
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps transient TMDB enrichment failures resumable on a later scan", async () => {
    const { db, profileService, queue } = createHarness(
      async () => ({
        list: async () => [{ name: "The.Matrix.1999.mkv", path: "/The.Matrix.1999.mkv", type: "file", size: 1024 * 1024 }],
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
      { ...baseConfig, tmdbApiKey: "tmdb-key", scanCooldownMs: 0 },
    );
    const created = await profileService.createProfile(`browser-${Math.random()}`, "passphrase");
    const profileId = created.profileId;
    profileService.saveFtpConfig(profileId, {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/"],
    });
    profileService.saveAddonCustomization(profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive.",
      catalogEnabled: true,
    });

    let searchAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/search/movie")) {
        searchAttempts += 1;
        if (searchAttempts === 1) return { ok: false, status: 429, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [{ id: 603, title: "The Matrix", poster_path: null, backdrop_path: null, release_date: "1999-03-31" }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ imdb_id: "tt0133093" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    queue.enqueueProfileScan(profileId, "manual");
    const paused = await waitForStatus(queue, profileId, "succeeded");
    const server = profileService.getFtpServer(profileId, profileService.defaultFtpServerId(profileId));

    expect(paused.message).toContain("queued for retry");
    expect(server.pendingScanAfter).toEqual(expect.any(String));
    db.prepare("update catalog_enrichment set next_attempt_at = ? where profile_id = ?").run("2026-05-04T00:00:00.000Z", profileId);

    queue.enqueueDueScheduledScans(new Date(Date.now() + 6 * 60 * 1000).toISOString());
    const resumed = await waitForNextStatus(queue, profileId, paused.id, "succeeded");
    expect(resumed.message).toContain("Enriched 1 title");

    fetchMock.mockClear();
    const app = createApp({ ...baseConfig, tmdbApiKey: "tmdb-key" }, db);
    const movieCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-movies.json`).expect(200);

    expect(movieCatalog.body.metas).toEqual([
      expect.objectContaining({
        id: "tt0133093",
        type: "movie",
        name: "The Matrix",
        releaseInfo: "1999",
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps catalog-only servers with no typed catalogs visible in Other", async () => {
    const { db, profileService, queue } = createHarness(
      async () => ({
        list: async (path) =>
          path === "/"
            ? [{ name: "Clips", path: "/Clips", type: "directory" }]
            : [
                { name: "Family.Video.2024.mp4", path: "/Clips/Family.Video.2024.mp4", type: "file", size: 512 * 1024 },
                { name: "Trip.Video.2025.mp4", path: "/Clips/Trip.Video.2025.mp4", type: "file", size: 768 * 1024 },
              ],
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
      { ...baseConfig, tmdbApiKey: "tmdb-key", scanCooldownMs: 0 },
    );
    const created = await profileService.createProfile(`browser-${Math.random()}`, "passphrase");
    const profileId = created.profileId;
    profileService.saveFtpConfig(profileId, {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/"],
    });
    profileService.saveAddonCustomization(profileId, {
      addonName: "Archive 3D",
      addonLogoUrl: "",
      addonDescription: "Stream the archive.",
      catalogEnabled: true,
      catalogContentTypes: { movies: false, series: false, anime: false },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    queue.enqueueProfileScan(profileId, "manual");
    const finished = await waitForStatus(queue, profileId, "succeeded");
    const app = createApp({ ...baseConfig, tmdbApiKey: "tmdb-key" }, db);
    const otherCatalog = await request(app).get(`/u/${created.installUrlToken}/catalog/movie/ftp-other.json`).expect(200);

    expect(finished.message).toBe("Indexed 2 media files.");
    expect(otherCatalog.body.metas).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^ftp-folder:\d+$/),
        name: "Clips",
        description: "2 files across 1 server",
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps scan progress ETA at one day", async () => {
    const releaseList = deferred<Array<{ name: string; path: string; type: "file"; size: number }>>();
    const { profileService, queue } = createHarness(
      async () => ({
        list: async () => releaseList.promise,
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
      { ...baseConfig, scanProgressAverageItems: 1_000_000 },
    );
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");

    try {
      const running = await waitForEstimatedStatus(queue, profileId);
      expect(running.estimatedSecondsRemaining).toBe(86_400);
    } finally {
      releaseList.resolve([]);
      await waitForStatus(queue, profileId, "succeeded").catch(() => undefined);
    }
  });

  it("keeps ETA indeterminate instead of reporting zero seconds while traversal is still running", async () => {
    const releaseNestedList = deferred<Array<{ name: string; path: string; type: "file"; size: number }>>();
    const { profileService, queue } = createHarness(
      async () => ({
        list: async (path) =>
          path === "/" ? [{ name: "More", path: "/More", type: "directory" }] : releaseNestedList.promise,
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      }),
      { ...baseConfig, scanProgressAverageItems: 1 },
    );
    const profileId = await createProfileWithFtp(profileService);

    queue.enqueueProfileScan(profileId, "manual");

    try {
      const running = await waitForProgressPath(queue, profileId, "/More");
      expect(running.entriesSeen).toBe(1);
      expect(running.estimatedSecondsRemaining).toBeNull();
    } finally {
      releaseNestedList.resolve([]);
      await waitForStatus(queue, profileId, "succeeded").catch(() => undefined);
    }
  });

  it("enqueues due scheduled scans and advances the next scheduled time", async () => {
    const { profileService, queue } = createHarness(async () => ({
      list: async () => [{ name: "Movie.2020.mkv", path: "/Movie.2020.mkv", type: "file", size: 1000 }],
      openReadStream: async () => Readable.from("not used"),
      close: async () => undefined,
    }));
    const profileId = await createProfileWithFtp(profileService);
    profileService.saveScanSchedule(profileId, {
      intervalMinutes: 360,
      nextScheduledScanAt: "2026-05-03T06:00:00.000Z",
    });

    queue.enqueueDueScheduledScans("2026-05-03T06:00:01.000Z");
    const finished = await waitForStatus(queue, profileId, "succeeded");

    expect(finished.trigger).toBe("scheduled");
    expect(profileService.getScanSchedule(profileId).nextScheduledScanAt).toBe("2026-05-03T12:00:01.000Z");
  });
});
