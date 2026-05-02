import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
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

describe("MediaRepository", () => {
  it("upserts and queries episode rows", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);

    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Show.Name.S02E05.1080p.mkv",
      filename: "Show.Name.S02E05.1080p.mkv",
      normalizedFilename: "show name s02e05 1080p",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "show name",
      parsedYear: null,
      season: 2,
      episode: 5,
      imdbId: null,
      quality: "1080p",
      confidence: 95,
    });

    expect(repo.findEpisode(profileId, "show name", 2, 5)).toHaveLength(1);
  });

  it("updates an existing file row on upsert", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);

    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Show.Name.S02E05.mkv",
      filename: "Show.Name.S02E05.mkv",
      normalizedFilename: "show name s02e05",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "show name",
      parsedYear: null,
      season: 2,
      episode: 5,
      imdbId: null,
      quality: "720p",
      confidence: 80,
      sizeBytes: 1000,
      lastSeenAt: "2026-05-02T00:00:00.000Z",
    });

    repo.upsertParsedFile(profileId, {
      ftpPath: "/TV/Show.Name.S02E05.mkv",
      filename: "Show.Name.S02E05.mkv",
      normalizedFilename: "show name s02e05",
      extension: "mkv",
      mediaKind: "series",
      parsedTitle: "show name",
      parsedYear: null,
      season: 2,
      episode: 5,
      imdbId: null,
      quality: "1080p",
      confidence: 95,
      sizeBytes: 2000,
      lastSeenAt: "2026-05-02T01:00:00.000Z",
    });

    expect(repo.findEpisode(profileId, "show name", 2, 5)).toEqual([
      expect.objectContaining({ filename: "Show.Name.S02E05.mkv", quality: "1080p", sizeBytes: 2000 }),
    ]);
  });

  it("orders movie matches by confidence and size", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);

    for (const file of [
      { ftpPath: "/Movies/Show.Name.2020.small.mkv", confidence: 90, sizeBytes: 1000 },
      { ftpPath: "/Movies/Show.Name.2020.large.mkv", confidence: 90, sizeBytes: 2000 },
      { ftpPath: "/Movies/Show.Name.2020.low.mkv", confidence: 70, sizeBytes: 5000 },
    ]) {
      repo.upsertParsedFile(profileId, {
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: "show name 2020",
        extension: "mkv",
        mediaKind: "movie",
        parsedTitle: "show name",
        parsedYear: 2020,
        season: null,
        episode: null,
        imdbId: "tt1234567",
        quality: "1080p",
        confidence: file.confidence,
        sizeBytes: file.sizeBytes,
      });
    }

    expect(repo.findMovie(profileId, "tt1234567", "show name", 2020).map((match) => match.ftpPath)).toEqual([
      "/Movies/Show.Name.2020.large.mkv",
      "/Movies/Show.Name.2020.small.mkv",
      "/Movies/Show.Name.2020.low.mkv",
    ]);
  });

  it("deletes stale files under a root and treats slash root as the whole profile", () => {
    const db = new Database(":memory:");
    migrate(db);
    const profileId = createProfile(db);
    const repo = new MediaRepository(db);
    const oldSeen = "2026-05-02T00:00:00.000Z";
    const currentSeen = "2026-05-02T01:00:00.000Z";

    for (const file of [
      { ftpPath: "/TV/Stale.Show.S01E01.mkv", title: "stale show", lastSeenAt: oldSeen },
      { ftpPath: "/TV/Current.Show.S01E01.mkv", title: "current show", lastSeenAt: currentSeen },
      { ftpPath: "/Movies/Stale.Movie.2020.mkv", title: "stale movie", lastSeenAt: oldSeen },
    ]) {
      repo.upsertParsedFile(profileId, {
        ftpPath: file.ftpPath,
        filename: file.ftpPath.split("/").at(-1) ?? "",
        normalizedFilename: file.title,
        extension: "mkv",
        mediaKind: "series",
        parsedTitle: file.title,
        parsedYear: null,
        season: 1,
        episode: 1,
        imdbId: null,
        quality: null,
        confidence: 80,
        lastSeenAt: file.lastSeenAt,
      });
    }

    expect(repo.deleteStaleUnderRoot(profileId, "/TV", currentSeen)).toBe(1);
    expect(repo.findEpisode(profileId, "stale show", 1, 1)).toHaveLength(0);
    expect(repo.findEpisode(profileId, "current show", 1, 1)).toHaveLength(1);
    expect(repo.findEpisode(profileId, "stale movie", 1, 1)).toHaveLength(1);

    expect(repo.deleteStaleUnderRoot(profileId, "/", currentSeen)).toBe(1);
    expect(repo.findEpisode(profileId, "stale movie", 1, 1)).toHaveLength(0);
  });
});
