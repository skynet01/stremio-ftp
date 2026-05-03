import Database from "better-sqlite3";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";
import type { FtpClientFactory } from "../src/server/ftp/ftpTypes";
import { MediaRepository } from "../src/server/media/mediaRepository";
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
  maxOnDemandSearchMs: 4500,
  profileRateLimitWindowMs: 60000,
  profileRateLimitMax: 30,
  scanGlobalConcurrency: 1,
  scanQueueMax: 10,
  scanCooldownMs: 60000,
  scanJobTimeoutMs: 1800000,
  scanSchedulerIntervalMs: 60000,
  scanProgressAverageItems: 4,
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

async function waitForEstimatedStatus(queue: ScanQueue, profileId: number) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const current = queue.getProfileScanStatus(profileId);
    if (current.status === "running" && current.estimatedSecondsRemaining !== null) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for scan estimate");
}

describe("ScanQueue", () => {
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
    expect(listCalls).toBe(1);
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
