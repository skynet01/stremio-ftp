# Handoff: Admin Dashboard, Shared Indexes, Playback Startup

Date: 2026-05-22
Branch: `admin-dashboard`
Latest local commit: `7ead040 fix(admin): count shared indexes in profile totals`
Production version: `0.4.44`

## Current State

`admin-dashboard` is ahead of `origin/admin-dashboard` by 10 commits. Those commits have been deployed to the Oracle server by git bundle and Docker rebuild. The admin branch has not been pushed to GitHub unless explicitly requested later.

Oracle production health is passing:

```text
https://ftpstrem.skynetsource.com/health
{"ok":true,"service":"stremio-ftp","baseUrl":"https://ftpstrem.skynetsource.com"}
```

Oracle container:

```text
stremio-ftp Up, published at 127.0.0.1:7011->7000/tcp
FTP_MAX_CONNECTIONS=3
```

Current untracked local files are intentional and should not be committed without review:

```text
bundles/
docs/handoff-2026-05-18-shared-index-enrichment.md
stremio-ftp-settings-linked.json
```

`stremio-ftp-settings-linked.json` contains sensitive FTP settings and was explicitly excluded from Oracle deployments.

## Recent Commits On Admin Branch

```text
7ead040 fix(admin): count shared indexes in profile totals
af38ccc feat(admin): show catalog counts in profile server details
7628373 fix: retry transient shared index scans
5828fb6 fix: refine shared index admin list UI
ca7661a fix: refine shared index counts and playback defaults
b860e9d fix: remove proxy body timing tap
6db261a fix: limit ftp connections per credential
b86583d fix: isolate proxy ftp connections
4869242 fix: preserve proxy stream flow while timing
9fd4ee5 feat: refine shared indexes and proxy timing
```

## Main Branch

Playback connection tuning was also applied to `main`, version bumped to `0.4.44`, and pushed to GitHub earlier.

Main includes:

- FTP warm connection support for faster playback start.
- Connection limiter keyed per distinct FTP credential/profile key.
- Default `FTP_MAX_CONNECTIONS=3`.
- Version/changelog updates for `0.4.44`.

## Shared Index / Admin UI Work

Implemented and deployed on Oracle:

- Master shared index groups with linked-server management.
- Shared index scans run catalog enrichment using the master server context.
- Shared index counts no longer double-count low-confidence movie rows as both Movie and Other.
- Movie/anime/series counts show exclusive indexed rows by `catalog_kind`; Other only catches rows outside those typed buckets.
- Index group admin cards show Movie, Anime, Series, Other counts in one row without boxed cell styling.
- Enabled state is text rather than a pill.
- Linked count opens a compact linked-server modal.
- Linked-server modal:
  - denser rows
  - UID + country flag first
  - server number in its own column
  - unlink is a text link
  - master server cannot be unlinked from that modal
- All site scrollbars use the styled scrollbar treatment.
- Shared index key action uses `rotate-ccw-key`.
- Admin server modal hides `Create group` when that exact profile/server already owns an index group.
- TMDB API key input was widened in both global and server/library settings.

## Playback Startup Work

Implemented and deployed:

- Proxy playback now warms an FTP connection on HEAD so the GET can reuse the ready client.
- Proxy stream path avoids body-tapping instrumentation because that broke playback flow.
- FTP connection limits are per credential key, not one global total.
- Oracle currently runs `FTP_MAX_CONNECTIONS=3`, meaning 3 simultaneous FTP sessions per distinct credential/profile key.
- Timing logs remain for proxy open phases:
  - `clientReadyMs`
  - `streamOpenMs`
  - `totalOpenMs`
  - route-level `resolveMs`, `headersMs`, `openMs`, `totalMs`

## Temporary ISO Stream Test On Oracle

On 2026-05-21, a reversible Oracle-only database patch was applied for UID `c69f07a0-b671-4beb-8135-bc17733bd970` to test whether CineUltra can consume raw Blu-ray ISO streams handed off by Stremio. No app code was deployed for this test.

What changed:

- Profile id: `6`
- Added one profile-local server row named `ISO Stream test`
- New local server id: `342`
- The server copies Tamarind credentials but is not linked to the shared Tamarind index
- Inserted 5 local `media_files` rows under server `342`, all with `quality = 'ISO Stream test'`
- Media ids:
  - `360979`: `ISO Stream test - Avatar 2009 3D Blu-ray EN.iso`
  - `360980`: `ISO Stream test - Avatar 2009 3D ES FR IT.iso`
  - `360981`: `ISO Stream test - Avatar Fire and Ash 2025 3D Disc 1.iso`
  - `360982`: `ISO Stream test - Avatar Fire and Ash 2025 3D Disc 2.iso`
  - `360983`: `ISO Stream test - Avatar The Way of Water 2022 3D Blu-ray.iso`

Observed behavior:

- The Stremio stream JSON returns the ISO entry for `tt1630029`.
- CineUltra opened the stream and showed the correct runtime, but playback was a black screen.
- Oracle logs showed successful `206` range requests and FTP stream opens against Tamarind. The client probed start/end ranges and offsets inside the ISO, then closed or errored the stream.
- Current read: Stremio FTP handoff and range serving are working; the remaining issue is likely protected Blu-ray ISO decode/decrypt support in the player path.

Backup created before patch:

```text
/var/lib/docker/volumes/usenet-stack_stremio-ftp-config/_data/backups/pre-iso-stream-test-20260521T200752Z.sqlite
```

Rollback if this test should be removed:

```bash
ssh oracle "docker exec -i stremio-ftp node -" <<'NODE'
const Database = require("better-sqlite3");
const db = new Database("/config/stremio-ftp.sqlite");
const result = db.transaction(() => {
  const deletedMedia = db.prepare("delete from media_files where profile_id = ? and ftp_server_id = ?").run(6, 342).changes;
  const deletedServer = db.prepare("delete from profile_ftp_servers where profile_id = ? and id = ? and name = ?").run(6, 342, "ISO Stream test").changes;
  return { deletedMedia, deletedServer };
})();
console.log(JSON.stringify(result));
NODE
```

## Challenger Reindex Incident

User asked why account `c69f07a0-b671-4beb-8135-bc17733bd970` had a server that did not auto-reindex.

Live Oracle investigation showed all six servers are shared-index masters:

- `Sputnik`, server `6`, group `1`
- `Tamarind`, server `10`, group `2`
- `Fenrir`, server `11`, group `3`
- `Challenger`, server `12`, group `4`
- `Columbia`, server `13`, group `5`
- `Adult Content`, server `14`, group `6`

Root cause:

- Challenger shared scan job `777` failed at `2026-05-20T20:50:43.202Z`.
- Error: `Server sent FIN packet unexpectedly, closing connection.`
- Normal profile-server scan failures used `failJob`, which schedules `pending_scan_after` for transient FTP disconnects.
- Shared-index scan failures used `failSharedJob`, which only marked the job failed and did not schedule `pending_scan_after`.

Fix:

- `src/server/scanner/scanQueue.ts` now passes profile/server ids into `failSharedJob`.
- `failSharedJob` now mirrors normal transient retry behavior and writes `pending_scan_after`.
- Test added in `tests/scanQueue.test.ts` for transient shared-index disconnect retry.

After deploying, Challenger’s missed retry was manually marked due on Oracle. Scheduler picked it up as job `779` and it completed:

```text
status: succeeded
trigger: scheduled
scan_mode: incremental
message: Indexed 670 media files. Enriched 419 titles; 5 unresolved.
finished_at: 2026-05-20T23:30:47.459Z
```

## Verification Performed

Recent focused local verification:

```text
npm test -- --run tests/scanQueue.test.ts tests/webApp.test.tsx
npm run build
```

Earlier focused verification included:

```text
npm test -- --run tests/sharedIndex.test.ts tests/adminRoutes.test.ts tests/webApp.test.tsx
npm test -- --run tests/sharedIndex.test.ts tests/webApp.test.tsx tests/config.test.ts tests/stremioRoutes.test.ts tests/ftpConnectionLimiter.test.ts tests/ftpProxyResolver.test.ts tests/proxyRoutes.test.ts
npm run build
```

Oracle deploy verification:

```text
curl -fsS https://ftpstrem.skynetsource.com/health
docker compose ps stremio-ftp
test ! -e /opt/stremio-ftp/stremio-ftp-settings-linked.json
grep -q "Shared scan failed:.*retryMessage" /opt/stremio-ftp/src/server/scanner/scanQueue.ts
grep -q "sharedGroupExistsForServer" /opt/stremio-ftp/src/web/components/AdminDashboard.tsx
```

## Deployment Notes

Admin deploys were done by local git bundle, copied to Oracle, cloned into `/tmp`, then `rsync`ed into `/opt/stremio-ftp` with excludes:

```text
--exclude=.git/
--exclude=.config-admin-dashboard/
--exclude=.config-visual/
--exclude=.env
```

Recent Oracle backup for latest deploy:

```text
/opt/stremio-ftp.pre-admin-shared-index-totals-20260522-225120-7ead040
```

Do not push admin branch to GitHub unless the user explicitly asks.

## Oracle Backup Setup

Configured directly on Oracle on 2026-05-22:

```text
stremio-ftp-daily-backup.timer
  Script: /usr/local/bin/stremio-ftp-daily-backup
  Schedule: daily at 03:20 MST, RandomizedDelaySec=10m
  Output: /config/backups/stremio-ftp-daily-YYYYMMDDTHHMMSSZ.sqlite.gz inside the stremio-ftp config volume
  Retention: delete daily Stremio FTP DB backups older than 7 days
  Verification sample: stremio-ftp-daily-20260523T060239Z.sqlite.gz, gzip OK, SQLite integrity_check=ok, 48 profiles, 291247 media_files, 7984 shared_media_files

oracle-services-backup.timer
  Script: /usr/local/bin/oracle-services-backup
  Schedule: every 3 days, RandomizedDelaySec=30m
  Output: /opt/service-backups/oracle-services-every3days-YYYYMMDDTHHMMSSZ.tar.gz
  Retention: keep latest 3 archives and matching .sha256 files
  Verification sample: oracle-services-every3days-20260523T061001Z.tar.gz, 35M, sha256 OK
```

The service backup includes:

- `/opt/usenet-stack` compose/env/configs, Prowlarr config, NZBDAV config/db, and usenetstreamer config
- `/opt/aiostreams/data`
- `/opt/aiometadata/data`
- `/opt/hanime-stremio`
- `/opt/strand` app env/source/db/uploads/private
- `/opt/feedbackr` source/config and `feedbackr_pb_data`
- `/opt/amnezia-awg` and `/opt/amnezia-config`

The service backup intentionally excludes Stremio FTP DB backups, `/mnt` media mounts, Docker images/layers, Redis cache, Watchtower state, NZBDAV `blobs`, Strand `poster-cache`, `.git`, `node_modules`, and common temp/cache/log folders.

S3 offload is enabled:

```text
Script: /usr/local/bin/oracle-backups-s3-sync
Service/timer: oracle-backups-s3-sync.service / oracle-backups-s3-sync.timer
Config template: /etc/oracle-backup-s3.env.example
Live config: /etc/oracle-backup-s3.env, mode 0600
Schedule: daily at 04:30 MST, RandomizedDelaySec=20m
Target: s3://oracle-server/oracle-backups/
AWS_REGION=us-west-1
S3_ENDPOINT=s3.us-west-1.amazonaws.com
S3_SSE=AES256
S3_STORAGE_CLASS=INTELLIGENT_TIERING
```

The bucket `oracle-server` was created by the backup sync script in `us-west-1`. `s3.amazonaws.com` was tried first but returned HTTP 400 for the signed bucket HEAD request; the regional endpoint `s3.us-west-1.amazonaws.com` succeeded.

First uploaded objects:

```text
s3://oracle-server/oracle-backups/stremio-ftp/stremio-ftp-daily-20260523T060239Z.sqlite.gz
s3://oracle-server/oracle-backups/services/oracle-services-every3days-20260523T061001Z.tar.gz
s3://oracle-server/oracle-backups/services/oracle-services-every3days-20260523T061001Z.tar.gz.sha256
```

Backup Telegram notifications are enabled:

```text
Script: /usr/local/bin/oracle-backup-notify
Telegram source env: /etc/bandwidth-watch.env
Failure template: oracle-backup-failure-notify@.service
Monthly timer: oracle-backup-monthly-summary.timer
```

Failure hooks are attached to:

```text
stremio-ftp-daily-backup.service -> OnFailure=oracle-backup-failure-notify@stremio-ftp-daily-backup.service
oracle-services-backup.service -> OnFailure=oracle-backup-failure-notify@oracle-services-backup.service
oracle-backups-s3-sync.service -> OnFailure=oracle-backup-failure-notify@oracle-backups-s3-sync.service
```

Failure alerts start with `🚨`. Monthly summaries run once per month with `RandomizedDelaySec=1h` and use compact Telegram HTML tables for retained backup counts/sizes/latest files, monthly creation/upload/delete counts observed from journals, S3 object counts, timer states, and disk usage. A Telegram test alert plus manual monthly summaries were sent successfully on 2026-05-22.

Backup status is also appended to the login MOTD:

```text
Rendered by: /etc/update-motd.d/10-stats, immediately after Network sessions
Command: /usr/bin/timeout 2s /usr/local/bin/oracle-backup-notify --motd
Cache: /var/cache/oracle-backups/status.motd
Support hook: /etc/update-motd.d/99-backup-status, left non-executable to avoid duplicate output
```

The MOTD command reads only the cached text file and does not query S3 on login. The cache refresh is attached as a non-fatal `ExecStartPost=-/usr/local/bin/oracle-backup-notify --write-motd-cache` on `stremio-ftp-daily-backup.service`, `oracle-services-backup.service`, and `oracle-backups-s3-sync.service`. The MOTD block shows retained local backup counts/sizes/latest filenames, cached S3 object counts, and next-run status for the DB, service, S3, and monthly timers with green/orange/red status dots. Styled bandwidth usage renders after the backup status with a colored threshold dot and progress bar; `/etc/update-motd.d/15-bandwidth-watch` is non-executable and is called by `10-stats` so Tips stays last. Verified with `sudo run-parts /etc/update-motd.d`; root-rendered output showed Network sessions, Backup status, Outbound bandwidth, then Tips.

Backup archives contain secrets and should be handled as sensitive artifacts.
