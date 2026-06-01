# Handoff: Shared Index Schedule Sync, Stream Status, Shared Catalog Fixes, and Genre Matching

Date: 2026-05-24 / 2026-05-25
Branch: `admin-dashboard`
Latest local commit: `ba79dd6 fix(catalog): align Other counts and series parsing`
Latest Oracle runtime commit: `ba79dd6 fix(catalog): align Other counts and series parsing`

## Summary

This change makes shared index scanning behave like a synchronized fleet instead of independent per-server timers.

- New shared index groups default to a 12 hour scan interval.
- Admin schedule selector labels the 12 hour interval as "Twice a day".
- Shared index scheduled scans align to interval boundaries.
- When any shared index group is due for a scheduled scan, all enabled scheduled shared index groups are queued together.
- Pending retry scans are still handled per server/group, so a transient failure retry does not fan out to every shared index group.
- Normal non-shared profile/server schedules keep the previous `now + interval` behavior.

The change also adds admin visibility into active proxy playback:

- `ProxyStreamTracker` tracks in-memory active proxy GET streams.
- `/api/admin/streams` returns active streams and summary counts.
- Admin dashboard shows a "Running streams" stat and a compact active stream list when streams are open.

The same deployment also fixes linked shared-index catalogs:

- Typed Stremio catalogs now read master shared-index enrichment for linked profile servers instead of only looking at the requesting profile's `catalog_enrichment` rows.
- Stale local enrichment rows are ignored for servers linked to shared indexes.
- This fixed UID `4c3d3982-c98e-469a-b585-e820e15d2184`, where the series catalog was effectively empty even though shared master enrichment had `71` series metas.
- Oracle pre-fix sweep found `48` affected linked profiles; post-fix sweep checked `51` linked profiles and found `0` missing shared catalog meta rows.

The follow-up Other catalog fix is also deployed:

- Other catalogs now include linked shared-index files from `shared_media_files`, not just local `media_files`.
- Shared Other catalog folder ids use `ftp-folder:shared:<serverId>:<sharedMediaId>` and resolve streams through the requesting linked profile server credentials.
- Servers linked to a shared index now inherit the shared group's catalog content flags on both manual/admin links and auto-links through `sharedIndexKey`.
- Existing Oracle linked server flags were synced from their shared groups after a DB backup. `7` rows changed.
- UID `4c3d3982-c98e-469a-b585-e820e15d2184` server `395` (`Adult Content`) now matches shared group `6` (`Adult Sputnik`): movies/series/anime disabled, uncategorized enabled.
- Profile `84` Adult Content Other catalog now returns `39` folder groups and shared stream lookup works through server `395`.
- Production sweep found `0` linked Other catalogs empty despite expected rows and `0` remaining shared catalog flag mismatches.

TMDB genre filters and tighter matching are also deployed:

- `main` was bumped to `0.4.45`, committed as `289c514 feat(catalog): add TMDB genre filters`, and pushed to GitHub.
- `admin-dashboard` merged that work, was bumped to `0.4.46`, and then deployed to Oracle through `7e626df feat(catalog): merge TMDB genre filters into admin`.
- Stremio typed catalogs (`ftp-movies`, `ftp-series`, `ftp-anime`) now expose a `genre` catalog extra with TMDB genre options.
- Catalog routes pass `extra.genre` into persisted catalog metadata queries.
- `catalog_enrichment` now stores `genres`; matched rows missing genres are eligible for refresh.
- Movie matching ranks TMDB candidates by normalized title/year instead of taking the first result.
- Movie matching retries stripped edition/cut variants such as `Ulysses Cut`.
- Scan refresh preserves the old matched meta if a newer refresh attempt comes back unmatched.

Admin Other counts and folder-series parsing were fixed in `0.4.47`:

- Admin per-server Movie/Anime/Series/Other counts now use `catalog_enrichment` when enrichment rows exist, matching what Stremio catalogs actually expose.
- Previously, server-level Other counted only raw `catalog_kind not in ('movie', 'series', 'anime')`, so server `341` showed Other `0` even though Stremio Other contained unresolved enrichment groups.
- Folder-layout series parsing now truncates folder titles at season markers and strips more release/source tokens (`AMZN`, `NF`, `iQ`, `DDP2.0`, `H.265`, release group suffixes, etc.).
- `EP01`/`E01` TV filenames under folder-layout libraries now parse as episodes instead of weak movie titles, without regressing movie titles like `Star Wars E2`.
- Oracle runtime verification for profile `74` / server `341` now reports admin counts: movies `5`, series `35`, anime `3`, Other `96`.

Oracle MOTD was updated:

- `/etc/update-motd.d/10-stats` now shows a credential-free active Stremio FTP proxy stream count by reading established connections to container port `7000`.
- The executable backup that caused duplicate MOTD output was removed; the remaining old `10-stats.bak-*` file is not executable.

## Key Files

- `src/server/scanner/schedule.ts`
- `src/server/scanner/scanQueue.ts`
- `src/server/profiles/profileService.ts`
- `src/server/proxy/streamTracker.ts`
- `src/server/proxy/proxyRoutes.ts`
- `src/server/proxy/ftpProxyResolver.ts`
- `src/server/admin/adminRoutes.ts`
- `src/server/media/mediaRepository.ts`
- `src/server/stremio/routes.ts`
- `src/web/components/AdminDashboard.tsx`
- `src/web/api.ts`
- `tests/mediaRepository.test.ts`
- `tests/sharedIndex.test.ts`
- `tests/stremioRoutes.test.ts`

## Verification

Passed locally:

```bash
npx vitest run --exclude '.worktrees/**'
npm run typecheck
npm run build
```

Most recent full run after the shared Other fix:

- `npx vitest run --exclude '.worktrees/**'` passed: `334` tests.
- `npm run typecheck` passed.
- `npm run build` passed.

Most recent full run after `0.4.47`:

- `npm run typecheck` passed.
- `npx vitest run --exclude '.worktrees/**'` passed: `28` files, `340` tests.
- `git diff --check` passed.

After adding the explicit auto-link regression test, targeted verification passed:

```bash
npx vitest run --exclude '.worktrees/**' tests/sharedIndex.test.ts tests/mediaRepository.test.ts tests/stremioRoutes.test.ts
npm run typecheck
```

Targeted result: `48` tests passed across those three files.

Note: plain `npm test` also discovers the checked-in `.worktrees/iso-feature` copy, which contains stale tests and should be excluded for current-branch verification.

## Deployment Status

Oracle is deployed and healthy.

- Runtime deployed through commit `adf5d01 fix(admin): count shared index Other from enrichment`.
- Runtime version is `0.4.48`.
- Oracle health check returned `{"ok":true,"service":"stremio-ftp","baseUrl":"https://ftpstrem.skynetsource.com"}`.
- Latest deployed app source backup: `/opt/stremio-ftp.pre-shared-other-counts-20260525-014316-adf5d01`
- Latest Oracle git bundle: `/opt/service-backups/stremio-ftp-admin-dashboard-shared-other-counts-20260525-014236-adf5d01.bundle`

Production DB backups made during this work:

- `/config/stremio-ftp.sqlite.pre-shared-catalog-metas-20260524T223328Z.bak`
- `/config/stremio-ftp.sqlite.pre-shared-other-catalogs-20260524T231002Z.bak`
- `/var/lib/docker/volumes/usenet-stack_stremio-ftp-config/_data/stremio-ftp.sqlite.pre-catalog-genres-20260525-003318.bak`
- `/var/lib/docker/volumes/usenet-stack_stremio-ftp-config/_data/stremio-ftp.sqlite.pre-other-counts-parser-20260525-004302.bak`
- `/var/lib/docker/volumes/usenet-stack_stremio-ftp-config/_data/stremio-ftp.sqlite.pre-shared-other-counts-20260525-014316.bak`

Recent source backups:

- `/opt/stremio-ftp.pre-catalog-genres-20260525-003318-7e626df`
- `/opt/stremio-ftp.pre-other-counts-parser-20260525-004302-ba79dd6`
- `/opt/stremio-ftp.pre-shared-other-counts-20260525-014316-adf5d01`

Recent Oracle bundles:

- `/opt/service-backups/stremio-ftp-admin-dashboard-catalog-genres-20260524-235321-7e626df.bundle`
- `/opt/service-backups/stremio-ftp-admin-dashboard-other-counts-parser-20260525-004219-ba79dd6.bundle`
- `/opt/service-backups/stremio-ftp-admin-dashboard-shared-other-counts-20260525-014236-adf5d01.bundle`

Earlier source backup from the typed shared catalog deploy:

- `/opt/stremio-ftp.pre-shared-catalog-metas-20260524-223533-56ce2c1`

Earlier bundle from the typed shared catalog deploy:

- `/opt/service-backups/stremio-ftp-admin-dashboard-shared-catalog-metas-20260524-223449-56ce2c1.bundle`

## Oracle Notes

- Admin branch deployments should be pushed to Oracle as git bundles only. Do not push `admin-dashboard` to GitHub unless the user explicitly asks for a GitHub push.
- Public app source path is `/opt/stremio-ftp`; it is not a git repo.
- Docker compose lives at `/opt/usenet-stack/docker-compose.yml` and builds `stremio-ftp` from `/opt/stremio-ftp`.
- DB path inside the container is `/config/stremio-ftp.sqlite`.
- Before deploys, check active Stremio FTP proxy streams:

```bash
ssh oracle 'docker exec stremio-ftp sh -lc "awk '\''NR > 1 { split(\$2, local, \":\"); if (\$4 == \"01\" && local[2] == \"1B58\") count++ } END { print count + 0 }'\'' /proc/net/tcp /proc/net/tcp6 2>/dev/null"'
```

- `1B58` is hex for container port `7000`. If nonzero, a Docker restart is likely to interrupt active streams.
- Do not deploy/rebuild/restart `stremio-ftp` on Oracle while the active stream count is nonzero unless the user explicitly approves interrupting streams.
- Clean up Oracle source, DB, and bundle backups older than 3 days during maintenance. Check before deleting, then remove stale paths under `/opt/stremio-ftp.pre-*`, `/opt/service-backups/*.bundle`, and `/var/lib/docker/volumes/usenet-stack_stremio-ftp-config/_data/*.bak`.
- Useful production check pattern:

```bash
ssh oracle "docker exec -i stremio-ftp node --input-type=module -" <<'NODE'
import Database from 'better-sqlite3';
import { MediaRepository } from '/app/dist/server/media/mediaRepository.js';
const db = new Database('/config/stremio-ftp.sqlite', { readonly: true, fileMustExist: true });
const repo = new MediaRepository(db);
// Inspect catalog behavior against deployed runtime code here.
NODE
```

## Commits

- `1b2eabb feat(admin): sync shared scans and show stream status`
- `56ce2c1 fix(catalog): serve shared metas for linked profiles`
- `8a3faac fix(catalog): include shared files in other catalogs`
- `fdf5d63 test(shared-index): cover auto-linked catalog flags`
- `289c514 feat(catalog): add TMDB genre filters`
- `7e626df feat(catalog): merge TMDB genre filters into admin`
- `ba79dd6 fix(catalog): align Other counts and series parsing`
- `adf5d01 fix(admin): count shared index Other from enrichment`

## Follow-Up

- Rescan profile `74` / server `341` (`Whatbox`) to rewrite existing parsed titles and enrichment rows with the `0.4.47` parser. Current old rows remain until rescan.
- Read-only dry run on the `96` current unmatched groups showed:
  - `82` groups would parse differently with the deployed parser.
  - `54` unique reparsed candidates.
  - `39` candidates matched TMDB, covering about `526` files.
  - `15` candidates still did not match, covering about `29` files.
- Remaining parser misses include absolute-number anime under `TV Shows`, bracketed completion folders like `[NOP] Last Cinderella [1-11 Complete]`, and specials/BTS files like `The.Prisoner.of.Beauty.BTS1`.
