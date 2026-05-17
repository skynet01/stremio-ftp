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

  it("posts admin profile requests with setup token auth", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ summary: {}, profiles: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { loadAdminProfiles, saveSetupToken } = await import("../src/web/api");
    saveSetupToken("setup-secret-123");
    await loadAdminProfiles({ browserUid: "admin-uid", passphrase: "passphrase" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/profiles",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-setup-token": "setup-secret-123",
        },
        body: JSON.stringify({ browserUid: "admin-uid", passphrase: "passphrase" }),
      }),
    );
  });

  it("posts admin manifest, rescan, delete, and admin toggle actions without leaking profile id into auth-only bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ profileId: 7, manifestUrl: "https://addon.example.test/u/token/manifest.json", stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json" }))
      .mockResolvedValueOnce(jsonResponse({ profileId: 7, scanStatus: { status: "queued" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ profileId: 7, adminEnabled: true, adminSource: "database" }));
    vi.stubGlobal("fetch", fetchMock);

    const { deleteAdminProfile, issueAdminManifestToken, rescanAdminProfile, saveSetupToken, setAdminProfileEnabled } = await import("../src/web/api");
    saveSetupToken("setup-secret-123");
    await issueAdminManifestToken({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7 });
    await rescanAdminProfile({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7 });
    await deleteAdminProfile({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7 });
    await setAdminProfileEnabled({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7, adminEnabled: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/profiles/7/manifest-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ browserUid: "admin-uid", passphrase: "passphrase" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/profiles/7/rescan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ browserUid: "admin-uid", passphrase: "passphrase" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/admin/profiles/7/delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ browserUid: "admin-uid", passphrase: "passphrase" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/admin/profiles/7/admin",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ browserUid: "admin-uid", passphrase: "passphrase", adminEnabled: true }),
      }),
    );
  });
});

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
