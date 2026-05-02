import { describe, expect, it, vi } from "vitest";
import { resolveStreams } from "../src/server/stremio/streamResolver";

describe("stream resolver", () => {
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
            quality: "1080p",
            sizeBytes: 2254857830,
          },
        ],
        findMovie: () => [],
      },
    });

    expect(streams[0]?.url).toBe("https://addon.example.test/proxy/token%20with%2Fslash/99");
  });

  it("returns no streams for malformed series IDs", async () => {
    const findEpisode = vi.fn(() => [
      {
        id: 99,
        filename: "Show.Name.S02E05.1080p.mkv",
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
});
