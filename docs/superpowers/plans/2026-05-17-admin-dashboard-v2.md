# Admin Dashboard V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add country-of-origin display, admin promotion toggles, and UID search to the admin dashboard.

**Architecture:** Extend the existing `profiles` table with country/admin metadata, teach admin authorization about DB-promoted admins, expose a toggle endpoint, then update the existing dashboard component with search and row actions.

**Tech Stack:** Express, better-sqlite3, zod, React, Testing Library, Vitest.

---

## Tasks

### Task 1: Backend Country/Admin State

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/profiles/profileService.ts`
- Modify: `src/server/profiles/profileRoutes.ts`
- Modify: `src/server/admin/adminRoutes.ts`
- Modify: `src/server/app.ts`
- Modify: `tests/adminRoutes.test.ts`
- Modify: `tests/profileRoutes.test.ts`
- Modify: `tests/schema.test.ts`

- [ ] Write failing tests for country capture, admin summary metadata, DB admin authorization, admin toggle, and blocked self-demotion.
- [ ] Add profile columns and migration helpers.
- [ ] Add service helpers for country updates, admin checks, admin toggles, and summary fields.
- [ ] Capture `cf-ipcountry` on create/unlock and admin auth.
- [ ] Add `POST /api/admin/profiles/:profileId/admin`.
- [ ] Run focused backend tests and commit.

### Task 2: Web API

**Files:**
- Modify: `src/web/api.ts`
- Modify: `tests/api.test.ts`

- [ ] Write failing tests for `setAdminProfileEnabled`.
- [ ] Add `AdminProfileSummary` fields and API helper.
- [ ] Run API tests and typecheck.
- [ ] Commit.

### Task 3: Dashboard UI

**Files:**
- Modify: `src/web/components/AdminDashboard.tsx`
- Modify: `src/web/styles.css`
- Modify: `tests/webApp.test.tsx`

- [ ] Write failing tests for search filtering and admin toggle action.
- [ ] Add search input, country column, admin state column/toggle.
- [ ] Add compact responsive styles.
- [ ] Run UI tests and typecheck.
- [ ] Commit.

### Task 4: Verification

**Files:**
- No planned edits.

- [ ] Run `npx vitest tests/adminRoutes.test.ts tests/profileRoutes.test.ts tests/schema.test.ts --run`.
- [ ] Run `npx vitest tests/api.test.ts tests/webApp.test.tsx --run`.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Restart local LAN server if needed.

## Self-Review

- Scope matches the approved v2 design.
- No external GeoIP dependency is introduced.
- Admin demotion has a safety guard.
- Search is local and does not add new backend query complexity.
