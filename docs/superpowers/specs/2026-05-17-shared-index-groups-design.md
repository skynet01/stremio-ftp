# Shared Index Groups Design

## Goal

Let many profiles use separate FTP credentials for the same library without forcing each profile to reindex that library. Linked profile servers reuse a shared file index, while playback still uses the requesting profile's own FTP login.

## Core Model

Add admin-approved shared index groups. A group represents one visible FTP library, not one login. Profile FTP servers can link to a group through an optional high-entropy `sharedIndexKey` supplied by the common import file or assigned by an admin.

The shared group stores library identity and scan state:

- Stable key and display name.
- FTP host, port, TLS mode, invalid-certificate flag, root paths, and library layout.
- Enabled and auto-link flags.
- Master profile server used for scanning, stored only as a foreign key to `profile_ftp_servers`.
- Last indexed time and media count.

Profile servers keep their encrypted FTP config. Linking a server to a shared group does not copy or expose credentials.

Raw shared keys are treated as linking tokens. The database stores only a hash, the raw key is shown only at creation/rotation time, and normal user exports omit shared keys by default.

## Import Auto-Linking

Portable settings become schema version 2 while schema version 1 remains accepted. A server entry can include:

```json
{
  "name": "Sputnik Main",
  "host": "sputnik.whatbox.ca",
  "port": 21,
  "rootPaths": ["/media"],
  "sharedIndexKey": "sputnik-main"
}
```

When a user imports and saves a server, the backend checks whether `sharedIndexKey` hashes to an enabled shared group with auto-link enabled. The server must also match the group's host, port, TLS mode, invalid-certificate flag, and canonical root paths. If those checks pass, the profile server links to that group and does not schedule a per-profile scan.

Same host/root can intentionally map to different groups:

- `sputnik-main`
- `sputnik-alt`

This supports the case where the same Whatbox host has two accounts that expose different libraries. If accounts have different root namespaces or path mappings, they must use separate groups. MVP does not support per-linked-server path transforms.

## Scanning

Unlinked servers keep the current per-profile scan flow.

Linked servers use master scans:

- A shared group has one master profile FTP server foreign key.
- Admin can trigger or halt the shared scan.
- User-triggered rescan for a linked server requests the shared group scan.
- Scheduled per-user scans are disabled for linked servers.
- Shared scan writes to shared media and shared directory snapshot tables.
- The existing scan queue is refactored to support both profile-server and shared-group targets so all scans share one global concurrency and queue limit.

If the master credential fails, the shared group shows the failure to all linked profiles. Individual connection tests still validate each user's own FTP credentials.

## Streaming

Stream search includes normal per-profile media for unlinked servers and shared media for linked servers. While a server is linked, stale profile-scoped media for that server is ignored.

Shared playback URLs include the requesting profile token, linked profile server id, and shared media id:

```text
/proxy/:installToken/shared/:serverId/:sharedMediaId
```

The proxy resolver verifies that:

- The install token belongs to a profile.
- The `serverId` belongs to that profile.
- The server is linked to the same shared group as the shared media row.
- The linked server still matches the group's approved host/root/TLS identity.

Then it opens FTP with that profile server's own saved credentials and the shared file path. It never uses the master server credentials for playback.

## User UI

Linked servers clearly show:

- Shared group name/key.
- Master scan status.
- Shared item count and last scan.
- A note that scanning is handled by the master scan.

The normal rescan action becomes a shared rescan request for linked servers. Rescan frequency is disabled for linked servers because per-user schedules should not create duplicate scans.

## Admin UI

The admin dashboard gets shared index management:

- List shared groups with host, roots, linked account count, item count, last scan, and status.
- Create or update groups and one-time display/rotate pre-approved keys.
- Link/unlink profile servers.
- Pick or change master scan account.
- Trigger and halt shared scans.

## Migration

Existing profiles and indexes remain unlinked. New tables and nullable columns are additive. No existing media rows are deleted during migration.

Deleting or unlinking the master server clears the group's master reference and blocks shared rescans until an admin selects a new master. Unlinking a profile server clears its shared fields and leaves it as a normal unshared server.

## Testing

Use a local copy of the Oracle DB only. Tests cover:

- Schema migration preserves existing profiles.
- Schema v1 imports still parse.
- Schema v2 imports preserve `sharedIndexKey`.
- Approved keys auto-link saved servers.
- Unknown keys do not auto-link.
- Mismatched host/root/TLS settings do not auto-link.
- Linked servers report shared index status.
- Shared scan populates shared media.
- Stream search returns shared results only for linked profiles.
- Shared proxy playback uses the requesting profile's FTP credentials.
- A profile cannot stream shared media through an unlinked server.
- Raw keys and decrypted FTP credentials are not returned in normal profile/admin payloads.
