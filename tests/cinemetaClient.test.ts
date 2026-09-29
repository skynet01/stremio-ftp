import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCinemetaCache, fetchCinemetaMeta } from "../src/server/metadata/cinemetaClient";

function cinemetaResponse(id: string, name = "Show Name") {
  return new Response(JSON.stringify({ meta: { id, name, releaseInfo: "2020" } }));
}

describe("fetchCinemetaMeta", () => {
  afterEach(() => {
    clearCinemetaCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns Cinemeta metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              meta: { id: "tt1234567", name: "Show Name", releaseInfo: "2020" },
            }),
          ),
      ),
    );
    await expect(fetchCinemetaMeta("series", "tt1234567")).resolves.toEqual({
      id: "tt1234567",
      name: "Show Name",
      releaseInfo: "2020",
    });
  });

  it("returns null for non-OK responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    await expect(fetchCinemetaMeta("series", "tt1234567")).resolves.toBeNull();
  });

  it("returns null for rejected fetches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("network failed"))));

    await expect(fetchCinemetaMeta("series", "tt1234567")).resolves.toBeNull();
  });

  it("does not fetch malformed imdb ids", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCinemetaMeta("series", "not-an-imdb-id")).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes an abort signal with the configured timeout", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ meta: { id: "tt1234567", name: "Movie" } })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchCinemetaMeta("movie", "tt1234567", 250);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://v3-cinemeta.strem.io/meta/movie/tt1234567.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null when the request times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
          }),
      ),
    );

    const pending = fetchCinemetaMeta("movie", "tt1234567", 10);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("returns null for malformed JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not-json")));

    await expect(fetchCinemetaMeta("series", "tt1234567")).resolves.toBeNull();
  });

  it("returns null when metadata is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}))));

    await expect(fetchCinemetaMeta("series", "tt1234567")).resolves.toBeNull();
  });

  it("returns null when metadata is missing a string name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ meta: { id: "tt1" } }))));

    await expect(fetchCinemetaMeta("series", "tt1")).resolves.toBeNull();
  });

  it("returns null when metadata name is not a string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ meta: { id: "tt1", name: 123 } }))),
    );

    await expect(fetchCinemetaMeta("series", "tt1")).resolves.toBeNull();
  });

  it("returns null when metadata releaseInfo is not a string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ meta: { id: "tt1", name: "Show Name", releaseInfo: 2020 } })),
      ),
    );

    await expect(fetchCinemetaMeta("series", "tt1")).resolves.toBeNull();
  });

  it("reuses cached metadata for repeated lookups of the same title", async () => {
    const fetchMock = vi.fn(async () => cinemetaResponse("tt1234567"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchCinemetaMeta("series", "tt1234567");
    await expect(fetchCinemetaMeta("series", "tt1234567")).resolves.toMatchObject({ name: "Show Name" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys cached metadata by type", async () => {
    const fetchMock = vi.fn(async () => cinemetaResponse("tt1234567"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchCinemetaMeta("series", "tt1234567");
    await fetchCinemetaMeta("movie", "tt1234567");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent lookups", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchCinemetaMeta("movie", "tt1234567");
    const second = fetchCinemetaMeta("movie", "tt1234567");
    resolveFetch(cinemetaResponse("tt1234567", "Movie"));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ name: "Movie" }),
      expect.objectContaining({ name: "Movie" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes successful lookups after a few hours", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => cinemetaResponse("tt1234567"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchCinemetaMeta("movie", "tt1234567");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await fetchCinemetaMeta("movie", "tt1234567");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await fetchCinemetaMeta("movie", "tt1234567");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches failed lookups only briefly", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(cinemetaResponse("tt1234567", "Movie"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCinemetaMeta("movie", "tt1234567")).resolves.toBeNull();
    await expect(fetchCinemetaMeta("movie", "tt1234567")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await expect(fetchCinemetaMeta("movie", "tt1234567")).resolves.toMatchObject({ name: "Movie" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the cache by evicting the least recently used title", async () => {
    const fetchMock = vi.fn(async (url: string) => cinemetaResponse(url.match(/tt\d+/)![0]));
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index <= 500; index += 1) {
      await fetchCinemetaMeta("movie", `tt${String(1000000 + index)}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(501);

    await fetchCinemetaMeta("movie", "tt1000500");
    expect(fetchMock).toHaveBeenCalledTimes(501);
    await fetchCinemetaMeta("movie", "tt1000000");
    expect(fetchMock).toHaveBeenCalledTimes(502);
  });
});
