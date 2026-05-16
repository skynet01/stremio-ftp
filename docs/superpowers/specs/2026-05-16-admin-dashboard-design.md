# Admin Dashboard Design

## Problem

Production support currently requires direct database or server inspection to answer basic account questions: which recovery UIDs exist, whether their indexes are populated, how many FTP servers are configured, and what manifest URL can be tested. Admin-enabled profiles already exist through `ADMIN_BROWSER_UIDS`, but the web UI does not expose an admin-only view.

## Goals

- Show an admin dashboard only after an admin-enabled browser UID has unlocked its profile.
- Let admins inspect all profiles without exposing FTP passwords or passphrases.
- Show each profile's recovery UID, creation/update/unlock timestamps, FTP server counts, configured server counts, indexed media totals, latest scan timestamp, current scan state, and a manifest URL for debugging.
- Let admins issue a fresh manifest URL for any profile, because existing install tokens are stored as hashes and cannot be recovered.
- Let admins delete a profile after confirmation.
- Keep v1 "edit" support debug-only: admins can inspect profile metadata and issue debug manifest URLs, but cannot edit another profile's FTP settings or credentials.

## Non-Goals

- No plaintext FTP credential viewing.
- No passphrase reset or impersonated profile unlock.
- No editing another account's FTP settings, addon customization, stream format, scan schedule, or server list in v1.
- No background FTP stream failure log viewer. Direct FTP playback happens in the Stremio client after the manifest stream URL is returned, so the server cannot observe direct FTP connection failures.
- No new admin role model beyond `ADMIN_BROWSER_UIDS`.

## Architecture

Add a small admin API beside the existing profile API. All admin routes require the existing setup token middleware and then verify that the submitted `{ browserUid, passphrase }` unlocks a profile whose browser UID is listed in `config.adminBrowserUids`.

The admin API will live in a new `src/server/admin/adminRoutes.ts` module so `profileRoutes.ts` stays focused on self-service profile behavior. `ProfileService` will get one read-focused admin summary method and will reuse existing `unlockProfile`, `issueInstallToken`, and `deleteProfile` methods for authorization and actions.

The web app will add an `AdminDashboard` component rendered inside the existing setup UI only when `profileReady && isAdmin` is true. It will use the same panel, badge, table, notice, and button styles as the current setup portal.

## Backend API

### `POST /api/admin/profiles`

Request:

```json
{
  "browserUid": "admin-recovery-uid",
  "passphrase": "admin-passphrase"
}
```

Response:

```json
{
  "summary": {
    "profiles": 12,
    "configuredProfiles": 8,
    "ftpServers": 18,
    "configuredFtpServers": 14,
    "indexedItems": 4302,
    "activeScans": 1,
    "pendingScans": 2
  },
  "profiles": [
    {
      "id": 7,
      "browserUid": "bf1f80d7-4971-4919-8f4e-ab80aa2de852",
      "createdAt": "2026-05-16T06:00:00.000Z",
      "updatedAt": "2026-05-16T06:05:00.000Z",
      "lastUnlockedAt": null,
      "ftpServers": 2,
      "configuredFtpServers": 1,
      "indexedItems": 328,
      "lastScanAt": "2026-05-16T06:08:00.000Z",
      "activeScans": 0,
      "pendingScans": 1,
      "manifestUrl": null,
      "stremioInstallUrl": null
    }
  ]
}
```

`manifestUrl` and `stremioInstallUrl` are initially null because current install tokens are hashed. The dashboard will show an "Issue manifest URL" action for each profile.

### `POST /api/admin/profiles/:profileId/manifest-token`

Request body is the same admin auth object. Response:

```json
{
  "profileId": 7,
  "manifestUrl": "https://ftpstrem.skynetsource.com/u/<new-token>/manifest.json",
  "stremioInstallUrl": "stremio://ftpstrem.skynetsource.com/u/<new-token>/manifest.json"
}
```

This creates an additional valid install token with `ProfileService.issueInstallToken(profileId)` and does not invalidate existing user manifest URLs.

### `POST /api/admin/profiles/:profileId/delete`

Request body is the same admin auth object. Response:

```json
{ "ok": true }
```

The route deletes the target profile using `ProfileService.deleteProfile(profileId)`. If the profile does not exist it returns `404`. The UI refreshes the admin list after a successful delete.

## Data Model

No migration is required. The admin summary query reads:

- `profiles.id`, `profiles.browser_uid`, `profiles.created_at`, `profiles.updated_at`, `profiles.last_unlocked_at`
- `profile_ftp_servers` count, configured count, indexed count, latest indexed timestamp, pending scan count
- in-memory `ScanQueue` status for active and queued scan counts

Configured FTP servers are rows with `encrypted_ftp_config is not null`.

## UI

The dashboard renders after the admin profile is unlocked. It appears below the existing global status/server management area so normal admin profile setup remains usable.

The dashboard contains:

- Summary strip with total profiles, configured profiles, FTP servers, indexed items, active scans, and pending scans.
- Profile table with recovery UID, timestamps, server/index counts, scan state, and manifest debugging actions.
- Per-row actions: issue/copy manifest URL and delete profile.
- A refresh button that reloads the admin list.

Empty, loading, and error states use existing `Notice` and `StatusBadge` styling. Delete uses `window.confirm` with a clear destructive warning.

## Error Handling

- Non-admin browser UID with valid passphrase receives `403`.
- Invalid admin passphrase receives `401`.
- Invalid payload or route profile ID receives `400`.
- Missing target profile receives `404`.
- UI errors stay inside the dashboard panel and do not log out or alter the admin's own profile setup state.

## Testing

Automated tests will cover:

- Admin route rejects missing setup token.
- Admin route rejects a non-admin profile even with a valid passphrase.
- Admin route rejects an invalid admin passphrase.
- Admin profile list returns summary totals and per-profile server/index fields.
- Manifest-token route issues a fresh usable manifest URL for a target profile.
- Delete route removes the target profile and subsequent list calls omit it.
- React UI hides the dashboard for non-admin profiles.
- React UI shows the dashboard for admin profiles and can refresh/list profiles.

Manual browser check after implementation:

- Unlock a non-admin profile and verify no admin dashboard appears.
- Unlock an admin profile and verify the dashboard matches the existing setup portal look and feel.
- Issue a manifest URL for a target profile and load it.
- Delete a disposable profile and verify it disappears from the dashboard.

## Risks

- The dashboard exposes recovery UIDs. That is intentional for admin debugging, but the route must remain guarded by setup token plus admin profile passphrase.
- Issued manifest URLs remain valid. The UI should make clear that issuing a URL creates an additional debug URL, not a temporary preview.
- Large profile lists may eventually need pagination. v1 can load all profiles because current account volume is small; pagination can be added later without changing the route security model.
