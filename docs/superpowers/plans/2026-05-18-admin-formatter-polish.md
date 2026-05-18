# Admin And Formatter Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3D formatter tokens and improve admin shared-index workflows.

**Architecture:** Keep the formatter changes in shared utilities so preview and Stremio stream output use the same detection. Extend admin profile payloads with server-level link metadata, then update the existing AdminDashboard component with focused modal state and actions.

**Tech Stack:** TypeScript, React, Express, better-sqlite3, Vitest.

---

### Task 1: Formatter 3D Type

**Files:**
- Modify: `src/shared/streamFormatter.ts`
- Modify: `src/server/stremio/streamResolver.ts`
- Modify: `src/web/components/StreamFormatterPanel.tsx`
- Test: `tests/streamFormatter.test.ts`

- [ ] Add `stream3DType(filename)` with specific-before-generic filename patterns.
- [ ] Add `"3dtype"` and `threeDType` to stream formatter contexts.
- [ ] Add a `3D type` token button and 3D preview filename.
- [ ] Verify formatter tests cover `Full SBS`, `Half SBS`, `Full OU`, `Half OU`, `MVC`, and bare `3D`.

### Task 2: Admin Server Metadata And Delete Endpoint

**Files:**
- Modify: `src/server/profiles/profileService.ts`
- Modify: `src/server/admin/adminRoutes.ts`
- Modify: `src/web/api.ts`
- Test: `tests/adminRoutes.test.ts`

- [ ] Include `lastIndexedAt` and shared-link `autoLinked` metadata in admin profile server details.
- [ ] Add `DELETE` equivalent POST endpoint for disabled shared index groups.
- [ ] Enforce disabled-only deletion in `ProfileService`.
- [ ] Verify enabled groups reject deletion and disabled groups delete.

### Task 3: Admin Dashboard UI

**Files:**
- Modify: `src/web/components/AdminDashboard.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/webApp.test.tsx`

- [ ] Remove manifest column and manifest sorting.
- [ ] Make the link action issue and copy manifest URLs.
- [ ] Add `Auto-L`, `Linked`, and `Partial` state calculation.
- [ ] Add profile server modal with link/unlink actions.
- [ ] Add rotate-key confirmation modal.
- [ ] Show disabled-group delete action with confirmation modal.
- [ ] Apply Library settings-style green grid treatment to shared index sections.

### Task 4: Verification

**Files:**
- Test: `tests/streamFormatter.test.ts`
- Test: `tests/adminRoutes.test.ts`
- Test: `tests/webApp.test.tsx`

- [ ] Run targeted tests.
- [ ] Run typecheck.
- [ ] Run Compound Engineering review and apply necessary adjustments.
