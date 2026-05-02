import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { crawlProfileRoot } from "../src/server/ftp/crawler";
import type { FtpClientFactory } from "../src/server/ftp/ftpTypes";
import { MediaRepository } from "../src/server/media/mediaRepository";

function createProfile(db: Database.Database) {
  return Number(
    db
      .prepare(
        "insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at) values ('uid', 'v', 'h', 'n', 'n')",
      )
      .run().lastInsertRowid,
  );
}

const ftpConfig = {
  host: "x",
  port: 21,
  username: "u",
  password: "p",
  tlsMode: "none" as const,
  allowInvalidCertificate: false,
  roots: ["/"],
};

describe("crawler", () => {
  it("walks directories and indexes media files", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const factory: FtpClientFactory = async () => ({
      list: async (path) =>
        path === "/"
          ? [{ name: "TV", path: "/TV", type: "directory" }]
          : [{ name: "Show.Name.S02E05.1080p.mkv", path: "/TV/Show.Name.S02E05.1080p.mkv", type: "file", size: 1000 }],
      close: async () => undefined,
    });

    const result = await crawlProfileRoot({
      profileId,
      rootPath: "/",
      ftpConfig,
      factory,
      repo,
    });

    expect(result.filesSeen).toBe(1);
    expect(repo.findEpisode(profileId, "show name", 2, 5)).toHaveLength(1);
  });

  it("prunes stale files under the crawled root after a successful crawl", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Stale.Show.S01E01.mkv",
      filename: "Stale.Show.S01E01.mkv",
      normalizedFilename: "stale show s01e01",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "stale show",
      parsedYear: null,
      season: 1,
      episode: 1,
      imdbId: null,
      quality: null,
      confidence: 90,
      lastSeenAt: "2000-01-01T00:00:00.000Z",
    });
    repo.upsertParsedFile(profileId, {
      ftpPath: "/Movies/Other.Movie.2020.mkv",
      filename: "Other.Movie.2020.mkv",
      normalizedFilename: "other movie 2020",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "other movie",
      parsedYear: null,
      season: 1,
      episode: 1,
      imdbId: null,
      quality: null,
      confidence: 90,
      lastSeenAt: "2000-01-01T00:00:00.000Z",
    });
    const factory: FtpClientFactory = async () => ({
      list: async () => [
        { name: "Current.Show.S01E01.mkv", path: "/TV/Current.Show.S01E01.mkv", type: "file", size: 1000 },
      ],
      close: async () => undefined,
    });

    await crawlProfileRoot({ profileId, rootPath: "/TV", ftpConfig, factory, repo });

    expect(repo.findEpisode(profileId, "stale show", 1, 1)).toHaveLength(0);
    expect(repo.findEpisode(profileId, "current show", 1, 1)).toHaveLength(1);
    expect(repo.findEpisode(profileId, "other movie", 1, 1)).toHaveLength(1);
  });

  it("skips dot entries and previously visited directories", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const listedPaths: string[] = [];
    const factory: FtpClientFactory = async () => ({
      list: async (path) => {
        listedPaths.push(path);
        if (path === "/") {
          return [
            { name: ".", path: "/.", type: "directory" },
            { name: "..", path: "/..", type: "directory" },
            { name: "TV", path: "/TV", type: "directory" },
            { name: "TV-again", path: "/TV/", type: "directory" },
          ];
        }
        if (path === "/TV") {
          return [{ name: "TV-cycle", path: "/TV", type: "directory" }];
        }
        throw new Error(`unexpected path ${path}`);
      },
      close: async () => undefined,
    });

    const result = await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo });

    expect(result.filesSeen).toBe(0);
    expect(listedPaths).toEqual(["/", "/TV"]);
  });

  it("closes the FTP client when traversal fails", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    let closed = false;
    const factory: FtpClientFactory = async () => ({
      list: async () => {
        throw new Error("list failed");
      },
      close: async () => {
        closed = true;
      },
    });

    await expect(crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo })).rejects.toThrow("list failed");
    expect(closed).toBe(true);
  });

  it("throws a clear error when maximum crawl depth is exceeded", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    let closed = false;
    const factory: FtpClientFactory = async () => ({
      list: async (path) => {
        const next = path === "/" ? "/d1" : `${path}/d`;
        return [{ name: "d", path: next, type: "directory" }];
      },
      close: async () => {
        closed = true;
      },
    });

    await expect(crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo })).rejects.toThrow(
      "Maximum FTP crawl depth exceeded",
    );
    expect(closed).toBe(true);
  });
});
