import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";
import { resolveStreams } from "../src/server/stremio/streamResolver";

function movieRepositoryWithoutMetadata() {
  const db = new Database(":memory:");
  migrate(db);
  const profileId = Number(
    db
      .prepare("insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at) values ('uid-1', 'v', 'h-1', 'n', 'n')")
      .run().lastInsertRowid,
  );
  const serverId = Number(
    db
      .prepare(
        `insert into profile_ftp_servers (profile_id, name, catalog_enabled, catalog_content_movies, catalog_content_series,
          catalog_content_anime, catalog_sort, library_layout, stream_delivery_mode, created_at, updated_at)
        values (?, 'Server 1', 1, 1, 1, 0, 'alphabetical', 'auto', 'proxy', 'n', 'n')`,
      )
      .run(profileId).lastInsertRowid,
  );
  const repository = new MediaRepository(db);
  for (const file of [
    { filename: "The.Movie.2021.tt7654321.mkv", parsedTitle: "movie", imdbId: "tt7654321" },
    { filename: "Enriched.Movie.2021.mkv", parsedTitle: "enriched movie", imdbId: null },
    { filename: "2021.mkv", parsedTitle: "", imdbId: null },
    { filename: "Unrelated.2021.mkv", parsedTitle: "unrelated", imdbId: null },
  ]) {
    repository.upsertParsedFile(profileId, {
      ftpServerId: serverId,
      mediaKind: "movie",
      catalogKind: "movie",
      ftpPath: `/Movies/${file.filename}`,
      filename: file.filename,
      normalizedFilename: file.parsedTitle,
      extension: "mkv",
      parsedTitle: file.parsedTitle,
      parsedYear: 2021,
      season: null,
      episode: null,
      imdbId: file.imdbId,
      quality: "1080p",
      confidence: 80,
    });
  }
  const seenAt = "2026-05-04T00:00:00.000Z";
  repository.syncCatalogEnrichmentCandidates(profileId, serverId, repository.catalogEnrichmentCandidates(profileId, serverId, ["movie"]), seenAt);
  const enriched = repository.pendingCatalogEnrichment(profileId, serverId, seenAt, 10).find((item) => item.parsedTitle === "enriched movie")!;
  repository.saveCatalogEnrichmentMatch(enriched.id, { id: "tt7654321", type: "movie", name: "The Movie" }, seenAt);
  return { profileId, repository };
}

describe("stream resolver", () => {
  it.each([
    ["unavailable", null],
    ["missing a usable title", { name: "!!!", releaseInfo: "2021" }],
  ])("matches movies by IMDb id only when metadata is %s", async (_label, metadata) => {
    const { profileId, repository } = movieRepositoryWithoutMetadata();

    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId,
      type: "movie",
      id: "tt7654321",
      metadata,
      mediaRepository: repository,
    });

    expect(streams.map((stream) => stream.behaviorHints.filename).sort()).toEqual([
      "Enriched.Movie.2021.mkv",
      "The.Movie.2021.tt7654321.mkv",
    ]);
  });

  it("does not look up files without a usable title for series or malformed movie ids", async () => {
    const findEpisode = vi.fn(() => []);
    const findMovie = vi.fn(() => []);

    for (const request of [
      { type: "series" as const, id: "tt1234567:2:5", metadata: null },
      { type: "series" as const, id: "tt1234567:2:5", metadata: { name: "!!!" } },
      { type: "movie" as const, id: "not-imdb", metadata: null },
    ]) {
      await expect(
        resolveStreams({
          baseUrl: "https://addon.example.test",
          installToken: "token",
          profileId: 1,
          ...request,
          mediaRepository: { findEpisode, findMovie },
        }),
      ).resolves.toEqual([]);
    }

    expect(findEpisode).not.toHaveBeenCalled();
    expect(findMovie).not.toHaveBeenCalled();
  });

  it("resolves a series episode to a proxy stream", async () => {
    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 1,
      type: "series",
      id: "tt1234567:2:5",
      metadata: { name: "Show Name" },
      mediaRepository: {
        findEpisode: () => [
          {
            id: 99,
            filename: "Show.Name.S02E05.1080p.mkv",
            ftpPath: "/TV/Show.Name.S02E05.1080p.mkv",
            quality: "1080p",
            sizeBytes: 2254857830,
          },
        ],
        findMovie: () => [],
      },
    });

    expect(streams[0]).toMatchObject({
      name: "FTP 1080p",
      url: "https://addon.example.test/proxy/token/99",
      behaviorHints: {
        notWebReady: true,
        filename: "Show.Name.S02E05.1080p.mkv",
        videoSize: 2254857830,
      },
    });
  });

  it("formats stream name and description with custom templates", async () => {
    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 1,
      type: "movie",
      id: "tt0133093",
      metadata: { name: "The Matrix", releaseInfo: "1999" },
      addonName: "Archive 3D",
      streamNameTemplate: "{addon.name} | {stream.serverName} | {stream.quality}",
      streamDescriptionTemplate: "{stream.filename}{tools.newLine}{stream.size::bytes}{tools.newLine}{stream.deliveryMode::upper}",
      mediaRepository: {
        findEpisode: () => [],
        findMovie: () => [
          {
            id: 99,
            ftpServerId: 4,
            serverName: "Server 4",
            filename: "The.Matrix.1999.2160p.mkv",
            ftpPath: "/Movies/The.Matrix.1999.2160p.mkv",
            quality: "2160p",
            sizeBytes: 5368709120,
          },
        ],
      },
    });

    expect(streams[0]).toMatchObject({
      name: "Archive 3D | Server 4 | 2160p",
      description: "The.Matrix.1999.2160p.mkv\n5.0 GB\nPROXY",
      url: "https://addon.example.test/proxy/token/99",
    });
    expect(streams[0]).not.toHaveProperty("title");
  });

  it("exposes detected 3D type to custom stream templates", async () => {
    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 1,
      type: "movie",
      id: "tt0499549",
      metadata: { name: "Avatar", releaseInfo: "2009" },
      streamNameTemplate: "3D - {stream.3dtype} - {stream.quality}",
      streamDescriptionTemplate: "{stream.threeDType}",
      mediaRepository: {
        findEpisode: () => [],
        findMovie: () => [
          {
            id: 101,
            filename: "Avatar.2009.2160p.Full-SBS.mkv",
            ftpPath: "/Movies/Avatar.2009.2160p.Full-SBS.mkv",
            quality: "2160p",
            sizeBytes: null,
          },
        ],
      },
    });

    expect(streams[0]).toMatchObject({
      name: "3D - Full SBS - 2160p",
      description: "Full SBS",
    });
  });

  it("encodes proxy URL path segments and strips trailing slashes from base URL", async () => {
    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test/",
      installToken: "token with/slash",
      profileId: 1,
      type: "series",
      id: "tt1234567:2:5",
      metadata: { name: "Show Name" },
      mediaRepository: {
        findEpisode: () => [
          {
            id: 99,
            filename: "Show.Name.S02E05.1080p.mkv",
            ftpPath: "/TV/Show.Name.S02E05.1080p.mkv",
            quality: "1080p",
            sizeBytes: 2254857830,
          },
        ],
        findMovie: () => [],
      },
    });

    expect(streams[0]?.url).toBe("https://addon.example.test/proxy/token%20with%2Fslash/99");
  });

  it("uses shared proxy URLs for shared index matches", async () => {
    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 1,
      type: "movie",
      id: "tt7654321",
      metadata: { name: "The Movie!", releaseInfo: "2021" },
      mediaRepository: {
        findEpisode: () => [],
        findMovie: () => [
          {
            id: 77,
            source: "shared",
            ftpServerId: 12,
            sharedIndexGroupId: 3,
            serverName: "Shared",
            filename: "The.Movie.2021.mkv",
            ftpPath: "/Movies/The.Movie.2021.mkv",
            quality: "1080p",
            sizeBytes: null,
          },
        ],
      },
    });

    expect(streams[0]?.url).toBe("https://addon.example.test/proxy/token/shared/12/77");
  });


  it("returns no streams for malformed series IDs", async () => {
    const findEpisode = vi.fn(() => [
      {
        id: 99,
        filename: "Show.Name.S02E05.1080p.mkv",
        ftpPath: "/TV/Show.Name.S02E05.1080p.mkv",
        quality: "1080p",
        sizeBytes: 2254857830,
      },
    ]);

    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 1,
      type: "series",
      id: "tt1234567",
      metadata: { name: "Show Name" },
      mediaRepository: {
        findEpisode,
        findMovie: () => [],
      },
    });

    expect(streams).toEqual([]);
    expect(findEpisode).not.toHaveBeenCalled();
  });

  it.each(["tt123:2:5:extra", "tt123::5", "tt123:0:5", "tt123:2:0", "tt123:2.5:5"])(
    "returns no streams for invalid series ID %s",
    async (id) => {
      const findEpisode = vi.fn(() => [
        {
          id: 99,
          filename: "Show.Name.S02E05.1080p.mkv",
          ftpPath: "/TV/Show.Name.S02E05.1080p.mkv",
          quality: "1080p",
          sizeBytes: 2254857830,
        },
      ]);

      const streams = await resolveStreams({
        baseUrl: "https://addon.example.test",
        installToken: "token",
        profileId: 1,
        type: "series",
        id,
        metadata: { name: "Show Name" },
        mediaRepository: {
          findEpisode,
          findMovie: () => [],
        },
      });

      expect(streams).toEqual([]);
      expect(findEpisode).not.toHaveBeenCalled();
    },
  );

  it("resolves movies with normalized title and release year", async () => {
    const findMovie = vi.fn(() => [
      {
        id: 7,
        filename: "The.Movie.2021.2160p.mkv",
        ftpPath: "/Movies/The.Movie.2021.2160p.mkv",
        quality: "2160p",
        sizeBytes: null,
      },
    ]);

    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 3,
      type: "movie",
      id: "tt7654321",
      metadata: { name: "The Movie!", releaseInfo: "2021-05-01" },
      mediaRepository: {
        findEpisode: () => [],
        findMovie,
      },
    });

    expect(findMovie).toHaveBeenCalledWith(3, "tt7654321", "movie", 2021);
    expect(streams[0]?.url).toBe("https://addon.example.test/proxy/token/7");
  });

  it("can return direct FTP URLs instead of proxy streams", async () => {
    const streams = await resolveStreams({
      baseUrl: "https://addon.example.test",
      installToken: "token",
      profileId: 1,
      type: "movie",
      id: "tt7654321",
      metadata: { name: "The Movie!", releaseInfo: "2021" },
      streamDeliveryMode: "direct",
      ftpConfig: {
        host: "ftp.example.test",
        port: 2121,
        username: "user name",
        password: "p@ss/word",
        tlsMode: "none",
        allowInvalidCertificate: false,
        roots: ["/Movies"],
      },
      mediaRepository: {
        findEpisode: () => [],
        findMovie: () => [
          {
            id: 7,
            filename: "The.Movie.2021.2160p.mkv",
            ftpPath: "/Movies/The Movie 2021.mkv",
            quality: "2160p",
            sizeBytes: null,
          },
        ],
      },
    });

    expect(streams[0]).toMatchObject({
      name: "FTP 2160p",
      url: "ftp://user%20name:p%40ss%2Fword@ftp.example.test:2121/Movies/The%20Movie%202021.mkv",
      behaviorHints: {
        notWebReady: true,
        filename: "The.Movie.2021.2160p.mkv",
      },
    });
  });
});
