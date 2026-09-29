import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogMetaMatchesItem, catalogRecheckChoice, clearTmdbCatalogCache, tmdbCatalogEnrichment, tmdbCatalogMeta } from "../src/server/metadata/tmdbClient";

describe("tmdbCatalogMeta", () => {
  afterEach(() => {
    clearTmdbCatalogCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a stored 3D edition match with one year of drift, but rejects two", () => {
    const item = { mediaKind: "movie" as const, catalogKind: "movie" as const, parsedTitle: "north star 3d edition", parsedYear: 2000, imdbId: null };
    expect(catalogMetaMatchesItem(item, { id: "tt0000001", type: "movie", name: "North Star", releaseInfo: "2001" }, "movie")).toBe(true);
    expect(catalogMetaMatchesItem(item, { id: "tt0000002", type: "movie", name: "North Star", releaseInfo: "2002" }, "movie")).toBe(false);
  });

  it("searches without a year when a 3D release is one year off", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") return { ok: true, json: async () => ({
        results: url.searchParams.has("year") ? [] : [{ id: 1, title: "North Star", release_date: "2001-01-01" }],
      }) };
      if (url.pathname === "/3/movie/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0000001" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(tmdbCatalogEnrichment({ mediaKind: "movie", catalogKind: "movie", parsedTitle: "north star 3d edition", parsedYear: 2000, imdbId: null }, "tmdb-key")).resolves.toMatchObject({
      status: "matched", meta: { id: "tt0000001", releaseInfo: "2001" },
    });
    const searches = fetchMock.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname === "/3/search/movie");
    expect(searches.map((url) => [url.searchParams.get("query"), url.searchParams.get("year")])).toEqual([
      ["north star", "2000"],
      ["north star", null],
    ]);
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

  it("caches TMDB rate limits, server errors and timeouts only briefly", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ movie_results: [{ id: 603, title: "The Matrix", release_date: "1999-03-31" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const item = { mediaKind: "movie" as const, catalogKind: "movie" as const, parsedTitle: "tt0133093", parsedYear: null, imdbId: "tt0133093" };

    await expect(tmdbCatalogMeta(item, "tmdb-key", "movie")).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await expect(tmdbCatalogMeta(item, "tmdb-key", "movie")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await expect(tmdbCatalogMeta(item, "tmdb-key", "movie")).resolves.toMatchObject({ id: "tt0133093", name: "The Matrix" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps genuine not-found results for the normal cache lifetime", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const item = { mediaKind: "movie" as const, catalogKind: "movie" as const, parsedTitle: "missing title", parsedYear: null, imdbId: null };

    await expect(tmdbCatalogMeta(item, "tmdb-key", "movie")).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await expect(tmdbCatalogMeta(item, "tmdb-key", "movie")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await tmdbCatalogMeta(item, "tmdb-key", "movie");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the catalog metadata cache", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ movie_results: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const lookup = (index: number) =>
      tmdbCatalogMeta(
        { mediaKind: "movie", catalogKind: "movie", parsedTitle: "title", parsedYear: null, imdbId: `tt${1000000 + index}` },
        "tmdb-key",
        "movie",
      );

    for (let index = 0; index <= 1000; index += 1) await lookup(index);
    expect(fetchMock).toHaveBeenCalledTimes(1001);

    await lookup(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1001);
    await lookup(0);
    expect(fetchMock).toHaveBeenCalledTimes(1002);
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

  it.each([
    ["golden boy", 1995, "Golden Boy", "Golden Boy", 2022, "tt0159145", "tt2229167"],
    ["dragon ball", 1986, "Dragon Ball", "Dragon Ball Z", 1986, "tt0088509", "tt0121220"],
  ])("uses the folder year and exact TV title for %s", async (parsedTitle, year, correctTitle, decoyTitle, decoyYear, correctId, decoyId) => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/tv") {
        return { ok: true, json: async () => ({ results: url.searchParams.get("first_air_date_year") === String(year)
          ? [
              { id: 1, name: decoyTitle, first_air_date: `${decoyYear}-01-01` },
              { id: 2, name: correctTitle, first_air_date: `${year}-01-01` },
            ]
          : [{ id: 1, name: decoyTitle, first_air_date: `${decoyYear}-01-01` }] }) };
      }
      if (url.pathname === "/3/tv/1/external_ids") return { ok: true, json: async () => ({ imdb_id: decoyId }) };
      if (url.pathname === "/3/tv/2/external_ids") return { ok: true, json: async () => ({ imdb_id: correctId }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(tmdbCatalogEnrichment({ mediaKind: "series", catalogKind: "series", parsedTitle, parsedYear: null, alternateYear: year, imdbId: null }, "tmdb-key")).resolves.toMatchObject({
      status: "matched",
      meta: { id: correctId, name: correctTitle },
    });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("first_air_date_year")).toBe(String(year));
  });

  it("rejects Heavens Fall when searching for The Fall", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") return { ok: true, json: async () => ({ results: [{ id: 1, title: "Heavens Fall", release_date: "2006-01-01" }] }) };
      if (url.pathname === "/3/movie/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0425094" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(tmdbCatalogEnrichment({ mediaKind: "movie", catalogKind: "movie", parsedTitle: "the fall", parsedYear: 2006, imdbId: null }, "tmdb-key")).resolves.toEqual({ status: "unmatched" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain("/3/movie/1/external_ids");
  });

  it.each([
    ["the fall", 2006, [
      { id: 1, title: "The Fall", release_date: "2008-01-01" },
      { id: 2, title: "Heavens Fall", release_date: "2006-01-01" },
      { id: 3, title: "Fall to Grace", release_date: "2006-01-01" },
    ]],
    ["orbit", 2012, [
      { id: 4, title: "Orbit Rising", release_date: "2012-01-01" },
      { id: 5, title: "The Orbit of Mars", release_date: "2012-01-01" },
    ]],
  ])("rejects extra significant words when %s has no plausible exact title", async (parsedTitle, parsedYear, results) => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") return { ok: true, json: async () => ({ results }) };
      if (url.pathname.endsWith("/external_ids")) return { ok: true, json: async () => ({ imdb_id: "tt0000001" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(tmdbCatalogEnrichment({ mediaKind: "movie", catalogKind: "movie", parsedTitle, parsedYear, imdbId: null }, "tmdb-key")).resolves.toEqual({ status: "unmatched" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname).some((path) => path.endsWith("/external_ids"))).toBe(false);
  });

  it("uses a matching movie folder year when the filename has none", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") return { ok: true, json: async () => ({ results: [
        { id: 1, title: "Fall", release_date: "2022-01-01" },
        { id: 2, title: "The Fall", release_date: "2008-01-01" },
        { id: 3, title: "Fall to Grace", release_date: "2006-01-01" },
      ] }) };
      if (url.pathname.endsWith("/external_ids")) return { ok: true, json: async () => ({ imdb_id: "tt0000001" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const item = { mediaKind: "movie" as const, catalogKind: "movie" as const, parsedTitle: "fall", parsedYear: null, alternateYear: 2006, imdbId: null };
    await expect(tmdbCatalogEnrichment(item, "tmdb-key")).resolves.toEqual({ status: "unmatched" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("year")).toBe("2006");
    expect(catalogMetaMatchesItem(item, { id: "tt0460791", type: "movie", name: "The Fall", releaseInfo: "2006" }, "movie")).toBe(true);
    expect(catalogMetaMatchesItem(item, { id: "tt15325794", type: "movie", name: "Fall", releaseInfo: "2022" }, "movie")).toBe(false);
  });

  it("prefers an exact TV title and matching first-air year over a longer result", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/tv") return { ok: true, json: async () => ({ results: [
        { id: 1, name: "Northbound: Origins", first_air_date: "2004-01-01" },
        { id: 2, name: "Northbound", first_air_date: "2004-06-01" },
      ] }) };
      if (url.pathname === "/3/tv/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0000001" }) };
      if (url.pathname === "/3/tv/2/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0000002" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(tmdbCatalogEnrichment({ mediaKind: "series", catalogKind: "series", parsedTitle: "northbound", parsedYear: 2004, imdbId: null }, "tmdb-key")).resolves.toMatchObject({
      status: "matched", meta: { id: "tt0000002" },
    });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("first_air_date_year")).toBe("2004");
  });

  it("prefers an exact TV title even when its first-air date is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/tv") return { ok: true, json: async () => ({ results: [
        { id: 1, name: "Harbor Lights Z", first_air_date: "2004-01-01" },
        { id: 2, name: "Harbor Lights" },
      ] }) };
      if (url.pathname === "/3/tv/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0000001" }) };
      if (url.pathname === "/3/tv/2/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0000002" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    }));

    await expect(tmdbCatalogEnrichment({ mediaKind: "series", catalogKind: "series", parsedTitle: "harbor lights", parsedYear: 2004, imdbId: null }, "tmdb-key")).resolves.toMatchObject({
      status: "matched", meta: { id: "tt0000002" },
    });
  });

  it.each([
    ["the harbor", "Blue Harbor"],
    ["bright summer nights", "Summer Nights"],
  ])("rejects %s against a result with only partial significant-word coverage", async (parsedTitle, candidateTitle) => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") return { ok: true, json: async () => ({ results: [{ id: 1, title: candidateTitle, release_date: "2001-01-01" }] }) };
      if (url.pathname === "/3/movie/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0000001" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(tmdbCatalogEnrichment({ mediaKind: "movie", catalogKind: "movie", parsedTitle, parsedYear: 2001, imdbId: null }, "tmdb-key")).resolves.toEqual({ status: "unmatched" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain("/3/movie/1/external_ids");
  });

  it.each([
    ["harry potter and the sorcerers stone", 2001, "Harry Potter and the Philosopher's Stone", "movie"],
    ["borat", 2006, "Borat: Cultural Learnings of America for Make Benefit Glorious Nation of Kazakhstan", "movie"],
    ["the office us", 2005, "The Office", "series"],
  ] as const)("matches %s to the regional or subtitled TMDB title", async (parsedTitle, year, title, kind) => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/3/search/")) return { ok: true, json: async () => ({ results: [
        { id: 1, title, name: title, release_date: `${year}-01-01`, first_air_date: `${year}-01-01` },
      ] }) };
      if (url.pathname.endsWith("/external_ids")) return { ok: true, json: async () => ({ imdb_id: "tt0000001" }) };
      throw new Error(`Unexpected TMDB URL: ${url.pathname}`);
    }));

    await expect(tmdbCatalogEnrichment({ mediaKind: kind, catalogKind: kind, parsedTitle, parsedYear: year, imdbId: null }, "tmdb-key")).resolves.toMatchObject({
      status: "matched", meta: { id: "tt0000001", name: title },
    });
  });

  it("chooses between a stored match and a recheck result", () => {
    const item = { mediaKind: "series" as const, catalogKind: "series" as const, parsedTitle: "harbor lights", parsedYear: 2004, imdbId: null };
    const exact = { id: "tt0000002", type: "series" as const, name: "Harbor Lights", releaseInfo: "2004" };
    const longer = { id: "tt0000001", type: "series" as const, name: "Harbor Lights Origins", releaseInfo: "2004" };
    const unrelated = { id: "tt0000003", type: "series" as const, name: "Blue Harbor", releaseInfo: "2004" };

    expect(catalogRecheckChoice(item, longer, exact, "series")).toBe("fresh");
    expect(catalogRecheckChoice(item, exact, longer, "series")).toBe("existing");
    expect(catalogRecheckChoice(item, exact, null, "series")).toBe("existing");
    expect(catalogRecheckChoice(item, unrelated, null, "series")).toBe("none");
    expect(catalogRecheckChoice(item, unrelated, longer, "series")).toBe("fresh");
    expect(catalogRecheckChoice(item, null, null, "series")).toBe("none");
  });

  it("does not search movies for an unmatched series", async () => {
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
    ).resolves.toEqual({ status: "unmatched" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/3/search/tv");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("rejects an unrelated TV result without trying a movie", async () => {
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
    ).resolves.toEqual({ status: "unmatched" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain("/3/tv/123034/external_ids");
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain("/3/search/movie");
  });

  it("searches an editionless title before an alternate filename title, at most twice", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") {
        queries.push(url.searchParams.get("query") ?? "");
        return { ok: true, json: async () => ({ results: queries.length === 1 ? [] : [{ id: 1, title: "Novocaine", release_date: "2025-01-01" }] }) };
      }
      if (url.pathname === "/3/movie/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt29603959" }) };
      throw new Error(`Unexpected URL: ${url.pathname}`);
    }));
    await expect(tmdbCatalogEnrichment({ mediaKind: "movie", catalogKind: "movie", parsedTitle: "novacaine ultimate cut 3d", parsedYear: 2025, imdbId: null, alternateTitle: "novocaine", alternateYear: 2025 }, "tmdb-key")).resolves.toMatchObject({ status: "matched", meta: { id: "tt29603959" } });
    expect(queries).toEqual(["novacaine", "novocaine"]);
  });

  it("omits edition tags even when they occur before the end of the title", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/movie") {
        queries.push(url.searchParams.get("query") ?? "");
        return { ok: true, json: async () => ({ results: [{ id: 1, title: "The Matrix", release_date: "1999-01-01" }] }) };
      }
      if (url.pathname === "/3/movie/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt0133093" }) };
      throw new Error(`Unexpected URL: ${url.pathname}`);
    }));
    await expect(tmdbCatalogEnrichment({ mediaKind: "movie", catalogKind: "movie", parsedTitle: "matrix extended 3d edition", parsedYear: 1999, imdbId: null }, "tmdb-key")).resolves.toMatchObject({ status: "matched" });
    expect(queries).toEqual(["matrix"]);
  });

  it("matches number words to digits", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/3/search/tv") return { ok: true, json: async () => ({ results: [{ id: 1, name: "Twelve Monkeys", first_air_date: "2015-01-01" }] }) };
      if (url.pathname === "/3/tv/1/external_ids") return { ok: true, json: async () => ({ imdb_id: "tt3148266" }) };
      throw new Error(`Unexpected URL: ${url.pathname}`);
    }));
    await expect(tmdbCatalogEnrichment({ mediaKind: "series", catalogKind: "series", parsedTitle: "12 monkeys", parsedYear: 2015, imdbId: null }, "tmdb-key")).resolves.toMatchObject({ status: "matched", meta: { id: "tt3148266" } });
  });

  it("makes no more than two search requests for one item", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ results: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      tmdbCatalogEnrichment({ mediaKind: "movie", catalogKind: "movie", parsedTitle: "matrix 2 ultimate cut", parsedYear: 1999, imdbId: null }, "tmdb-key"),
    ).resolves.toEqual({ status: "unmatched" });
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname.startsWith("/3/search/")).length).toBeLessThanOrEqual(2);
  });
});
