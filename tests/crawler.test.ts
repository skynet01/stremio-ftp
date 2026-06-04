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

function createSharedIndexGroup(db: Database.Database, profileId: number) {
  db.prepare("insert into profile_ftp_servers (profile_id, name, created_at, updated_at) values (?, 'Server 1', 'n', 'n')").run(profileId);
  const server = db.prepare("select id from profile_ftp_servers where profile_id = ?").get(profileId) as { id: number };
  return Number(
    db
      .prepare(
        `
        insert into shared_index_groups (
          key_hint, name, shared_index_key_hash, host, port, tls_mode, allow_invalid_certificate,
          root_paths_json, library_layout, catalog_content_json, enabled, auto_link_imports,
          master_profile_ftp_server_id, created_at, updated_at
        ) values ('shared', 'Shared', 'hash', 'x', 21, 'none', 0, '["/"]', 'auto', '{}', 1, 1, ?, 'n', 'n')
      `,
      )
      .run(server.id).lastInsertRowid,
  );
}

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
      openReadStream: async () => {
        throw new Error("not used");
      },
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

  it("can index media into a shared group target", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const sharedIndexGroupId = createSharedIndexGroup(db, profileId);
    const repo = new MediaRepository(db);
    const factory: FtpClientFactory = async () => ({
      list: async () => [{ name: "Shared.Movie.2020.mkv", path: "/Shared.Movie.2020.mkv", type: "file", size: 1000 }],
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    });

    const result = await crawlProfileRoot({
      profileId,
      sharedIndexGroupId,
      rootPath: "/",
      ftpConfig,
      factory,
      repo,
    });

    expect(result.filesSeen).toBe(1);
    expect(repo.countForSharedIndexGroup(sharedIndexGroupId)).toBe(1);
    expect(repo.countForProfile(profileId)).toBe(0);
  });


  it("does not let an unchanged shared configured root snapshot hide changed child directories", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const sharedIndexGroupId = createSharedIndexGroup(db, profileId);
    const repo = new MediaRepository(db);
    const listings = new Map<string, number>();
    const factory: FtpClientFactory = async () => ({
      list: async (path) => {
        listings.set(path, (listings.get(path) ?? 0) + 1);
        if (path === "/") {
          return [{ name: "Movies", path: "/Movies", type: "directory", modifiedAt: "2026-05-01T00:00:00.000Z" }];
        }
        if (path === "/Movies") {
          const listCount = listings.get(path) ?? 0;
          return listCount === 1
            ? [{ name: "The.Matrix.1999.mkv", path: "/Movies/The.Matrix.1999.mkv", type: "file", size: 1000 }]
            : [{ name: "Avatar.2009.mkv", path: "/Movies/Avatar.2009.mkv", type: "file", size: 1000 }];
        }
        throw new Error(`unexpected list ${path}`);
      },
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    });

    await crawlProfileRoot({ profileId, sharedIndexGroupId, rootPath: "/", ftpConfig, factory, repo });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await crawlProfileRoot({ profileId, sharedIndexGroupId, rootPath: "/", ftpConfig, factory, repo });

    expect(listings.get("/")).toBe(2);
    expect(listings.get("/Movies")).toBe(2);
    expect(repo.countForSharedIndexGroup(sharedIndexGroupId)).toBe(1);
    const rows = db
      .prepare("select parsed_title, parsed_year from shared_media_files where shared_index_group_id = ? order by parsed_title")
      .all(sharedIndexGroupId) as Array<{ parsed_title: string; parsed_year: number }>;
    expect(rows).toEqual([{ parsed_title: "avatar", parsed_year: 2009 }]);
  });


  it("does not let an unchanged configured root snapshot hide changed child directories", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const listings = new Map<string, number>();
    const factory: FtpClientFactory = async () => ({
      list: async (path) => {
        listings.set(path, (listings.get(path) ?? 0) + 1);
        if (path === "/") {
          return [{ name: "Movies", path: "/Movies", type: "directory", modifiedAt: "2026-05-01T00:00:00.000Z" }];
        }
        if (path === "/Movies") {
          const listCount = listings.get(path) ?? 0;
          return listCount === 1
            ? [{ name: "The.Matrix.1999.mkv", path: "/Movies/The.Matrix.1999.mkv", type: "file", size: 1000 }]
            : [{ name: "Avatar.2009.mkv", path: "/Movies/Avatar.2009.mkv", type: "file", size: 1000 }];
        }
        throw new Error(`unexpected list ${path}`);
      },
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    });

    await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo });

    expect(listings.get("/")).toBe(2);
    expect(listings.get("/Movies")).toBe(2);
    expect(repo.findMovie(profileId, "tt0000000", "matrix", 1999)).toHaveLength(0);
    expect(repo.findMovie(profileId, "tt0000000", "avatar", 2009)).toHaveLength(1);
    const snapshot = db.prepare("select fingerprint from scan_directory_snapshots where profile_id = ? and dir_path = '/' order by id desc limit 1").get(profileId) as {
      fingerprint: string;
    };
    expect(snapshot.fingerprint).not.toMatch(/^parser-\d{4}/);
  });

  it("still skips unchanged nested directory subtrees using saved scan snapshots", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const listings = new Map<string, number>();
    const factory: FtpClientFactory = async () => ({
      list: async (path) => {
        listings.set(path, (listings.get(path) ?? 0) + 1);
        if (path === "/") {
          return [{ name: "Movies", path: "/Movies", type: "directory", modifiedAt: "2026-05-01T00:00:00.000Z" }];
        }
        if (path === "/Movies") {
          return [{ name: "Collection", path: "/Movies/Collection", type: "directory", modifiedAt: "2026-05-02T00:00:00.000Z" }];
        }
        if (path === "/Movies/Collection") {
          return [{ name: "The.Matrix.1999.mkv", path: "/Movies/Collection/The.Matrix.1999.mkv", type: "file", size: 1000 }];
        }
        throw new Error(`unexpected list ${path}`);
      },
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    });

    await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo });
    await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo });

    expect(listings.get("/")).toBe(2);
    expect(listings.get("/Movies")).toBe(2);
    expect(listings.get("/Movies/Collection")).toBe(1);
    expect(repo.findMovie(profileId, "tt0000000", "matrix", 1999)).toHaveLength(1);
  });

  it("accepts legacy parser-versioned snapshots and rewrites them as stable directory fingerprints", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const listings = new Map<string, number>();
    repo.upsertParsedFile(profileId, {
      ftpPath: "/Movies/The.Matrix.1999.mkv",
      filename: "The.Matrix.1999.mkv",
      normalizedFilename: "the matrix 1999",
      extension: "mkv",
      mediaKind: "movie",
      catalogKind: "movie",
      parsedTitle: "matrix",
      parsedYear: 1999,
      season: null,
      episode: null,
      imdbId: "tt0000000",
      quality: null,
      confidence: 100,
      sizeBytes: 1000,
      modifiedAt: null,
      lastSeenAt: "2026-05-01T00:00:00.000Z",
    });
    repo.saveDirectorySnapshot(profileId, {
      ftpServerId: null,
      dirPath: "/Movies",
      entryCount: 1,
      fingerprint: "parser-2026-05-04-3\nfile\tThe.Matrix.1999.mkv\t/Movies/The.Matrix.1999.mkv\t1000\t",
      modifiedAt: "2026-05-01T00:00:00.000Z",
      lastSeenAt: "2026-05-01T00:00:00.000Z",
    });
    const factory: FtpClientFactory = async () => ({
      list: async (path) => {
        listings.set(path, (listings.get(path) ?? 0) + 1);
        if (path === "/") {
          return [{ name: "Movies", path: "/Movies", type: "directory", modifiedAt: "2026-05-01T00:00:00.000Z" }];
        }
        if (path === "/Movies") {
          return [{ name: "The.Matrix.1999.mkv", path: "/Movies/The.Matrix.1999.mkv", type: "file", size: 1000 }];
        }
        throw new Error(`unexpected list ${path}`);
      },
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    });

    const result = await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo });

    expect(result.filesSeen).toBe(1);
    expect(listings.get("/")).toBe(1);
    expect(listings.get("/Movies")).toBe(1);
    const snapshot = db.prepare("select fingerprint from scan_directory_snapshots where profile_id = ? and dir_path = '/Movies' order by id desc limit 1").get(profileId) as {
      fingerprint: string;
    };
    expect(snapshot.fingerprint).toBe("file\tThe.Matrix.1999.mkv\t/Movies/The.Matrix.1999.mkv\t1000\t");
  });

  it("skips invalid zero-numbered episodes without failing the crawl", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const factory: FtpClientFactory = async () => ({
      list: async () => [
        { name: "Show.Name.S01E00.1080p.mkv", path: "/TV/Show.Name.S01E00.1080p.mkv", type: "file", size: 1000 },
        { name: "Show.Name.S01E01.1080p.mkv", path: "/TV/Show.Name.S01E01.1080p.mkv", type: "file", size: 1000 },
      ],
      openReadStream: async () => {
        throw new Error("not used");
      },
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
    expect(repo.findEpisode(profileId, "show name", 1, 1)).toHaveLength(1);
  });

  it("reports crawl progress while walking directories and files", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const progress: Array<{ entriesSeen: number; filesSeen: number; directoriesSeen: number; currentPath: string }> = [];
    const factory: FtpClientFactory = async () => ({
      list: async (path) =>
        path === "/"
          ? [
              { name: "Movies", path: "/Movies", type: "directory" },
              { name: "The.Matrix.1999.mkv", path: "/The.Matrix.1999.mkv", type: "file", size: 1000 },
            ]
          : [{ name: "Avatar.2009.mkv", path: "/Movies/Avatar.2009.mkv", type: "file", size: 2000 }],
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    });

    const result = await crawlProfileRoot({
      profileId,
      rootPath: "/",
      ftpConfig,
      factory,
      repo,
      onProgress: (nextProgress) => progress.push(nextProgress),
    });

    expect(result.filesSeen).toBe(2);
    expect(progress.at(0)).toMatchObject({ entriesSeen: 0, filesSeen: 0, directoriesSeen: 1, currentPath: "/" });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entriesSeen: 2, filesSeen: 1, directoriesSeen: 2, currentPath: "/Movies/Avatar.2009.mkv" }),
        expect.objectContaining({ entriesSeen: 3, filesSeen: 2, directoriesSeen: 2, currentPath: "/The.Matrix.1999.mkv" }),
      ]),
    );
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
      openReadStream: async () => {
        throw new Error("not used");
      },
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
      openReadStream: async () => {
        throw new Error("not used");
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
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => {
        closed = true;
      },
    });

    await expect(crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo })).rejects.toThrow("list failed");
    expect(closed).toBe(true);
  });

  it("retries transient directory list failures before failing the crawl", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    let rootListCalls = 0;
    const factory: FtpClientFactory = async () => ({
      list: async (path) => {
        if (path !== "/") throw new Error(`unexpected path ${path}`);
        rootListCalls += 1;
        if (rootListCalls === 1) throw new Error("Server sent FIN packet unexpectedly, closing connection.");
        return [{ name: "Movie.2020.mkv", path: "/Movie.2020.mkv", type: "file", size: 1000 }];
      },
      openReadStream: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    });

    const result = await crawlProfileRoot({ profileId, rootPath: "/", ftpConfig, factory, repo });

    expect(rootListCalls).toBe(2);
    expect(result.filesSeen).toBe(1);
    expect(repo.findMovie(profileId, "", "movie", 2020)).toHaveLength(1);
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
      openReadStream: async () => {
        throw new Error("not used");
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
