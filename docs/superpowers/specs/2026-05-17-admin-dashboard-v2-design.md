# Admin Dashboard V2 Design

## Problem

The admin dashboard can list profiles, issue debug manifest URLs, and delete profiles, but it still lacks three operator workflows:

- identify where a profile most recently connected from,
- quickly find a recovery UID in a large table,
- promote or demote a profile without editing environment variables and redeploying.

## Goals

- Show a country-of-origin column for each profile.
- Add a UID search box that filters admin dashboard rows by recovery UID, country code, and admin state.
- Add an icon toggle that promotes or demotes another profile to admin.
- Keep environment-configured admins valid even if their DB toggle is off.
- Persist promoted admins in SQLite so the setting survives restarts.

## Non-Goals

- No IP address display or storage.
- No GeoIP lookup service. Country comes from trusted proxy headers, primarily Cloudflare `cf-ipcountry`.
- No role hierarchy beyond boolean admin access.
- No bulk admin actions.

## Backend Design

Add two columns to `profiles`:

- `admin_enabled integer not null default 0`
- `last_country_code text`

The app updates `last_country_code` during profile create/unlock and admin authorization when a two-letter country code is present in `cf-ipcountry`; otherwise it keeps the previous value. `XX`, empty strings, and invalid values are stored as null only when creating a new profile without a known country.

Admin authorization succeeds when either:

- `browserUid` is in `config.adminBrowserUids`, or
- the matching profile has `admin_enabled = 1`.

Admin list rows add `adminEnabled`, `adminSource`, and `lastCountryCode`.

Add endpoint:

`POST /api/admin/profiles/:profileId/admin`

Request:

```json
{
  "browserUid": "admin-uid",
  "passphrase": "admin-passphrase",
  "adminEnabled": true
}
```

Response:

```json
{
  "profileId": 7,
  "adminEnabled": true,
  "adminSource": "database"
}
```

The route refuses to demote the currently authenticated admin if that admin is not also listed in `ADMIN_BROWSER_UIDS`.

## UI Design

The admin dashboard table gains:

- a search input above the table,
- a "Country" column,
- an admin shield toggle in each row.

Search filters in-memory rows after load. Matching is case-insensitive against recovery UID, country code, and the words `admin`, `env`, and `database` for admin rows.

The admin toggle uses an icon-only button with an accessible label:

- "Promote profile `<uid>` to admin"
- "Demote profile `<uid>` from admin"

Environment admins show as admin but cannot be turned off by the DB toggle alone.

## Testing

Automated tests cover:

- migrations add the new columns,
- `cf-ipcountry` is captured on create/unlock,
- DB-promoted profiles can call admin APIs,
- admin toggle endpoint promotes and demotes a target profile,
- self-demotion is blocked when it would remove the current admin's only admin path,
- API client posts the admin toggle body correctly,
- UI filters profiles by UID/country/admin state,
- UI calls the admin toggle endpoint and updates the row.

## Risks

- Header-derived country is only as reliable as the reverse proxy. In production Cloudflare sets it; local dev may show `Unknown`.
- DB admin promotion increases sensitivity of the SQLite database. Admin API remains guarded by setup token plus a valid admin profile passphrase.
