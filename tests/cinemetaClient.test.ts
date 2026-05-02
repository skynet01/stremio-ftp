import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCinemetaMeta } from "../src/server/metadata/cinemetaClient";

describe("fetchCinemetaMeta", () => {
  afterEach(() => {
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
});
