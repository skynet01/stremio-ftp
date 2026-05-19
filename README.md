# Stremio FTP

Stremio FTP is a self-hosted Stremio source addon that lets users stream movies and series episodes from one or more FTP/FTPS servers through a single private Stremio manifest. It exposes a web configuration portal where a user saves FTP credentials, scans each FTP library, and receives a private Stremio manifest URL.

By default this is a stream-source addon: open a movie or episode from another Stremio catalog, and this addon appears as a streaming option when the clicked title is found in the indexed FTP library. Profiles can also enable optional FTP catalogs so indexed movies, series, anime, and folder-grouped Other files appear in Stremio with TMDB posters and metadata where possible. All FTP catalogs support Stremio search; the Other catalog searches folder groups without calling TMDB at catalog-load time.

![Stremio FTP configuration portal](https://raw.githubusercontent.com/skynet01/stremio-ftp/main/screenshot-1.jpg)

## Features

- Web configuration portal at `/configure`, with setup-token entry for private deployments
- Per-user profiles using browser UID plus passphrase, with no signup system
- Multiple FTP servers per manifest, each with its own FTP, library, catalog, scan, and stream settings
- Sequential per-manifest scans so one user profile does not open scan connections to several FTP servers at once
- Encrypted FTP credential storage
- FTP, explicit FTPS, and implicit FTPS support through `basic-ftp`
- Optional invalid-certificate allowance for self-signed or seedbox FTP certificates
- Movies and series episode filename parsing
- Manual, scheduled, and delayed auto-start background index refreshes from the portal
- Halt control for active scans
- Persisted scan progress with reload-safe status, progress bar, approximate ETA, and improved repeated-scan estimates from prior successful scans
- Automatic delayed retry for transient FTP disconnects such as FIN/reset/timeout errors
- Optional movie, series, anime, and folder-grouped Other catalogs generated from the indexed FTP library
- Stremio catalog search for Movies, Series, Anime, and Other
- Optional TMDB metadata enrichment for catalog posters, descriptions, and artwork
- Global TMDB API key, plus per-server content type toggles, folder-layout hint, and proxy/direct FTP stream delivery mode
- Private per-profile manifest URLs for Stremio
- HTTP range proxy streaming from FTP to Stremio
- JSON import/export of profile settings, including a credential-stripped sharing mode and automatic downgrades for server-side limits
- Docker and Docker Compose deployment
- SQLite persistence in `CONFIG_DIR`

## Important Caveats

- Use this only with media you own, are licensed to access, or are otherwise legally allowed to stream.
- Catalogs are off by default per profile. Enable `Show catalogs in Stremio` in the portal if you want this addon to expose browsable FTP catalogs.
- The `Other` catalog is folder-grouped. It includes indexed videos that cannot be resolved by TMDB under the enabled Movies, Series, or Anime options, plus catalog-enabled servers where Movies, Series, and Anime are all disabled. Disable `Show uncategorized` to exclude that server from Other.
- Typed catalog search uses already-persisted movie, series, and anime metadata. Other catalog search filters folder names, underlying filenames, parsed titles, and parsed years. Catalog loads and searches do not call TMDB live.
- TMDB enrichment requires `TMDB_API_KEY`. Without it, catalog items that already have IMDb IDs can still appear with basic title/year metadata but no TMDB poster art.
- After changing FTP or library settings, click `Save FTP settings`. The server schedules a delayed scan for that FTP server about 5 minutes later, unless you manually click `Rescan` first.
- Scans run in a background queue. New files do not appear as Stremio source options until the next manual or scheduled scan finishes.
- Scan progress and ETA are best-effort because FTP servers do not provide a full recursive item count before traversal. After a successful scan, later scans use the previous traversal size as a better progress baseline.
- If an FTP server closes the connection mid-scan, the failed job message notes the delayed retry and the server is requeued for a later rescan.
- Proxy streaming is the default and recommended mode. Direct FTP mode sends FTP URLs to Stremio clients; it may not work in every client, can expose FTP credentials in stream URLs, and explicit FTPS support varies by client. When supported, playback bypasses addon-server bandwidth and speed limits.
- The manifest install token is shown when a profile is created. The server stores only a hash of it, so unlocking an existing profile can load FTP settings but cannot reconstruct an old install URL.
- The generated manifest URL can stream indexed files for that profile. Keep it private.
- Changing `CONFIG_ENCRYPTION_KEY` after profiles exist will make saved FTP credentials undecryptable.
- If your FTP server has thousands of files, scanning `/` can take time. Prefer the narrowest root folders that contain your media.
- Filename matching is best-effort. Include clear title/year patterns for movies and `S01E02` style patterns for episodes when possible.

## Requirements

- Node.js 22+ for local development
- Docker for container deployment
- A publicly reachable HTTPS URL for Stremio clients
- Outbound network access from the addon server to your FTP host and port

For a typical VPS deployment, put the container behind Nginx, Caddy, Traefik, or Cloudflare Tunnel. Stremio clients must be able to reach `BASE_URL`.

## Environment Variables

Required:

```bash
BASE_URL=https://stremio-ftp.example.com
CONFIG_ENCRYPTION_KEY=replace-with-a-stable-random-secret-at-least-32-characters
```

Optional:

```bash
PORT=7000
CONFIG_DIR=/config
SETUP_TOKEN=replace-with-a-stable-random-secret-at-least-16-characters
STREMIO_FTP_SETUP_TOKEN=alternate-name-for-SETUP_TOKEN
ALLOW_PUBLIC_PROFILE_API=false
TMDB_API_KEY=optional-tmdb-api-key-for-catalog-metadata
LOG_LEVEL=info
CRAWLER_CONCURRENCY=2
FTP_TIMEOUT_MS=15000
FTP_MAX_CONNECTIONS=3
MAX_ON_DEMAND_SEARCH_MS=4500
PROFILE_RATE_LIMIT_WINDOW_MS=600000
PROFILE_RATE_LIMIT_MAX=20
SCAN_GLOBAL_CONCURRENCY=2
SCAN_QUEUE_MAX=50
SCAN_MIN_RESCAN_INTERVAL_MINUTES=0
SCAN_COOLDOWN_MS=900000
SCAN_JOB_TIMEOUT_MS=1800000
SCAN_SCHEDULER_INTERVAL_MS=60000
SCAN_PROGRESS_AVERAGE_ITEMS=2000
SCAN_TRANSIENT_RETRY_DELAY_MS=300000
MAX_FTP_SERVERS_PER_PROFILE=0
DISABLE_PROXY_STREAMS=false
ADMIN_BROWSER_UIDS=
EMPTY_PROFILE_CLEANUP_DAYS=7
EMPTY_PROFILE_CLEANUP_INTERVAL_MS=604800000
```

Notes:

- `BASE_URL` must be the public origin, without a trailing slash.
- `CONFIG_ENCRYPTION_KEY` must stay stable across container rebuilds and restarts.
- `SETUP_TOKEN` protects `/configure` and profile-management APIs. It is required unless `ALLOW_PUBLIC_PROFILE_API=true`.
- `STREMIO_FTP_SETUP_TOKEN` is accepted as an alternate name for `SETUP_TOKEN`.
- `ALLOW_PUBLIC_PROFILE_API=true` preserves the older no-token behavior for trusted or otherwise restricted deployments. If enabled, anyone who can reach the hosted addon can create profiles and submit FTP settings.
- `TMDB_API_KEY` is optional. Set it if users will enable the FTP catalog option and you want posters, backdrops, descriptions, and release years from TMDB. Users can override it per profile in the portal.
- SQLite is stored at `$CONFIG_DIR/stremio-ftp.sqlite`.
- `FTP_MAX_CONNECTIONS` limits simultaneous FTP sessions per distinct FTP credential key. Lower it for hosts with strict connection caps.
- `PROFILE_RATE_LIMIT_MAX` limits profile create/unlock attempts per client IP per rate-limit window.
- `SCAN_GLOBAL_CONCURRENCY` limits simultaneous FTP scans across the whole instance. Default `2` is sized for public instances where the average catalog is around 2,000 media files.
- `SCAN_QUEUE_MAX` limits queued scans waiting for workers. Default `50`.
- `SCAN_MIN_RESCAN_INTERVAL_MINUTES` sets the minimum automatic rescan frequency users may save. Default `0` allows every listed option.
- `SCAN_COOLDOWN_MS` prevents repeated manual rescans for the same profile. Default `900000` or 15 minutes. Scheduled scans are still locked per profile and respect global concurrency.
- `SCAN_JOB_TIMEOUT_MS` is reserved for scan timeout policy and defaults to `1800000` or 30 minutes.
- `SCAN_SCHEDULER_INTERVAL_MS` controls how often the server checks for due scheduled scans. Default `60000` or 1 minute.
- `SCAN_PROGRESS_AVERAGE_ITEMS` is the denominator used for the first-pass progress estimate until the crawler has seen more entries. Default `2000`.
- `SCAN_TRANSIENT_RETRY_DELAY_MS` controls delayed retries after transient FTP disconnects such as FIN/reset/timeout errors. Default `300000` or 5 minutes. Set `0` to disable these retries.
- `MAX_FTP_SERVERS_PER_PROFILE` caps how many FTP servers each profile may keep. Default `0` removes the cap. Imported settings beyond the cap are dropped automatically.
- `DISABLE_PROXY_STREAMS=true` forces every profile to deliver streams as direct FTP URLs. Saved customizations and imported settings are coerced to `direct`. Set per profile cannot opt back in.
- `ADMIN_BROWSER_UIDS` is a comma-separated allowlist of browser UIDs that bypass `MAX_FTP_SERVERS_PER_PROFILE` and `DISABLE_PROXY_STREAMS`. Useful for the operator's own profile.
- `EMPTY_PROFILE_CLEANUP_DAYS` deletes profiles older than this many days that have no FTP server configured. Default `7`. Set `0` to disable. Cleanup runs at startup and again every `EMPTY_PROFILE_CLEANUP_INTERVAL_MS` milliseconds (default `604800000`, one week).

## Docker Compose

Create `.env`:

```bash
BASE_URL=https://stremio-ftp.example.com
CONFIG_ENCRYPTION_KEY=replace-with-output-from-openssl-rand-hex-32
SETUP_TOKEN=replace-with-output-from-openssl-rand-hex-24
ALLOW_PUBLIC_PROFILE_API=false
TMDB_API_KEY=
PORT=7000
CONFIG_DIR=/config
LOG_LEVEL=info
CRAWLER_CONCURRENCY=2
FTP_TIMEOUT_MS=15000
FTP_MAX_CONNECTIONS=3
MAX_ON_DEMAND_SEARCH_MS=4500
PROFILE_RATE_LIMIT_WINDOW_MS=600000
PROFILE_RATE_LIMIT_MAX=20
SCAN_GLOBAL_CONCURRENCY=2
SCAN_QUEUE_MAX=50
SCAN_MIN_RESCAN_INTERVAL_MINUTES=0
SCAN_COOLDOWN_MS=900000
SCAN_JOB_TIMEOUT_MS=1800000
SCAN_SCHEDULER_INTERVAL_MS=60000
SCAN_PROGRESS_AVERAGE_ITEMS=2000
SCAN_TRANSIENT_RETRY_DELAY_MS=300000
```

Generate strong secrets:

```bash
openssl rand -hex 32
openssl rand -hex 24
```

Start the addon:

```bash
docker compose up -d --build
```

Check health:

```bash
curl https://stremio-ftp.example.com/health
```

Open the portal:

```text
https://stremio-ftp.example.com/configure
```

If `SETUP_TOKEN` is set, enter it in the portal unlock form. Older `?setup=...` links are still imported by the browser and immediately removed from the address bar, but new deployments should avoid putting setup tokens in URLs.

## Portal Workflow

1. Enter a passphrase in Profile setup. Optionally click `Import settings` to load a previously exported JSON file before creating the profile. When settings are staged for import, only `Create profile` is available; `Unlock profile` is disabled until the staged import is cleared.
2. Click `Create profile`. The portal creates the profile, applies any imported customization, and persists imported servers that already include credentials. Servers imported without credentials appear pre-filled so you can supply username and password, then click `Save FTP settings` per server.
3. Fill in FTP settings for `Server 1` (or any imported server still missing credentials): host, port, username, password, TLS mode, certificate setting, and root paths.
4. Click `Test connection`.
5. Click `Rescan`. The scan runs in the background; you can leave and come back to see the latest persisted status. If needed, click `Halt scan` while it is active.
6. Optionally enable `Show catalogs in Stremio`.
7. If catalogs are enabled, choose the content types on that server: Movies, Series, Anime, and `Show uncategorized`, and set a global TMDB key if you want TMDB posters and richer catalog metadata. If you leave Movies, Series, and Anime disabled while keeping catalogs enabled, that server is treated as an Other-only catalog source unless `Show uncategorized` is disabled.
8. Choose the library layout hint: auto detect, organized by folders, or a single folder of files.
9. Keep `Proxy through addon` stream delivery unless you specifically want Stremio clients to receive direct FTP URLs.
10. Click `Save FTP settings` after changing FTP or library options. A delayed auto-scan is scheduled about 5 minutes later so you can keep editing without immediately locking the form behind a scan.
11. Choose an optional rescan frequency: manual only, every 6 hours, every 12 hours, daily, or weekly.
12. Add more FTP servers if needed. They are scanned sequentially, and duplicate movie/episode matches appear as multiple stream options in Stremio.
13. Install the generated Stremio manifest URL.
14. The manifest panel includes `Export settings` to download the current profile (customization + servers) as a JSON file. Leave `Strip username & password` checked when sharing the file with someone else; uncheck it to keep a private backup that can restore credentials on a future import.

For an existing browser profile:

1. Open `/configure` and enter the setup token if prompted.
2. Enter the same browser UID and passphrase.
3. Click `Unlock profile`.
4. Saved FTP settings load into the form. The password field stays blank even when a saved password exists.
5. Leave the password field blank to keep the saved password when testing or saving.

The portal remembers the last browser UID, passphrase, and manifest URL in that browser's local storage so repeat visits load the profile automatically. Use this only on trusted devices.

## Stremio Catalog Search

The addon advertises Stremio's optional `search` extra on all four FTP catalogs:

- Movies, Series, and Anime search already-enriched catalog metadata stored during scanning.
- Other search preserves folder grouping and matches folder names, filenames inside each folder, parsed titles, and parsed years.
- Search never triggers live TMDB requests during Stremio catalog browsing. TMDB work happens during scan-time enrichment and resumes on later scans if transient errors interrupt it.
- Other entries without poster art use `/assets/default-folder-poster.png`, a transparent PNG folder-outline poster for Stremio clients that do not render SVG artwork.

## FTP Root Paths

Root paths can be newline- or comma-separated.

Examples:

```text
/Movies
/TV
```

or:

```text
/
```

Scanning `/` works, but for large servers it is slower and more likely to include unrelated files. Prefer specific media folders when possible.

## Local Development

Install dependencies:

```bash
npm install
```

Run development server:

```bash
BASE_URL=http://127.0.0.1:7000 \
CONFIG_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef \
SETUP_TOKEN=dev-setup-token-123456 \
TMDB_API_KEY= \
CONFIG_DIR=.config \
PORT=7000 \
npm run dev
```

Build and start production output:

```bash
npm run build
BASE_URL=http://127.0.0.1:7000 \
CONFIG_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef \
SETUP_TOKEN=dev-setup-token-123456 \
TMDB_API_KEY= \
CONFIG_DIR=.config \
PORT=7000 \
npm start
```

Run checks:

```bash
npm test
npm run build
npm audit --omit=dev
```

## Reverse Proxy Example

Nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name stremio-ftp.example.com;

    ssl_certificate /etc/letsencrypt/live/stremio-ftp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stremio-ftp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

If Docker publishes to loopback, use:

```yaml
ports:
  - "127.0.0.1:7000:7000"
```

## AI Agent Setup Prompt

Paste this into an AI coding or server agent after replacing the placeholders:

```text
Set up the Stremio FTP addon on this Linux server.

Repository: https://github.com/skynet01/stremio-ftp
Public URL: https://YOUR_DOMAIN_HERE
Internal port: 7000

Requirements:
1. Install Docker and Docker Compose if missing.
2. Clone or update the repository at /opt/stremio-ftp.
3. Create a persistent .env file with:
   - BASE_URL=https://YOUR_DOMAIN_HERE
   - CONFIG_ENCRYPTION_KEY=<generate with: openssl rand -hex 32>
   - SETUP_TOKEN=<generate with: openssl rand -hex 24>
   - ALLOW_PUBLIC_PROFILE_API=false
   - TMDB_API_KEY=<optional; required for TMDB catalog posters and rich metadata>
   - PORT=7000
   - CONFIG_DIR=/config
   - LOG_LEVEL=info
   - CRAWLER_CONCURRENCY=2
   - FTP_TIMEOUT_MS=15000
   - MAX_ON_DEMAND_SEARCH_MS=4500
   - PROFILE_RATE_LIMIT_WINDOW_MS=600000
   - PROFILE_RATE_LIMIT_MAX=20
4. Build and run with Docker Compose.
5. Put the app behind HTTPS using Nginx, Caddy, Traefik, or the existing reverse proxy.
6. Make sure the public URL forwards to the container and /health returns JSON.
7. Make sure outbound egress from the server allows FTP/FTPS to the user FTP host and port.
8. Print the setup portal URL:
   https://YOUR_DOMAIN_HERE/configure
   Tell the operator to enter SETUP_TOKEN in the portal unlock form.
9. Do not rotate CONFIG_ENCRYPTION_KEY after profiles are created.
10. Do not expose SETUP_TOKEN publicly. Only set ALLOW_PUBLIC_PROFILE_API=true for trusted or network-restricted deployments that intentionally need the older public profile API behavior.

After setup, verify:
- curl https://YOUR_DOMAIN_HERE/health
- The configure page loads.
- A profile can be created.
- FTP settings can be saved, tested, and rescanned.
```

## Troubleshooting

`Unable to connect to FTP server`

- Confirm host, port, username, and password in FileZilla or another FTP client.
- Confirm TLS mode: disabled, explicit TLS, or implicit TLS.
- Enable `Allow invalid certificate` only when the server uses a self-signed or otherwise invalid certificate.
- Confirm the VPS firewall and cloud egress rules allow outbound access to the FTP host and port.

`Rescan` returns `0` files

- Confirm the root path exists on the FTP server.
- Try `/` once to verify traversal, then narrow to `/Movies`, `/TV`, or similar.
- Confirm files have supported video extensions and parseable names.
- Prefer filenames containing movie year or episode markers such as `S01E02`.

Addon installs but no streams appear

- The clicked Stremio title must match an indexed FTP file.
- Run `Rescan` after saving FTP settings.
- Make sure `BASE_URL` is the public HTTPS URL.
- Keep the manifest URL private and reinstall if you created a new profile.

Saved settings load but password field is blank

- This is intentional. The portal never displays the stored FTP password.
- Leave the password field blank to keep the stored password.
- Enter a new password only when rotating FTP credentials.
