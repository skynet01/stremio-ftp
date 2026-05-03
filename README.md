# Stremio FTP

Stremio FTP is a self-hosted Stremio source addon that lets users stream movies and series episodes from their own FTP or FTPS server. It exposes a web configuration portal where a user saves FTP credentials, scans the FTP library, and receives a private Stremio manifest URL.

By default this is a stream-source addon: open a movie or episode from another Stremio catalog, and this addon appears as a streaming option when the clicked title is found in the indexed FTP library. Profiles can also enable optional FTP catalogs so indexed movies, series, anime, and unresolved files appear in Stremio with TMDB posters and metadata where possible.

## Features

- Web configuration portal at `/configure`, optionally protected by `/configure?setup=...`
- Per-user profiles using browser UID plus passphrase, with no signup system
- Encrypted FTP credential storage
- FTP, explicit FTPS, and implicit FTPS support through `basic-ftp`
- Optional invalid-certificate allowance for self-signed or seedbox FTP certificates
- Movies and series episode filename parsing
- Manual index refresh from the portal
- Optional movie, series, anime, and other catalogs generated from the indexed FTP library
- Optional TMDB metadata enrichment for catalog posters, descriptions, and artwork
- Per-profile TMDB API key override, content type toggles, and folder-layout hint
- Private per-profile manifest URLs for Stremio
- HTTP range proxy streaming from FTP to Stremio
- Docker and Docker Compose deployment
- SQLite persistence in `CONFIG_DIR`

## Important Caveats

- Use this only with media you own, are licensed to access, or are otherwise legally allowed to stream.
- Catalogs are off by default per profile. Enable `Show indexed FTP catalog in Stremio` in the portal if you want this addon to expose browsable FTP catalogs.
- The `Other` catalog is for indexed videos that cannot be resolved by TMDB under the enabled Movies, Series, or Anime options.
- TMDB enrichment requires `TMDB_API_KEY`. Without it, catalog items that already have IMDb IDs can still appear with basic title/year metadata but no TMDB poster art.
- After changing content type or layout options, run `Rescan` so files are re-parsed with the new profile settings.
- Scans are manual. Background scheduled rescans are not implemented yet.
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
TMDB_API_KEY=optional-tmdb-api-key-for-catalog-metadata
LOG_LEVEL=info
CRAWLER_CONCURRENCY=2
FTP_TIMEOUT_MS=15000
MAX_ON_DEMAND_SEARCH_MS=4500
PROFILE_RATE_LIMIT_WINDOW_MS=600000
PROFILE_RATE_LIMIT_MAX=20
```

Notes:

- `BASE_URL` must be the public origin, without a trailing slash.
- `CONFIG_ENCRYPTION_KEY` must stay stable across container rebuilds and restarts.
- `SETUP_TOKEN` protects `/configure` and profile-management APIs when set. If omitted, the portal and profile APIs are open to anyone who can reach the hosted addon.
- `STREMIO_FTP_SETUP_TOKEN` is accepted as an alternate name for `SETUP_TOKEN`.
- `TMDB_API_KEY` is optional. Set it as the server default if users will enable the FTP catalog option and you want posters, backdrops, descriptions, and release years from TMDB. Users can override it per profile in the portal.
- SQLite is stored at `$CONFIG_DIR/stremio-ftp.sqlite`.
- `PROFILE_RATE_LIMIT_MAX` limits profile actions per client IP per rate-limit window.

## Docker Compose

Create `.env`:

```bash
BASE_URL=https://stremio-ftp.example.com
CONFIG_ENCRYPTION_KEY=replace-with-output-from-openssl-rand-hex-32
SETUP_TOKEN=replace-with-output-from-openssl-rand-hex-24
TMDB_API_KEY=
PORT=7000
CONFIG_DIR=/config
LOG_LEVEL=info
CRAWLER_CONCURRENCY=2
FTP_TIMEOUT_MS=15000
MAX_ON_DEMAND_SEARCH_MS=4500
PROFILE_RATE_LIMIT_WINDOW_MS=600000
PROFILE_RATE_LIMIT_MAX=20
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

Open the portal. If `SETUP_TOKEN` is set:

```text
https://stremio-ftp.example.com/configure?setup=YOUR_SETUP_TOKEN
```

If `SETUP_TOKEN` is empty:

```text
https://stremio-ftp.example.com/configure
```

## Portal Workflow

1. Fill in FTP settings first: host, port, username, password, TLS mode, certificate setting, and root paths.
2. Enter a passphrase in Profile setup.
3. Click `Create profile`. If the FTP form is complete, the portal creates the profile and saves FTP settings in one action.
4. Click `Test connection`.
5. Click `Rescan`.
6. Optionally enable `Show indexed FTP catalog in Stremio`.
7. If catalogs are enabled, choose the content types on the server: Movies, Series, Anime, and set a TMDB key if you do not want to use the server default.
8. Choose the library layout hint: auto detect, organized by folders, or a single folder of files.
9. Click `Rescan` again after changing catalog parsing options.
10. Install the generated Stremio manifest URL.

For an existing browser profile:

1. Open `/configure?setup=YOUR_SETUP_TOKEN`, or `/configure` when no setup token is configured.
2. Enter the same browser UID and passphrase.
3. Click `Unlock profile`.
4. Saved FTP settings load into the form. The saved password is not shown.
5. Leave the password field blank to keep the saved password when testing or saving.

The portal remembers the last browser UID, passphrase, and manifest URL in that browser's local storage so repeat visits load the profile automatically. Use this only on trusted devices.

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
   - SETUP_TOKEN=<optional; generate with: openssl rand -hex 24 if the portal should be private>
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
8. Print the setup portal URL. If SETUP_TOKEN is set, use:
   https://YOUR_DOMAIN_HERE/configure?setup=<SETUP_TOKEN>
   If SETUP_TOKEN is not set, use:
   https://YOUR_DOMAIN_HERE/configure
9. Do not rotate CONFIG_ENCRYPTION_KEY after profiles are created.
10. Do not expose SETUP_TOKEN publicly when it is configured.

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
