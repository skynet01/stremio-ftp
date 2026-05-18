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

  it("posts admin manifest, rescan, delete, admin toggle, and bulk actions without leaking profile ids into auth-only bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ profileId: 7, manifestUrl: "https://addon.example.test/u/token/manifest.json", stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json" }))
      .mockResolvedValueOnce(jsonResponse({ profileId: 7, scanStatus: { status: "queued" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ profileId: 7, adminEnabled: true, adminSource: "database" }))
      .mockResolvedValueOnce(jsonResponse({ action: "convert_to_proxy", profileIds: [7, 8], converted: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    const { bulkAdminProfiles, deleteAdminProfile, issueAdminManifestToken, rescanAdminProfile, saveSetupToken, setAdminProfileEnabled } = await import("../src/web/api");
    saveSetupToken("setup-secret-123");
    await issueAdminManifestToken({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7 });
    await rescanAdminProfile({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7 });
    await deleteAdminProfile({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7 });
    await setAdminProfileEnabled({ browserUid: "admin-uid", passphrase: "passphrase", profileId: 7, adminEnabled: true });
    await bulkAdminProfiles({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [7, 8], action: "convert_to_proxy" });

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
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/admin/profiles/bulk",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ browserUid: "admin-uid", passphrase: "passphrase", profileIds: [7, 8], action: "convert_to_proxy" }),
      }),
    );
  });

  it("posts shared index admin actions with auth bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ groups: [] }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 }, sharedIndexKey: "key" }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 } }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 }, scanSchedule: { intervalMinutes: 360, nextScheduledScanAt: "2026-05-18T13:00:00.000Z" } }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 }, sharedIndexKey: "rotated" }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 } }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 } }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 } }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 }, scanStatus: { status: "queued" } }))
      .mockResolvedValueOnce(jsonResponse({ group: { id: 3 }, scanStatus: { status: "cancelled" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const {
      cancelAdminSharedIndexScan,
      createAdminSharedIndexGroup,
      deleteAdminSharedIndexGroup,
      linkAdminSharedIndexServer,
      loadAdminSharedIndexGroups,
      rescanAdminSharedIndexGroup,
      rotateAdminSharedIndexKey,
      saveSetupToken,
      scheduleAdminSharedIndexGroup,
      setAdminSharedIndexMaster,
      unlinkAdminSharedIndexServer,
      updateAdminSharedIndexGroup,
    } = await import("../src/web/api");
    saveSetupToken("setup-secret-123");
    const auth = { browserUid: "admin-uid", passphrase: "passphrase" };

    await loadAdminSharedIndexGroups(auth);
    await createAdminSharedIndexGroup({ ...auth, profileId: 7, serverId: 9, name: "Sputnik", keyHint: "sputnik" });
    await updateAdminSharedIndexGroup({ ...auth, groupId: 3, name: "Sputnik 2", autoLinkImports: false });
    await scheduleAdminSharedIndexGroup({ ...auth, groupId: 3, intervalMinutes: 360 });
    await rotateAdminSharedIndexKey({ ...auth, groupId: 3 });
    await linkAdminSharedIndexServer({ ...auth, groupId: 3, profileId: 7, serverId: 9 });
    await unlinkAdminSharedIndexServer({ ...auth, groupId: 3, profileId: 7, serverId: 9 });
    await setAdminSharedIndexMaster({ ...auth, groupId: 3, profileId: 7, serverId: 9 });
    await rescanAdminSharedIndexGroup({ ...auth, groupId: 3 });
    await cancelAdminSharedIndexScan({ ...auth, groupId: 3 });
    await deleteAdminSharedIndexGroup({ ...auth, groupId: 3 });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/admin/shared-index-groups", expect.objectContaining({ method: "POST", body: JSON.stringify(auth) }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/shared-index-groups/create",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ...auth, profileId: 7, serverId: 9, name: "Sputnik", keyHint: "sputnik" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/admin/shared-index-groups/3/update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...auth, name: "Sputnik 2", keyHint: undefined, enabled: undefined, autoLinkImports: false }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/admin/shared-index-groups/3/schedule",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ...auth, intervalMinutes: 360 }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/admin/shared-index-groups/3/rotate-key", expect.objectContaining({ method: "POST", body: JSON.stringify(auth) }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/admin/shared-index-groups/3/link-server",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ...auth, profileId: 7, serverId: 9 }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      "/api/admin/shared-index-groups/3/unlink-server",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ...auth, profileId: 7, serverId: 9 }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      8,
      "/api/admin/shared-index-groups/3/master",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ...auth, profileId: 7, serverId: 9 }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(9, "/api/admin/shared-index-groups/3/rescan", expect.objectContaining({ method: "POST", body: JSON.stringify(auth) }));
    expect(fetchMock).toHaveBeenNthCalledWith(10, "/api/admin/shared-index-groups/3/cancel-scan", expect.objectContaining({ method: "POST", body: JSON.stringify(auth) }));
    expect(fetchMock).toHaveBeenNthCalledWith(11, "/api/admin/shared-index-groups/3/delete", expect.objectContaining({ method: "POST", body: JSON.stringify(auth) }));
  });
});

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
