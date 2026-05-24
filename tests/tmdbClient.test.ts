import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTmdbCatalogCache, tmdbCatalogEnrichment, tmdbCatalogMeta } from "../src/server/metadata/tmdbClient";

describe("tmdbCatalogMeta", () => {
  afterEach(() => {
    clearTmdbCatalogCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts TMDB requests after ten seconds", async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("Timed out", "AbortError"));
            });
          }),
      ),
    );

    const pending = tmdbCatalogMeta(
      { mediaKind: "movie", catalogKind: "movie", parsedTitle: "missing title", parsedYear: null, imdbId: null },
      "tmdb-key",
      "movie",
    );

    await vi.advanceTimersByTimeAsync(9999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeNull();
    expect(aborted).toBe(true);
  });

  it("retries movie searches with a roman numeral sequel title", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 36586,
              title: "Blade II",
              release_date: "2002-03-22",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt0187738" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogMeta(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle: "blade 2", parsedYear: 2002, imdbId: null },
        "tmdb-key",
        "movie",
      ),
    ).resolves.toMatchObject({
      id: "tt0187738",
      type: "movie",
      name: "Blade II",
      releaseInfo: "2002",
    });
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("query")).toBe("blade ii");
  });

  it("skips weak first movie search results and uses the exact title/year match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 999,
              title: "Waterworld: A Live Sea War Spectacular",
              release_date: "1999-01-01",
              genre_ids: [99],
            },
            {
              id: 9804,
              title: "Waterworld",
              release_date: "1995-07-28",
              genre_ids: [28, 12, 878],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt0114898" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogMeta(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle: "waterworld", parsedYear: 1995, imdbId: null },
        "tmdb-key",
        "movie",
      ),
    ).resolves.toMatchObject({
      id: "tt0114898",
      type: "movie",
      name: "Waterworld",
      releaseInfo: "1995",
      genres: ["Action", "Adventure", "Science Fiction"],
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain("/3/movie/9804/external_ids");
  });

  it("retries movie searches without trailing edition cut labels", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 9804,
              title: "Waterworld",
              release_date: "1995-07-28",
              genre_ids: [28, 12, 878],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt0114898" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogMeta(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle: "waterworld ulysses cut", parsedYear: 1995, imdbId: null },
        "tmdb-key",
        "movie",
      ),
    ).resolves.toMatchObject({
      id: "tt0114898",
      type: "movie",
      name: "Waterworld",
      releaseInfo: "1995",
    });
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("query")).toBe("waterworld");
  });

  it("retries year-constrained searches without the year", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 877,
              name: "Caprica",
              first_air_date: "2010-01-22",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt0799862" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogMeta(
        { mediaKind: "series", catalogKind: "series", parsedTitle: "caprica", parsedYear: 2009, imdbId: null },
        "tmdb-key",
        "series",
      ),
    ).resolves.toMatchObject({
      id: "tt0799862",
      type: "series",
      name: "Caprica",
      releaseInfo: "2010",
    });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("first_air_date_year")).toBe("2009");
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("first_air_date_year")).toBeNull();
  });

  it("falls back from unmatched series enrichment to movie search", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: 55931,
              title: "The Animatrix",
              release_date: "2003-06-03",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ imdb_id: "tt0328832" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogEnrichment(
        { mediaKind: "series", catalogKind: "series", parsedTitle: "animatrix", parsedYear: null, imdbId: null },
        "tmdb-key",
        "series",
      ),
    ).resolves.toEqual({
      status: "matched",
      meta: expect.objectContaining({
        id: "tt0328832",
        type: "movie",
        name: "The Animatrix",
        releaseInfo: "2003",
      }),
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/3/search/tv");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/3/search/movie");
  });
});
