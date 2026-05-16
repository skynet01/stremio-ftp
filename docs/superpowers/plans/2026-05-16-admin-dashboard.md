# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-only dashboard that lets admin profiles inspect account/index status, issue debug manifest URLs, and delete profiles.

**Architecture:** Add a focused `src/server/admin/adminRoutes.ts` router guarded by setup token and admin profile passphrase. Add read-only profile summary support to `ProfileService`, then surface it through `src/web/api.ts` and a new `AdminDashboard` React component rendered only for unlocked admin profiles.

**Tech Stack:** Express, better-sqlite3, zod, React, Testing Library, Vitest.

---

## File Structure

- Create `src/server/admin/adminRoutes.ts`: admin auth schema, admin authorization helper, profile list, manifest-token, and delete routes.
- Modify `src/server/profiles/profileService.ts`: add `AdminProfileSummary` types and `listAdminProfileSummaries()`.
- Modify `src/server/app.ts`: mount `/api/admin` behind `requireSetupToken(config)`.
- Modify `src/web/api.ts`: add admin response types and fetch helpers.
- Create `src/web/components/AdminDashboard.tsx`: dashboard panel, summary stats, profile table, issue/copy/delete actions.
- Modify `src/web/App.tsx`: store `isAdmin` from setup status and render `AdminDashboard` only when `profileReady && isAdmin`.
- Modify `src/web/styles.css`: add admin dashboard table and responsive styles.
- Add `tests/adminRoutes.test.ts`: backend authorization and behavior tests.
- Modify `tests/webApp.test.tsx`: mock admin API helpers and assert visibility/actions.

## Task 1: Backend Admin API

**Files:**
- Create: `tests/adminRoutes.test.ts`
- Create: `src/server/admin/adminRoutes.ts`
- Modify: `src/server/profiles/profileService.ts`
- Modify: `src/server/app.ts`

- [ ] **Step 1: Write failing admin route tests**

Add `tests/adminRoutes.test.ts` with this structure:

```ts
import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { migrate } from "../src/server/db/schema";

function config(): AppConfig {
  return {
    baseUrl: "https://addon.example.test",
    configDir: "/tmp",
    sqlitePath: ":memory:",
    encryptionKey: "0123456789abcdef0123456789abcdef",
    setupToken: "setup-secret-123",
    allowPublicProfileApi: false,
    port: 7000,
    logLevel: "error",
    crawlerConcurrency: 2,
    ftpTimeoutMs: 15000,
    ftpMaxConnections: 4,
    maxOnDemandSearchMs: 4500,
    profileRateLimitWindowMs: 60000,
    profileRateLimitMax: 30,
    tmdbApiKey: null,
    scanGlobalConcurrency: 1,
    scanQueueMax: 10,
    scanCooldownMs: 60000,
    scanMinRescanIntervalMinutes: 0,
    scanJobTimeoutMs: 1800000,
    scanSchedulerIntervalMs: 60000,
    scanProgressAverageItems: 2000,
    scanTransientRetryDelayMs: 300000,
    maxFtpServersPerProfile: 0,
    proxyStreamsDisabled: false,
    adminBrowserUids: new Set(["admin-uid"]),
    emptyProfileCleanupDays: 0,
    emptyProfileCleanupIntervalMs: 60000,
  };
}

async function createProfile(app: ReturnType<typeof createApp>, browserUid: string, passphrase = "passphrase") {
  return request(app).post("/api/profile").set("x-setup-token", "setup-secret-123").send({ browserUid, passphrase }).expect(201);
}

describe("admin routes", () => {
  it("requires setup token and admin profile credentials", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    await createProfile(app, "user-uid");

    await request(app).post("/api/admin/profiles").send({ browserUid: "admin-uid", passphrase: "passphrase" }).expect(403);
    await request(app).post("/api/admin/profiles").set("x-setup-token", "setup-secret-123").send({ browserUid: "user-uid", passphrase: "passphrase" }).expect(403);
    await request(app).post("/api/admin/profiles").set("x-setup-token", "setup-secret-123").send({ browserUid: "admin-uid", passphrase: "wrong-passphrase" }).expect(401);
  });

  it("lists profile summaries for an admin", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    const response = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.summary.profiles).toBe(2);
    expect(response.body.summary.ftpServers).toBe(2);
    expect(response.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: user.body.profileId,
          browserUid: "user-uid",
          ftpServers: 1,
          configuredFtpServers: 0,
          indexedItems: 0,
          activeScans: 0,
          pendingScans: 0,
          manifestUrl: null,
          stremioInstallUrl: null,
        }),
      ]),
    );
  });

  it("issues a fresh manifest URL and keeps it usable", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    const response = await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/manifest-token`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    expect(response.body.manifestUrl).toMatch(/^https:\/\/addon\.example\.test\/u\/.+\/manifest\.json$/);
    const token = String(response.body.manifestUrl).match(/\/u\/([^/]+)\/manifest\.json$/)?.[1];
    await request(app).get(`/u/${token}/manifest.json`).expect(200);
  });

  it("deletes a target profile", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = createApp(config(), db);
    await createProfile(app, "admin-uid");
    const user = await createProfile(app, "user-uid");

    await request(app)
      .post(`/api/admin/profiles/${user.body.profileId}/delete`)
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);

    const response = await request(app)
      .post("/api/admin/profiles")
      .set("x-setup-token", "setup-secret-123")
      .send({ browserUid: "admin-uid", passphrase: "passphrase" })
      .expect(200);
    expect(response.body.profiles.map((profile: { browserUid: string }) => profile.browserUid)).not.toContain("user-uid");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest tests/adminRoutes.test.ts --run`

Expected: FAIL with `expected 403 "Forbidden", got 404 "Not Found"` or equivalent missing route errors.

- [ ] **Step 3: Add service summary method**

In `src/server/profiles/profileService.ts`, export these types and method:

```ts
export type AdminProfileSummary = {
  id: number;
  browserUid: string;
  createdAt: string;
  updatedAt: string;
  lastUnlockedAt: string | null;
  ftpServers: number;
  configuredFtpServers: number;
  indexedItems: number;
  lastScanAt: string | null;
  pendingScans: number;
};

export type AdminProfileList = {
  summary: {
    profiles: number;
    configuredProfiles: number;
    ftpServers: number;
    configuredFtpServers: number;
    indexedItems: number;
    pendingScans: number;
  };
  profiles: AdminProfileSummary[];
};
```

Add a public `listAdminProfileSummaries(): AdminProfileList` method that uses one SQL query grouped by profile and returns zero counts via `coalesce(...)`.

- [ ] **Step 4: Add admin routes**

Create `src/server/admin/adminRoutes.ts`:

```ts
import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ScanQueue } from "../scanner/scanQueue.js";
import { ProfileNotFoundError, ProfileService } from "../profiles/profileService.js";

const adminAuthSchema = z.object({
  browserUid: z.string().min(8),
  passphrase: z.string().min(8),
});

const profileIdSchema = z.coerce.number().int().positive();

function urls(baseUrl: string, token: string) {
  const manifestUrl = `${baseUrl}/u/${token}/manifest.json`;
  return { manifestUrl, stremioInstallUrl: manifestUrl.replace(/^https?:\/\//, "stremio://") };
}

export function adminRoutes(config: AppConfig, service: ProfileService, scanQueue: ScanQueue) {
  const router = Router();

  async function authorize(body: unknown) {
    const parsed = adminAuthSchema.safeParse(body);
    if (!parsed.success) return { ok: false as const, status: 400, error: "Invalid admin request" };
    try {
      await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
    } catch {
      return { ok: false as const, status: 401, error: "Invalid passphrase" };
    }
    if (!config.adminBrowserUids.has(parsed.data.browserUid)) {
      return { ok: false as const, status: 403, error: "Admin access required" };
    }
    return { ok: true as const };
  }

  router.post("/profiles", async (req, res) => {
    const auth = await authorize(req.body);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const list = service.listAdminProfileSummaries();
    const profiles = list.profiles.map((profile) => {
      const scanStatus = scanQueue.getProfileScanStatus(profile.id);
      const activeScans = scanStatus.status === "running" ? 1 : 0;
      const queuedScans = scanStatus.status === "queued" ? 1 : 0;
      return {
        ...profile,
        activeScans,
        pendingScans: profile.pendingScans + queuedScans,
        manifestUrl: null,
        stremioInstallUrl: null,
      };
    });
    res.json({
      summary: {
        ...list.summary,
        activeScans: profiles.reduce((sum, profile) => sum + profile.activeScans, 0),
        pendingScans: profiles.reduce((sum, profile) => sum + profile.pendingScans, 0),
      },
      profiles,
    });
  });

  router.post("/profiles/:profileId/manifest-token", async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile id" });
    const auth = await authorize(req.body);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    try {
      const issued = service.issueInstallToken(profileId.data);
      res.json({ profileId: profileId.data, ...urls(config.baseUrl, issued.installUrlToken) });
    } catch (error) {
      if (error instanceof ProfileNotFoundError) return res.status(404).json({ error: "Profile not found" });
      throw error;
    }
  });

  router.post("/profiles/:profileId/delete", async (req, res) => {
    const profileId = profileIdSchema.safeParse(req.params.profileId);
    if (!profileId.success) return res.status(400).json({ error: "Invalid profile id" });
    const auth = await authorize(req.body);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const deleted = service.deleteProfile(profileId.data);
    if (!deleted) return res.status(404).json({ error: "Profile not found" });
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 5: Mount route and run tests**

In `src/server/app.ts`, import and mount:

```ts
import { adminRoutes } from "./admin/adminRoutes.js";
```

```ts
app.use("/api/admin", requireSetupToken(config));
app.use("/api/admin", adminRoutes(config, profileService, scanQueue));
```

Run: `npx vitest tests/adminRoutes.test.ts --run`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add tests/adminRoutes.test.ts src/server/admin/adminRoutes.ts src/server/profiles/profileService.ts src/server/app.ts
git commit -m "Add admin profile API"
```

## Task 2: Web API Client

**Files:**
- Modify: `src/web/api.ts`

- [ ] **Step 1: Add admin API types and helpers**

Add exported types `AdminProfileSummary`, `AdminProfileListResponse`, `AdminManifestTokenResponse`, and helpers:

```ts
export async function loadAdminProfiles(request: CreateProfileRequest): Promise<AdminProfileListResponse> {
  const response = await fetch("/api/admin/profiles", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<AdminProfileListResponse>(response);
}

export async function issueAdminManifestToken(request: CreateProfileRequest & { profileId: number }): Promise<AdminManifestTokenResponse> {
  const response = await fetch(`/api/admin/profiles/${request.profileId}/manifest-token`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ browserUid: request.browserUid, passphrase: request.passphrase }),
  });
  return readJson<AdminManifestTokenResponse>(response);
}

export async function deleteAdminProfile(request: CreateProfileRequest & { profileId: number }): Promise<{ ok: true }> {
  const response = await fetch(`/api/admin/profiles/${request.profileId}/delete`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ browserUid: request.browserUid, passphrase: request.passphrase }),
  });
  return readJson<{ ok: true }>(response);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add src/web/api.ts
git commit -m "Add admin dashboard API client"
```

## Task 3: Admin Dashboard UI

**Files:**
- Create: `src/web/components/AdminDashboard.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Modify: `tests/webApp.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Update `tests/webApp.test.tsx` mock imports with `loadAdminProfiles`, `issueAdminManifestToken`, and `deleteAdminProfile`. Add tests asserting:

```ts
it("hides the admin dashboard for non-admin profiles", async () => {
  loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: false });
  createProfileMock.mockResolvedValue({
    profileId: 1,
    recoveryUid: "browser-uid",
    manifestUrl: "https://addon.example.test/u/token/manifest.json",
    stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
  });
  saveCustomizationMock.mockResolvedValue({ ok: true });

  render(<App />);
  fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
  await screen.findByRole("link", { name: "Install in Stremio" });

  expect(screen.queryByRole("heading", { name: "Admin dashboard" })).toBeNull();
});
```

```ts
it("shows admin profile summaries for admin profiles", async () => {
  loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: true });
  loadAdminProfilesMock.mockResolvedValue({
    summary: { profiles: 2, configuredProfiles: 1, ftpServers: 3, configuredFtpServers: 2, indexedItems: 44, activeScans: 0, pendingScans: 1 },
    profiles: [
      { id: 2, browserUid: "user-uid", createdAt: "2026-05-16T00:00:00.000Z", updatedAt: "2026-05-16T00:00:00.000Z", lastUnlockedAt: null, ftpServers: 2, configuredFtpServers: 1, indexedItems: 44, lastScanAt: null, activeScans: 0, pendingScans: 1, manifestUrl: null, stremioInstallUrl: null },
    ],
  });
  unlockProfileMock.mockResolvedValue({
    profileId: 1,
    manifestUrl: "https://addon.example.test/u/admin/manifest.json",
    stremioInstallUrl: "stremio://addon.example.test/u/admin/manifest.json",
  });

  render(<App />);
  fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock profile" }));

  await screen.findByRole("heading", { name: "Admin dashboard" });
  expect(screen.getByText("user-uid")).toBeTruthy();
  expect(screen.getByText("44")).toBeTruthy();
});
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `npx vitest tests/webApp.test.tsx --run`

Expected: FAIL because admin helpers/component are missing.

- [ ] **Step 3: Build `AdminDashboard` component**

Create `src/web/components/AdminDashboard.tsx` with props:

```ts
type AdminDashboardProps = {
  browserUid: string;
  passphrase: string;
};
```

Use `useEffect` to call `loadAdminProfiles`, render a `.panel.admin-dashboard-panel`, summary `<dl className="status-list admin-summary-list">`, a table, and row buttons for issuing and deleting. Use `StatusBadge`, `Notice`, and `formatScanTime` from `ui.tsx`.

- [ ] **Step 4: Render only for admins**

In `src/web/App.tsx`, add:

```ts
const [isAdmin, setIsAdmin] = useState(false);
```

Set it from `loadSetupStatus(recoveryUid)`:

```ts
setIsAdmin(Boolean(status.isAdmin));
```

Render:

```tsx
{profileReady && isAdmin ? <AdminDashboard browserUid={recoveryUid} passphrase={passphrase} /> : null}
```

- [ ] **Step 5: Add styles**

In `src/web/styles.css`, add `.admin-dashboard-panel`, `.admin-profile-table-wrap`, `.admin-profile-table`, `.admin-actions`, and mobile stacking rules under the existing responsive section.

- [ ] **Step 6: Run UI tests**

Run: `npx vitest tests/webApp.test.tsx --run`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add tests/webApp.test.tsx src/web/components/AdminDashboard.tsx src/web/App.tsx src/web/styles.css
git commit -m "Add admin dashboard UI"
```

## Task 4: Full Verification

**Files:**
- No planned file edits.

- [ ] **Step 1: Run focused backend tests**

Run: `npx vitest tests/adminRoutes.test.ts tests/profileRoutes.test.ts --run`

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Run production build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit fixes if verification required changes**

If verification required code changes, commit with:

```bash
git add <changed files>
git commit -m "Stabilize admin dashboard verification"
```

## Self-Review

- Spec coverage: backend auth, summary, fresh manifest URL, delete, admin-only UI, and debug-only edit scope are covered.
- Placeholder scan: no incomplete markers or fill-in instructions are present.
- Type consistency: route paths match the spec; UI and API types use `AdminProfileSummary`, `AdminProfileListResponse`, and `AdminManifestTokenResponse`.
