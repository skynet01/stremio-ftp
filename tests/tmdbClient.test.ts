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

  it("treats rejected TMDB credentials as retryable instead of unmatched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ status_message: "Invalid API key" }) })),
    );

    await expect(
      tmdbCatalogEnrichment(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle: "the matrix", parsedYear: 1999, imdbId: null },
        "invalid-key",
        "movie",
      ),
    ).resolves.toEqual({ status: "retry", error: "TMDB request failed with 401" });
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

  it("rejects a sequel with the wrong year and retries with a word-number title", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") {
        const query = url.searchParams.get("query");
        if (query === "ring 2" || query === "ring ii") {
          return {
            ok: true,
            json: async () => ({ results: [{ id: 170, title: "Ring 2", release_date: "1999-01-23" }] }),
          };
        }
        if (query === "ring two") {
          return {
            ok: true,
            json: async () => ({ results: [{ id: 10320, title: "The Ring Two", release_date: "2005-03-17" }] }),
          };
        }
      }
      if (url.pathname === "/3/movie/10320/external_ids") {
        return { ok: true, json: async () => ({ imdb_id: "tt0377109" }) };
      }
      throw new Error(`Unexpected TMDB URL: ${url.pathname}?${url.searchParams}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogMeta(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle: "ring 2", parsedYear: 2005, imdbId: null },
        "tmdb-key",
        "movie",
      ),
    ).resolves.toMatchObject({
      id: "tt0377109",
      type: "movie",
      name: "The Ring Two",
      releaseInfo: "2005",
    });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain("/3/movie/170/external_ids");
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("query"))).toContain("ring two");
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

  it.each([
    ["brahmastra part one shiva", "Brahmāstra Part One: Shiva", 2022],
    ["furiosa a mad saga", "Furiosa: A Mad Max Saga", 2024],
    ["ice age 2", "Ice Age: The Meltdown", 2006],
    ["joker folie a deux", "Joker: Folie à Deux", 2024],
    ["jurassic park ii lost world", "The Lost World: Jurassic Park", 1997],
    ["mad 2 road warrior", "Mad Max 2", 1980],
    ["ready or not 2 here i come", "Ready or Not: Here I Come", 2026],
    ["to live and die in la", "To Live and Die in L.A.", 1985],
  ])("accepts a strong token relationship for %s", async (parsedTitle, resultTitle, year) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        if (url.pathname === "/3/search/movie") {
          return {
            ok: true,
            json: async () => ({ results: [{ id: 42, title: resultTitle, release_date: `${year}-01-01` }] }),
          };
        }
        if (url.pathname === "/3/movie/42/external_ids") {
          return { ok: true, json: async () => ({ imdb_id: "tt1234567" }) };
        }
        throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
      }),
    );

    await expect(
      tmdbCatalogEnrichment(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle, parsedYear: year, imdbId: null },
        "tmdb-key",
        "movie",
      ),
    ).resolves.toEqual({
      status: "matched",
      meta: expect.objectContaining({ id: "tt1234567", type: "movie", name: resultTitle }),
    });
  });

  it("does not treat a substring inside an unrelated title as a relationship", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") {
        return {
          ok: true,
          json: async () => ({ results: [{ id: 99, title: "The Italian Job", release_date: "2003-01-01" }] }),
        };
      }
      if (url.pathname === "/3/movie/99/external_ids") {
        return { ok: true, json: async () => ({ imdb_id: "tt0317740" }) };
      }
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogEnrichment(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle: "it", parsedYear: 2003, imdbId: null },
        "tmdb-key",
        "movie",
      ),
    ).resolves.toEqual({ status: "unmatched" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain("/3/movie/99/external_ids");
  });

  it("rejects an unrelated TV result before falling back to the matching movie", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/tv") {
        return {
          ok: true,
          json: async () => ({ results: [{ id: 123034, name: "The Keepers", first_air_date: "2021-01-01" }] }),
        };
      }
      if (url.pathname === "/3/tv/123034/external_ids") {
        return { ok: true, json: async () => ({ imdb_id: "tt14358016" }) };
      }
      if (url.pathname === "/3/search/movie") {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 120,
                title: "The Lord of the Rings: The Fellowship of the Ring",
                release_date: "2001-12-18",
              },
            ],
          }),
        };
      }
      if (url.pathname === "/3/movie/120/external_ids") {
        return { ok: true, json: async () => ({ imdb_id: "tt0120737" }) };
      }
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tmdbCatalogEnrichment(
        {
          mediaKind: "series",
          catalogKind: "anime",
          parsedTitle: "lord of rings fellowship of ring",
          parsedYear: null,
          imdbId: null,
        },
        "tmdb-key",
        "anime",
      ),
    ).resolves.toEqual({
      status: "matched",
      meta: expect.objectContaining({
        id: "tt0120737",
        type: "movie",
        name: "The Lord of the Rings: The Fellowship of the Ring",
        releaseInfo: "2001",
      }),
    });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain("/3/tv/123034/external_ids");
  });
});
