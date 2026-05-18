# Admin And Formatter Polish Design

## Goals

- Add a stream formatter token for detected 3D layout type, usable as `{stream.3dtype}` and `{stream.threeDType}`.
- Show linked profile state in the admin list as `Auto-L`, `Linked`, or `Partial` when shared-index linkage is more useful than the generic scan state.
- Let admins inspect each profile's servers in a modal with last index time, linked status, and link/unlink actions.
- Require confirmation before rotating shared index keys.
- Allow disabled shared index groups to be deleted after confirmation.
- Remove the admin manifest column; the existing link action issues and copies a manifest URL.
- Give shared index group sections the same green grid treatment as Library settings.

## 3D Type Detection

Detection is derived from filenames and path text, matching the indexed library's observed tokens. Specific tokens win over generic tokens:

- `FSBS`, `Full SBS`, `Full-SBS`, `Full_SBS`, `fullsbs`, `Full Side-by-Side` -> `Full SBS`
- `HSBS`, `Half SBS`, `Half-SBS`, `Half_SBS`, `halfsbs`, `Half Side-by-Side` -> `Half SBS`
- `VR SBS` -> `VR SBS`
- `SBS` -> `SBS`
- `FOU`, `Full OU` -> `Full OU`
- `HOU`, `Half OU`, `halfou` -> `Half OU`
- `OU`, `TAB`, `Top Bottom`, `Top and Bottom`, `Over Under` -> `OU`
- `MVC` -> `MVC`
- bare `3D` -> `3D`
- `180`, `VR180`, `180VR` -> `180`
- `360`, `VR360`, `360VR` -> `360`

When projection and layout are both present, the formatter combines them, for example `180 Full SBS` or `360 Half OU`.

The formatter preview uses a 3D filename so `3D - {stream.3dtype} - {stream.quality}` previews as `3D - Full SBS - 2160p`.

## Admin State Rules

For configured FTP servers only:

- `Auto-L`: every configured server is linked and every link came from an import key.
- `Linked`: every configured server is linked and none came from an import key.
- `Partial`: any mixed linked/unlinked state, or mixed auto/manual links.

If no configured servers have shared-index links, the current scan/configuration state remains: `Scanning`, `Pending`, `Indexed`, `Configured`, or `Empty`.

## Admin Server Modal

Clicking the Servers cell opens a modal for that profile. The modal lists server id/name, host, last index time, shared index status, and actions. Linked rows can be unlinked. Unlinked rows can select a shared index group and attempt a manual link. If linking fails because the server does not match the selected group, the modal shows the backend error.

## Shared Index Group Deletion

Delete is only available for disabled groups. The backend enforces that enabled groups cannot be deleted. Deleting removes the group and its cascaded shared index data through existing foreign keys.

## Testing

Cover formatter detection/rendering, admin shared-link metadata, disabled group deletion, admin list state labels, server modal controls, rotate confirmation, and manifest column removal.
