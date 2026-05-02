# stremio-ftp

Stremio FTP is a self-hosted Stremio addon for streaming media from an FTP or FTPS server through per-user Stremio manifest URLs. The implementation includes encrypted profile creation, FTP credential storage, connection testing, on-demand index refreshes, manifest and stream lookup routes, range-capable HTTP proxy streaming, and a configuration portal.

Current limitation: scans are triggered manually from the portal. Background refresh scheduling, token rotation, pause controls, and profile deletion are not implemented yet.

## Legal Content And Access

Use this addon only with media you own, are licensed to access, or are otherwise legally allowed to stream. The addon does not provide media, bypass access controls, or grant rights to content on an FTP server. You are responsible for the FTP credentials, files, network exposure, and Stremio clients you configure.

## Local Development

Install dependencies and run the server in development mode:

```bash
npm install
BASE_URL=http://127.0.0.1:7000 CONFIG_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef CONFIG_DIR=.config PORT=7000 npm run dev
```

Run tests and build the production output:

```bash
npm test
npm run build
```

Start the built server locally:

```bash
BASE_URL=http://127.0.0.1:7000 CONFIG_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef CONFIG_DIR=.config PORT=7000 npm start
```

The health endpoint should respond at `http://127.0.0.1:7000/health`.

## Docker Compose Startup

Build and run the addon with Docker Compose:

```bash
BASE_URL=https://stremio-ftp.example.com
CONFIG_ENCRYPTION_KEY="$(openssl rand -hex 32)"
SETUP_TOKEN="$(openssl rand -hex 24)"
export BASE_URL CONFIG_ENCRYPTION_KEY SETUP_TOKEN
docker compose up --build
```

The compose file stores persistent configuration and the SQLite database in the named Docker volume `stremio-ftp-config`. Set `BASE_URL` to the HTTPS origin that Stremio clients can reach, and use stable random `CONFIG_ENCRYPTION_KEY` and `SETUP_TOKEN` values before creating profiles. Changing the encryption key later prevents existing encrypted profile secrets from being decrypted.

## HTTPS Reverse Proxy

Local browser testing can use `http://127.0.0.1:7000`, but remote Stremio clients need a publicly reachable HTTPS URL. Put the addon behind a reverse proxy such as Caddy, Nginx, Traefik, or a tunnel that terminates TLS and forwards requests to port `7000`.

Set `BASE_URL` to the external HTTPS origin, for example:

```bash
BASE_URL=https://stremio-ftp.example.com
```

The manifest and stream URLs are generated from `BASE_URL`, so it must match the address Stremio can reach.

## Configuration Portal Workflow

1. Open the configuration portal at `/configure?setup=your-setup-token` on your addon host.
2. Create a profile with the browser-generated recovery UID and a passphrase.
3. Save and test FTP settings, then refresh the index.
4. Copy the generated manifest URL or use the Stremio install link.
5. Keep the recovery UID and passphrase. Unlocking an existing profile does not reveal a previously generated install token.

FTP credentials are encrypted at rest. The manifest token can stream files indexed for that profile, so keep generated install URLs private.

## Manifest URL

Generated manifest URLs include a per-profile token:

```text
https://stremio-ftp.example.com/u/profile-install-token/manifest.json
```

Keep profile URLs private. Stream URLs proxy matching FTP files through the addon and support HTTP range requests for Stremio playback.

## Environment Variables

```bash
BASE_URL=https://stremio-ftp.example.com
CONFIG_ENCRYPTION_KEY=replace-with-at-least-32-random-characters
SETUP_TOKEN=replace-with-at-least-16-random-characters
CONFIG_DIR=/config
PORT=7000
LOG_LEVEL=info
CRAWLER_CONCURRENCY=2
FTP_TIMEOUT_MS=15000
MAX_ON_DEMAND_SEARCH_MS=4500
PROFILE_RATE_LIMIT_WINDOW_MS=600000
PROFILE_RATE_LIMIT_MAX=20
```

`BASE_URL`, `CONFIG_ENCRYPTION_KEY`, and `SETUP_TOKEN` are required. `CONFIG_DIR` defaults to `/config`, and the SQLite database is stored as `stremio-ftp.sqlite` inside that directory. Profile configuration endpoints and `/configure` require the setup token. Profile creation and unlock endpoints are rate-limited per client IP with `PROFILE_RATE_LIMIT_WINDOW_MS` and `PROFILE_RATE_LIMIT_MAX`.

## Troubleshooting

FTP TLS or certificate errors usually mean the server certificate is expired, self-signed, missing an intermediate certificate, or the configured FTP security mode does not match the server. Verify the server with a standard FTP client, confirm whether it expects plain FTP, explicit FTPS, or implicit FTPS, and check that the hostname in the profile matches the certificate when certificate verification is enabled.

An empty index usually means the crawler could not find supported media files, could not enter the configured root path, or filenames could not be matched to movie or series metadata. Check the configured FTP path, credentials, file permissions, and file extensions before refreshing the index again.

If Stremio installs the addon but streams fail remotely, check that `BASE_URL` uses the public HTTPS origin, the reverse proxy forwards to the addon, and `/health` is reachable from outside the host network.
