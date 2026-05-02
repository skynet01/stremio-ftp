# Stremio FTP Addon Design

## Purpose

Build a self-hosted Stremio source addon that lets users stream movie and series episode files directly from their own FTP or FTPS server. Once installed in Stremio, the addon should appear as a streaming source when the selected Cinemeta movie or episode is available on the configured FTP server.

The addon is intended for user-controlled, legally accessible media libraries. It should not embed FTP credentials in Stremio manifest URLs, stream URLs, logs, or browser-visible API responses.

## Sources

- Stremio Addon SDK API docs: https://github.com/Stremio/stremio-addon-sdk/tree/master/docs/api
- Stremio Addon SDK README: https://github.com/Stremio/stremio-addon-sdk
- Stremio advanced user data and configuration docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md
- nzbdav reference project for self-hosted Docker UI/persisted settings pattern: https://github.com/nzbdav-dev/nzbdav

## Architecture

The addon will be a single Dockerized TypeScript service. Express will serve the web portal, portal APIs, Stremio addon endpoints, health endpoints, and HTTP streaming proxy routes. The official `stremio-addon-sdk` will define a stream-only addon with:

```json
{
  "resources": ["stream"],
  "types": ["movie", "series"],
  "idPrefixes": ["tt"],
  "catalogs": []
}
```

This makes the addon relevant to IMDb/Cinemeta movie IDs such as `tt0111161` and series episode video IDs such as `tt0944947:2:5`.

SQLite under `/config` will store browser profiles, encrypted FTP settings, install tokens, parsed media index rows, crawler status, cached Cinemeta metadata, and short-lived negative lookup cache. Credentials will be encrypted server-side using an application secret from `CONFIG_ENCRYPTION_KEY`. The browser-generated UID and user passphrase identify the config session, but FTP credentials are never placed in manifest URLs.

FTP access must support:

- Plain FTP.
- Explicit TLS.
- Custom ports.
- Configurable certificate validation, including an insecure option for sample or self-signed servers.
- One or more configured root paths to scan.

Streaming will be proxied through addon-owned HTTP URLs, for example:

```text
https://addon.example.com/proxy/<installToken>/<fileId>
```

The proxy authenticates the install token, resolves the file ID to an indexed FTP path, opens the remote file, and pipes the requested byte range back to Stremio. It must support HTTP `Range` requests so playback can seek without downloading whole files.

## Config Portal

The root page and `/configure` page will serve a no-signup configuration portal. On first load, the browser creates a random UID and stores it in `localStorage`. The user enters a passphrase and FTP settings:

- Host.
- Port.
- Username.
- Password.
- TLS mode.
- Certificate validation toggle.
- One or more FTP root paths to scan.
- Optional index refresh settings.

The server stores an encrypted profile keyed by the UID and a password-derived verifier. The same browser can reopen the profile automatically using the stored UID, then the passphrase unlocks edit access. If the user changes browsers, they need the recovery UID and passphrase. The portal should show a recovery UID copy field after setup.

After setup, the portal returns a private Stremio install URL:

```text
https://addon.example.com/u/<installToken>/manifest.json
```

The install button should use the Stremio deep link form:

```text
stremio://addon.example.com/u/<installToken>/manifest.json
```

The token identifies the profile to addon endpoints, but it does not decrypt credentials by itself in browser APIs. Management operations require the UID and passphrase-backed session.

Portal capabilities:

- Create or unlock a profile.
- Test FTP connection.
- Save FTP settings.
- Display generated manifest URL.
- Copy recovery UID.
- Show crawler state, indexed movie count, indexed episode count, last scan time, and last error.
- Start rescan.
- Pause or resume crawler.
- Rotate install URL.
- Delete profile and all related index rows.

## Web UI Design

The web UI should be clean, modern, and operational rather than a marketing page. The first screen should be the usable configuration experience, not a landing page. It should feel like a focused self-hosted admin tool.

Layout:

- Use a constrained app shell with a compact header, primary setup panel, and status side panel on desktop.
- Collapse to a single-column flow on mobile.
- Avoid nested cards and decorative backgrounds.
- Use cards only for repeated status items or clear tool panels.
- Use compact headings and predictable form grouping.

Controls:

- Use clear form controls for FTP settings.
- Use toggles for TLS and certificate validation options.
- Use icon buttons with tooltips for copy, rotate token, refresh, pause, resume, and delete actions.
- Use text buttons only for clear commands such as "Test connection", "Save", and "Install in Stremio".
- Use status badges for connection, crawler, and indexing state.

States:

- First-run profile creation.
- Locked existing profile.
- Unlocked settings editor.
- FTP connection testing.
- Saved profile with install URL.
- Crawling/indexing in progress.
- Crawl complete.
- Connection or credential error.
- Empty index warning.

The UI must avoid exposing passwords after save. Password fields should support replace-only updates. Copyable values should be limited to recovery UID, manifest URL, and Stremio install link.

## Indexing And Matching

The service will use a hybrid index.

The background crawler starts after successful configuration and walks configured FTP roots incrementally. As it discovers media files, it stores rows in SQLite with:

- Profile ID.
- FTP path.
- Filename.
- Normalized filename.
- File extension.
- File size when available.
- Modified time when available.
- Parsed media kind.
- Parsed title.
- Parsed year.
- Parsed season.
- Parsed episode.
- Quality guess.
- Parse confidence.
- Last seen time.

Supported media extensions for v1 should include `mkv`, `mp4`, `avi`, `mov`, `m4v`, `ts`, and `webm`.

Episode parsing is a v1 priority. The parser should support common forms:

```text
Show.Name.S02E05.1080p.mkv
Show Name - 2x05 - Episode Title.mp4
/Show Name/Season 02/Show.Name.S02E05.mkv
```

Movie matching should support:

- IMDb ID in filename or path.
- Parsed title and year, when Stremio/Cinemeta metadata can be fetched and cached.

For stream requests:

- Movie IDs arrive as `tt0111161`.
- Series episode IDs arrive as `tt0944947:2:5`.
- The handler uses Cinemeta metadata to resolve title/year for movies and show title for series.
- The handler queries indexed rows for normalized title, year, season, and episode.
- The handler returns one or more HTTP proxy streams ordered by likely quality and file size.

If the local index misses and the profile crawl is incomplete or stale, the service runs a bounded on-demand FTP search. On-demand search should stop after `MAX_ON_DEMAND_SEARCH_MS`, store any discovered matches, and cache misses briefly so repeated Stremio requests do not hammer the FTP server.

## Stremio Behavior

The addon manifest is generated per install token at:

```text
/u/:installToken/manifest.json
```

It advertises only the stream resource and should not expose a catalog. The public `/manifest.json` endpoint, if implemented for direct visits, should set `behaviorHints.configurable: true` and `behaviorHints.configurationRequired: true` so users are sent to `/configure`. Per-token manifests at `/u/:installToken/manifest.json` should set `behaviorHints.configurable: true` and `behaviorHints.configurationRequired: false` because the token already identifies a configured profile. The addon should return empty stream arrays for invalid tokens, unauthorized profiles, unmatched items, stale credentials, and FTP timeouts.

The stream handler returns stream objects with HTTP URLs pointing to the proxy:

```json
{
  "name": "FTP 1080p",
  "description": "Show.Name.S02E05.1080p.mkv\n2.1 GB",
  "url": "https://addon.example.com/proxy/<installToken>/<fileId>",
  "behaviorHints": {
    "notWebReady": true,
    "filename": "Show.Name.S02E05.1080p.mkv",
    "videoSize": 2254857830
  }
}
```

`filename` and `videoSize` should be provided when known to improve subtitle addon compatibility. `notWebReady` should be used because the proxy may serve non-MP4 files and FTP-derived streams.

## HTTP Proxy

The proxy route must:

- Validate install token.
- Validate that the file belongs to the token's profile.
- Support `HEAD`.
- Support full `GET`.
- Support single-byte `Range` requests.
- Return `206 Partial Content` for valid ranges.
- Return `416 Range Not Satisfiable` for invalid ranges when file size is known.
- Set `Accept-Ranges: bytes`.
- Set a content type from file extension.
- Avoid logging credentials or complete FTP URLs.
- Close FTP streams when the client disconnects.

The proxy should not cache full media files on disk in v1. Optional small metadata caching is acceptable.

## Data Model

SQLite tables:

- `profiles`: browser UID, password verifier, encrypted FTP config, profile timestamps, install token hash, management session metadata.
- `media_files`: parsed FTP media rows, scoped by profile.
- `crawl_state`: current crawler status per profile and root path.
- `metadata_cache`: Cinemeta metadata by type and IMDb ID.
- `negative_cache`: short-lived misses by profile, type, and Stremio ID.

Secrets:

- FTP passwords are encrypted at rest.
- Install tokens are stored hashed.
- Passphrases are not stored. Only password-derived verifiers are stored.
- Logs must redact host credentials, tokens, passwords, and passphrases.

## Docker And Deployment

The service will run as one Docker container.

Defaults:

- HTTP port: `7000`.
- Persistent config path: `/config`.
- SQLite path: `/config/stremio-ftp.sqlite`.

Required environment variables:

- `BASE_URL`: public HTTPS base URL used for manifest and proxy URLs.
- `CONFIG_ENCRYPTION_KEY`: encryption key for profile secrets.

Optional environment variables:

- `PORT`.
- `LOG_LEVEL`.
- `CRAWLER_CONCURRENCY`.
- `FTP_TIMEOUT_MS`.
- `INDEX_REFRESH_INTERVAL_MS`.
- `MAX_ON_DEMAND_SEARCH_MS`.
- `NEGATIVE_CACHE_TTL_MS`.
- `PROXY_IDLE_TIMEOUT_MS`.

The project README should include Docker Compose examples and reverse proxy notes. Stremio remote addons require HTTPS except for localhost testing, so production examples should assume an HTTPS reverse proxy.

## Error Handling

Portal errors should be explicit and actionable:

- Invalid passphrase.
- FTP connection failed.
- TLS/certificate failure.
- Root path not found.
- Crawler paused.
- Crawler failed with last error.
- No media files indexed.

Stremio-facing errors should be quiet:

- Invalid token returns `{ "streams": [] }`.
- No match returns `{ "streams": [] }`.
- FTP unavailable returns `{ "streams": [] }` and logs a redacted warning.
- Proxy file-not-found returns `404`.
- Proxy auth failure returns `404` or `403`.
- Proxy FTP failure returns `502`.

## Testing

Automated tests should cover:

- Filename normalization and parsing.
- Episode patterns including `S02E05`, `2x05`, and season-folder layouts.
- Movie title/year parsing.
- Profile creation, passphrase verification, and credential encryption.
- Install token generation, hashing, lookup, and rotation.
- Manifest generation for valid and invalid tokens.
- Stream handler matching for movie and series IDs.
- Negative cache behavior.
- HTTP range proxy behavior.
- Crawler/index integration using a mocked FTP server or FTP client abstraction.

Manual verification should include:

- Docker Compose startup with persistent `/config`.
- Portal first-run setup.
- FTP connection test against a temporary sample server.
- Background crawl status updates.
- Stremio install link generation.
- Stremio source result for a known movie.
- Stremio source result for a known episode.
- Seeking during playback through the HTTP proxy.

## Out Of Scope For V1

- Public catalog browsing inside Stremio.
- Multi-user sign-up accounts.
- Cloud-hosted account service.
- Transcoding.
- Full-file media cache.
- Subtitle downloading.
- Archive extraction.
- Radarr/Sonarr integration.
- WebDAV support.
