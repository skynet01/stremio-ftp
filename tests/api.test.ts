/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("web API setup token handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.history.pushState({}, "", "/");
  });

  it("moves setup tokens from the URL into session storage before sending headers", async () => {
    window.history.pushState({}, "", "/configure?setup=setup-secret-123");
    const fetchMock = vi.fn(async () => jsonResponse({ profileId: 1, recoveryUid: "browser-uid", manifestUrl: "m", stremioInstallUrl: "s" }));
    vi.stubGlobal("fetch", fetchMock);

    const { createProfile } = await import("../src/web/api");
    await createProfile({ browserUid: "browser-uid", passphrase: "passphrase" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "x-setup-token": "setup-secret-123",
        },
      }),
    );
    expect(window.location.href).toBe("http://localhost:3000/configure");
    expect(window.sessionStorage.getItem("stremio-ftp-setup-token")).toBe("setup-secret-123");
  });

  it("uses manually saved setup tokens without requiring query strings", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ profileId: 1, recoveryUid: "browser-uid", manifestUrl: "m", stremioInstallUrl: "s" }));
    vi.stubGlobal("fetch", fetchMock);

    const { createProfile, saveSetupToken, setupTokenAvailable } = await import("../src/web/api");
    expect(setupTokenAvailable()).toBe(false);
    saveSetupToken("setup-secret-123");
    expect(setupTokenAvailable()).toBe(true);
    await createProfile({ browserUid: "browser-uid", passphrase: "passphrase" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/profile",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "x-setup-token": "setup-secret-123",
        },
      }),
    );
    expect(window.location.search).toBe("");
  });
});

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
