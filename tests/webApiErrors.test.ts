/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadServers } from "../src/web/api";

describe("web API errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the HTTP status on JSON error responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Invalid passphrase" }), { status: 401 })));

    await expect(loadServers({ browserUid: "browser-uid", passphrase: "wrong" })).rejects.toMatchObject({
      message: "Invalid passphrase",
      status: 401,
    });
  });

  it("exposes the HTTP status on non-JSON error responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));

    await expect(loadServers({ browserUid: "browser-uid", passphrase: "passphrase" })).rejects.toMatchObject({
      message: "Request failed with 502",
      status: 502,
    });
  });
});
