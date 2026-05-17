# Shared Index Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-approved shared FTP index groups so many profile servers can reuse one scan while keeping per-user FTP credentials for playback.

**Architecture:** Build this as a phased local feature. MVP extends the existing scan/index pipeline with a shared target type instead of adding an independent queue, stores shared media separately, and authorizes playback through the requesting profile's linked server. Admin preapproval uses high-entropy linking tokens stored only as hashes; imported keys can request a link but never create or approve a group.

**Tech Stack:** TypeScript, Express, better-sqlite3, React, Vitest, Vite.

---

## Terms

- `shared index group`: Canonical domain object representing one FTP library surface.
- `sharedIndexKey`: Raw high-entropy portable/API linking token. It is shown only at creation/rotation time and may appear in admin-distributed import files.
- `shared_index_key_hash`: Database hash of `sharedIndexKey`; the raw key is never stored.
- `shared_index_group_id`: Foreign key on `profile_ftp_servers` that links a profile server to a group.
- `master_profile_ftp_server_id`: Foreign key from a group to the profile FTP server whose encrypted credentials are used for master scans.
- `profile-server target`: Existing scan target: one profile id plus one profile FTP server id.
- `shared-group target`: New scan target: one shared index group id.

## Security And Linking Contract

Shared groups do not store FTP credentials. They store only `master_profile_ftp_server_id`; credentials remain encrypted on `profile_ftp_servers` and are decrypted only at scan time.

Imported `sharedIndexKey` values only request auto-linking to an existing enabled group where `auto_link_imports = 1`. They do not create groups, approve groups, or bypass host/root validation.

Before linking a server to a group, the backend requires:

- Raw key hash matches the group's `shared_index_key_hash`.
- Group is enabled and auto-link is enabled, unless a super-admin uses an explicit link endpoint.
- Server host, port, TLS mode, invalid-certificate flag, and canonical root set match the group identity.
- Server root namespace is treated as identical to the group root namespace. No path transforms in MVP.

If accounts have different visible paths, they must use separate groups. This is the rule that handles same-host Whatbox accounts that need separate indexes.

## MVP Boundary

MVP includes:

- Schema for groups, shared media, shared directory snapshots, shared scan target metadata, and linked servers.
- Import/save plumbing for `sharedIndexKey`.
- Admin API enough to create/list groups, rotate key, link/unlink servers, choose master server, and trigger/cancel shared scans.
- Existing `ScanQueue` refactor to support profile-server and shared-group targets with one global concurrency counter.
- Shared stream/proxy authorization.
- Minimal user UI status for linked servers.
- Minimal admin UI management inside the existing admin dashboard.

Deferred:

- Per-linked-server path transforms.
- Full shared catalog enrichment parity if it becomes too large; MVP may reuse parsed shared media for stream matching first.
- Advanced audit logs.
- Bulk migration of existing duplicate indexes.
- Public GitHub push or Oracle deploy.

## Task 1: Portable Import Key Plumbing

**Files:**
- Modify: `src/web/portableSettings.ts`
- Modify: `src/web/components/ServerAccordion.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/api.ts`
- Modify: `src/server/profiles/profileRoutes.ts`
- Modify: `src/server/profiles/profileService.ts`
- Test: `tests/portableSettings.test.ts`

- [ ] Add optional `sharedIndexKey` to `PortableServer`.
- [ ] Accept schema versions `1` and `2`; serialize exports as version `2` only when at least one server carries a shared key.
- [ ] Add `sharedIndexKey` to `ServerForm`, `portableServerToForm`, `serverFormFromPayload`, `SaveServerRequest`, `saveServerSchema`, `FtpServerInput`, and `saveFtpServer`.
- [ ] Default normal profile export to omit `sharedIndexKey`; add a later admin-only export path if needed. User exports should not spread reusable linking tokens accidentally.
- [ ] Test v1 parsing, v2 parsing, form plumbing, and that normal user export omits shared keys.

## Task 2: Shared Schema And Migration

**Files:**
- Modify: `src/server/db/schema.ts`
- Test: `tests/schema.test.ts`

- [ ] Add `shared_index_groups` with `id`, `key_hint`, `name`, `shared_index_key_hash`, `host`, `port`, `tls_mode`, `allow_invalid_certificate`, `root_paths_json`, `library_layout`, `catalog_content_json`, `enabled`, `auto_link_imports`, `master_profile_ftp_server_id`, `indexed_media_count`, `last_indexed_at`, timestamps.
- [ ] Add `shared_media_files` mirroring media parse columns, keyed by `shared_index_group_id + ftp_path`.
- [ ] Add `shared_directory_snapshots` mirroring directory snapshots, keyed by `shared_index_group_id + dir_path`.
- [ ] Extend existing `scan_jobs` with nullable `target_kind` (`profile_server` or `shared_group`) and `shared_index_group_id`, defaulting old rows to `profile_server`.
- [ ] Add nullable `shared_index_group_id` and `shared_index_key_hash` to `profile_ftp_servers`.
- [ ] Add indexes for group key hash, linked servers, shared media matching, shared snapshots, and scan jobs by target/status.
- [ ] Use `on delete set null` for `master_profile_ftp_server_id`; deleting the master disables shared scans until reassigned.
- [ ] Test idempotent migration and migration against an existing-style DB.

## Task 3: Shared Index Domain Methods

**Files:**
- Modify: `src/server/profiles/profileService.ts`
- Modify: `src/server/media/mediaRepository.ts`
- Create: `src/server/shared/sharedIndex.ts`
- Test: `tests/sharedIndex.test.ts`

- [ ] Put group/link persistence near profile/server ownership in `ProfileService`.
- [ ] Put shared media read/write methods in `MediaRepository`.
- [ ] Keep `src/server/shared/sharedIndex.ts` limited to pure helpers: key generation/hash, root canonicalization, server identity comparison, and redaction.
- [ ] Implement `createSharedIndexGroup`, `rotateSharedIndexKey`, `listSharedIndexGroups`, `linkServerToSharedGroup`, `unlinkServerFromSharedGroup`, `resolveApprovedSharedIndexKey`, and `sharedIndexStatusForServer`.
- [ ] Store only key hashes; raw keys are returned only from create/rotate.
- [ ] On unlink, clear shared fields and leave the server unshared with manual scan schedule disabled until the user/admin chooses otherwise.
- [ ] If master server is deleted/unlinked, set `master_profile_ftp_server_id = null` and prevent shared rescan with a clear status/error.
- [ ] Test wrong key, disabled group, mismatched host/root, unlink, master deletion, and no plaintext credential storage.

## Task 4: Scan Target Refactor

**Files:**
- Modify: `src/server/scanner/scanQueue.ts`
- Modify: `src/server/ftp/crawler.ts`
- Modify: `src/server/media/mediaRepository.ts`
- Test: `tests/scanQueue.test.ts`
- Test: `tests/crawler.test.ts`

- [ ] Refactor `ScanQueue` to use one queue with target union `{ kind: "profile_server"; profileId; serverId } | { kind: "shared_group"; sharedIndexGroupId }`.
- [ ] Keep one `activeCount`, one queued-count check, one cancellation controller map, and one pump loop so shared scans respect `SCAN_GLOBAL_CONCURRENCY` and `SCAN_QUEUE_MAX`.
- [ ] Add a `ScanRepository` interface used by the crawler for all scan writes: `upsertParsedFile`, `markSeenUnderRoot`, `saveDirectorySnapshot`, `touchDirectorySnapshot`, `directorySnapshotMatchesModifiedAt`, `directorySnapshotMatchesFingerprint`, `deleteStaleUnderRoot`, `clearDirectorySnapshots`, and `count`.
- [ ] Implement profile-server and shared-group scan repository adapters.
- [ ] For shared scans, load parser/catalog policy from the group, not from an arbitrary linked user.
- [ ] Test shared full scan, incremental snapshot skip, force rescan snapshot clear, stale deletion, cancellation, queue max, and concurrency with mixed profile/shared jobs.

## Task 5: Profile API And Aggregation

**Files:**
- Modify: `src/server/profiles/profileRoutes.ts`
- Modify: `src/server/profiles/profileService.ts`
- Modify: `src/server/media/mediaRepository.ts`
- Modify: `src/web/api.ts`
- Test: `tests/profileRoutes.test.ts`

- [ ] Include safe shared metadata in server payloads: group id, group name, key hint, linked status, last scan, media count, scan status, and user-facing message. Do not include raw key, master profile uid, passwords, or full file paths.
- [ ] When saving a server with `sharedIndexKey`, call `resolveApprovedSharedIndexKey`; link only if identity matches. Unknown or invalid keys save the server unlinked and return a clear message.
- [ ] Linked servers search shared media only for that server; stale profile-scoped media for that server is ignored while linked.
- [ ] Linked server index status uses shared group status/counts in server payloads and global stats.
- [ ] Disable per-user scan schedules for linked servers; saving a schedule returns a clear API error.
- [ ] User rescan/cancel for a linked server maps to the shared-group target.
- [ ] Test linked payloads, invalid key behavior, linked schedule rejection, global count aggregation, and stale local media not appearing for linked servers.

## Task 6: Stream And Proxy Authorization

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/server/stremio/streamResolver.ts`
- Modify: `src/server/stremio/routes.ts`
- Modify: `src/server/proxy/ftpProxyResolver.ts`
- Modify: `src/server/proxy/proxyRoutes.ts`
- Test: `tests/streamResolver.test.ts`
- Test: `tests/ftpProxyResolver.test.ts`
- Test: `tests/stremioRoutes.test.ts`
- Test: `tests/proxyRoutes.test.ts`

- [ ] Inject shared group/media dependencies through `createApp`, `stremioRoutes`, and proxy resolver.
- [ ] Include shared matches only for profile servers linked to enabled shared groups.
- [ ] Generate `/proxy/:installToken/shared/:serverId/:sharedMediaId` for shared proxy streams.
- [ ] Register GET/HEAD shared proxy routes.
- [ ] Shared proxy resolver validates install token, profile owns server, server is linked, server identity still matches group, shared media belongs to that group, and FTP config is present.
- [ ] Proxy playback opens FTP with the requesting profile server credentials, never master credentials.
- [ ] Direct FTP mode remains allowed only if the linked server is configured for direct mode; tests prove direct URLs use requesting user credentials only.
- [ ] Test wrong profile, wrong server, wrong group, disabled group, mismatched host/root, missing credentials, and direct/proxy behavior.

## Task 7: Admin Shared Index API

**Files:**
- Modify: `src/server/admin/adminRoutes.ts`
- Modify: `src/web/api.ts`
- Test: `tests/adminRoutes.test.ts`

- [ ] Add super-admin-only endpoints to list groups, create group from an existing profile server, update group metadata/settings, rotate key, link server, unlink server, set master server, trigger shared rescan, and cancel shared scan.
- [ ] API responses include linked profile/server counts, safe master server label/id, status/counts, and last scan. They never include passwords or decrypted FTP config.
- [ ] Create/update validates canonical root identity and key uniqueness.
- [ ] Link endpoint rejects mismatched host/root/TLS unless the admin explicitly creates a separate group.
- [ ] Rescan endpoint rejects groups without a valid master server.
- [ ] Test auth, redaction, create/list/link/unlink, rotate key, set master, rescan/cancel, and mismatched identity rejection.

## Task 8: User And Admin UI

**Files:**
- Modify: `src/web/components/ServerAccordion.tsx`
- Modify: `src/web/components/AdminDashboard.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/serverAccordion.test.tsx`
- Test: `tests/adminDashboardLayout.test.ts`

- [ ] User linked server card shows shared group name/key hint, item count, last scan, and copy: `Scanning handled by shared master index`.
- [ ] Linked scan states:
  - Idle/no master: gray badge, rescan disabled, message says master account must be selected.
  - Queued: amber badge, cancel enabled.
  - Running: amber badge with progress, cancel enabled.
  - Succeeded: green badge with last scan and item count, rescan enabled.
  - Failed: red badge with error and rescan enabled when master is valid.
  - Disabled group: gray/red message, stream/search unavailable.
- [ ] Disable rescan frequency select for linked servers with helper text.
- [ ] Admin table columns: group name, key hint, host, roots, linked accounts, master server, items, last scan, status, actions.
- [ ] Admin actions: create from selected profile server, edit name/settings, rotate key with one-time display, copy key, set master, link/unlink, scan, halt, disable/enable.
- [ ] Admin success/error feedback covers invalid key, failed scan, missing/deleted master, FTP failure, revoked group, unauthorized playback, network failure, and cancel failure.
- [ ] Mobile admin layout becomes stacked rows/cards with actions in a compact row/menu, no horizontal body scrollbar, accessible labels, keyboard reachable controls, and 44px touch targets.

## Task 9: Documentation And Local Oracle DB Verification

**Files:**
- Modify: `README.md`
- Local only: `.config/oracle-test/stremio-ftp.sqlite`

- [ ] Document shared index groups, key safety, import behavior, and admin-only lifecycle.
- [ ] Copy the Oracle SQLite DB locally into an ignored path.
- [ ] Run migration against the local copy.
- [ ] Query `sputnik.whatbox.ca` entries for candidate shared groups without committing DB output or decrypted data.
- [ ] Keep Oracle DB verification as local/manual evidence only.

## Task 10: Full Verification And Local Commit

**Files:**
- No new files expected beyond implementation and tests.

- [ ] Run targeted tests after each task.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Start local server and verify user/admin UI locally.
- [ ] Commit the local branch only.
- [ ] Do not push to public GitHub and do not deploy to Oracle unless explicitly requested later.
