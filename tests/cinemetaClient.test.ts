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
