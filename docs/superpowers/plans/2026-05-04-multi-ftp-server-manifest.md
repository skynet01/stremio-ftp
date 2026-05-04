# Multi FTP Server Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one manifest aggregate multiple independently configured FTP servers with sequential scanning, deduped catalogs, and grouped stream alternatives.

**Architecture:** Add server rows under each profile, move media and scan ownership to `ftp_server_id`, and keep the manifest token at the profile level. Server APIs return aggregate profile status plus per-server state so the portal can render a global band and server accordions without opening FTP connections during polling.

**Tech Stack:** TypeScript, Express, better-sqlite3, React, Vitest, Vite, Docker Compose.

---

### Task 1: Schema and Services

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/profiles/profileService.ts`
- Modify: `src/server/media/mediaRepository.ts`
- Test: `tests/schema.test.ts`
- Test: `tests/profileService.test.ts`
- Test: `tests/mediaRepository.test.ts`

- [ ] Add `profile_ftp_servers`, migrate legacy profile settings into one default server, add `ftp_server_id` to `media_files` and `scan_jobs`, and enforce media uniqueness per server path.
- [ ] Add `ProfileService` methods for listing, creating, updating, deleting, and loading server settings.
- [ ] Add aggregate repository helpers for per-server counts, profile totals, deduped catalogs, and cross-server stream matches.

### Task 2: Scanner and Scheduler

**Files:**
- Modify: `src/server/scanner/scanQueue.ts`
- Modify: `src/server/ftp/crawler.ts`
- Test: `tests/scanQueue.test.ts`

- [ ] Scope queue operations by `ftp_server_id`.
- [ ] Ensure scans for one profile run sequentially, even when global concurrency allows more.
- [ ] Implement `pending_scan_after` debounce: saving settings schedules a scan five minutes later; manual rescan starts immediately.
- [ ] Preserve halt behavior for queued/running server scans.

### Task 3: API Routes

**Files:**
- Modify: `src/server/profiles/profileRoutes.ts`
- Modify: `src/web/api.ts`
- Test: `tests/profileRoutes.test.ts`
- Test: `tests/api.test.ts`

- [ ] Return aggregate profile status and all servers from load/status endpoints.
- [ ] Add server create, save, delete, test, rescan, cancel, and schedule endpoints.
- [ ] Keep existing single-server endpoints mapped to the default server where needed for compatibility.

### Task 4: Stremio Aggregation and Proxy

**Files:**
- Modify: `src/server/stremio/routes.ts`
- Modify: `src/server/stremio/streamResolver.ts`
- Modify: `src/server/proxy/ftpProxyResolver.ts`
- Test: `tests/stremioRoutes.test.ts`
- Test: `tests/streamResolver.test.ts`
- Test: `tests/proxyRoutes.test.ts`

- [ ] Deduplicate catalog/meta entries across servers.
- [ ] Return all matching streams across servers with server names in stream labels/descriptions.
- [ ] Resolve proxied media by profile and media id, then use the owning server FTP config.

### Task 5: Portal UI

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/components/FtpSettingsPanel.tsx`
- Modify: `src/web/components/IndexStatusPanel.tsx`
- Create: `src/web/components/GlobalStatusPanel.tsx`
- Create: `src/web/components/ServerAccordion.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/webApp.test.tsx`

- [ ] Replace single FTP/library/index state with a list of server view models.
- [ ] Render the global status band.
- [ ] Render line-separated server accordions with server-specific settings and actions.
- [ ] Disable delete on the only server.
- [ ] Poll status while any server scan is active.

### Task 6: Version, Docs, Verification, Deploy

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

- [ ] Bump version to `0.3.0`.
- [ ] Document multi-server manifests, debounce scanning, and `FTP_MAX_CONNECTIONS`.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Commit, push, sync to `/opt/stremio-ftp`, rebuild/restart `stremio-ftp`, and verify live health/config.
