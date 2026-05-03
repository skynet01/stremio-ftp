# Background Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move FTP index refreshes into a persisted background queue with profile locking, cooldowns, scheduled scans, progress reporting, and portal controls.

**Architecture:** Add a server-side scan queue service owned by `createApp`, backed by SQLite job/status rows. Profile routes enqueue and poll jobs instead of blocking on FTP crawling, while the crawler reports progress into the active job. The React portal saves a scan interval, starts scans, polls progress, and renders a reload-safe progress bar with approximate ETA.

**Tech Stack:** Express, better-sqlite3, TypeScript, React, Vitest, Testing Library.

---

### Task 1: Persist Scan State And Config

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/profiles/profileService.ts`
- Test: `tests/config.test.ts`
- Test: `tests/schema.test.ts`

- [ ] Add env config for scan concurrency, queue size, cooldown, timeout, scheduler interval, and average item estimate.
- [ ] Add profile scan schedule columns and `scan_jobs` table.
- [ ] Add profile service methods to save/load scan interval and next schedule time.
- [ ] Run config/schema tests.

### Task 2: Add Background Scan Queue

**Files:**
- Create: `src/server/scanner/scanQueue.ts`
- Modify: `src/server/ftp/crawler.ts`
- Modify: `src/server/app.ts`
- Test: `tests/scanQueue.test.ts`
- Test: `tests/crawler.test.ts`

- [ ] Write failing queue tests for enqueue, per-profile lock, cooldown, progress, and completion.
- [ ] Add optional crawler progress callback.
- [ ] Implement queue worker with persisted jobs and global concurrency.
- [ ] Wire one queue instance into `createApp`.
- [ ] Run queue/crawler tests.

### Task 3: Expose Scan APIs

**Files:**
- Modify: `src/server/profiles/profileRoutes.ts`
- Modify: `src/web/api.ts`
- Test: `tests/profileRoutes.test.ts`

- [ ] Change manual rescan route to enqueue and return job status.
- [ ] Add scan status route.
- [ ] Add scan schedule save route.
- [ ] Return scan status and schedule from FTP settings load.
- [ ] Run profile route tests.

### Task 4: Portal Controls And Progress

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/webApp.test.tsx`

- [ ] Add rescan frequency dropdown.
- [ ] Poll scan status while queued/running.
- [ ] Render progress bar, status message, and approximate ETA.
- [ ] Disable rescan while scan is active or cooldown is in effect.
- [ ] Run web UI tests.

### Task 5: Docs, Verification, Deploy

**Files:**
- Modify: `README.md`
- Modify: `docker-compose.yml`

- [ ] Document scan env variables and defaults.
- [ ] Run `npm test`, `npm run build`, `git diff --check`.
- [ ] Commit and push.
- [ ] Deploy with `./deploy-stremio-ftp.sh`.
