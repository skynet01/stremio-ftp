# Multi FTP Server Manifest Design

## Goal

A single profile and manifest URL can aggregate multiple FTP servers. Each server has independent FTP credentials, roots, library parsing settings, stream delivery mode, schedule, connection status, and scan status. Stremio catalogs dedupe titles across servers, while Stremio stream results show every matching copy from every server with clear server labels.

## Data Model

- Keep `profiles` as the manifest owner and install token owner.
- Add `profile_ftp_servers` for per-server configuration:
  - `profile_id`, display `name`, encrypted FTP config, addon/library settings, connection status, index count, scan interval, next scheduled scan, and `pending_scan_after`.
  - Existing profiles migrate to one default server using the current profile-level FTP/library fields.
  - New profiles are created with one default server.
  - The last server for a profile cannot be deleted.
- Add `ftp_server_id` to `media_files` and `scan_jobs`.
  - Media uniqueness becomes `(profile_id, ftp_server_id, ftp_path)`.
  - Scan jobs can be queried per server and aggregated per profile.

## Scanning

- Manual rescan starts immediately for one server.
- Saving FTP/library settings for a server sets `pending_scan_after = now + 5 minutes` for that server.
- The server-side scheduler queues due pending scans even if the browser tab is closed.
- Scans are sequential per profile/manifest. The scanner can still process other profiles according to global limits.
- Reloading portal status while scanning only reads DB status and must not open FTP connections.
- Halt cancels the active or queued scan for that server, closes the FTP client, and persists `cancelled`.

## Duplicate Handling

- Catalog and meta responses dedupe across servers by movie title/year/IMDb ID and by series title/episode identity.
- Stream responses return every matching media file across all configured servers.
- Stream labels include server name, quality, and size so users can choose among copies, for example two Matrix copies from server 1 and three from server 2.

## UI

- Keep the current visual language: dark panel surfaces, restrained controls, compact status lists, no nested cards.
- Replace separate FTP/library/index tiles with a line-separated accordion list.
- A top global status band shows total indexed items, movies, series, anime, server count, active scans, pending scans, last completed scan, and global index state.
- Each accordion item header shows server name, host, media count, scan state, next scan, and active/pending indicators.
- Expanding a server reveals FTP settings, library settings, index status, test/save/rescan/halt/delete actions.
- Add server creates a new server and opens its accordion item.
- Delete server is disabled for the only remaining server.

## API

- Preserve legacy endpoint compatibility where practical by mapping old single-server operations to the first/default server during migration.
- Add server-scoped endpoints for create, update, test, delete, scan, cancel, and status.
- Load endpoints should return all servers plus aggregate stats in one request to keep polling cheap.

## Versioning and Deployment

- Bump package version to `0.3.0`.
- Existing manifest URLs continue to work after migration.
- Deployment rebuilds only the `stremio-ftp` service and keeps the existing SQLite volume.

## Related Learnings

- [TVA-inspired configuration portal polish](../../solutions/design-patterns/tva-inspired-config-portal-polish-2026-05-06.md) documents the later portal refinements for line-separated server accordions, global status motion, accessible disclosure/menu behavior, non-white unchecked checkbox states, and TVA-style changelog scanability.
