# Shared Index Groups

Shared index groups let multiple profile FTP servers reuse one scanned index when they expose the same library surface. Each profile still keeps its own FTP username and password, and playback opens FTP with the requesting profile's credentials.

## Lifecycle

The public build has no admin portal, so the web UI cannot create or manage groups. Groups are created from an existing profile server through the shared-index service layer; that server becomes the master scan server and is linked to the group.

1. Distribute the one-time `sharedIndexKey` in a trusted portable settings file.
2. When a user imports that file and saves the server, it auto-links if the key and server identity match.
3. Linked servers show the shared group in the portal and cannot schedule their own local scan frequency. Rescans from the master server refresh the shared index for every linked server.

Unlinking the master clears the master reference and blocks future shared rescans until a new master is selected.

## Matching Rules

Auto-linking requires the group to be enabled with import auto-linking on, and all of these to match the group:

- shared index key hash
- host
- port
- TLS mode
- invalid-certificate setting
- canonical root paths

The first version intentionally does not support path transforms. If the same host exposes different libraries for different usernames, create separate groups.

## Key Safety

The raw `sharedIndexKey` is returned only when a group is created or its key is rotated. The database stores only a hash. Normal user exports omit shared keys so users do not accidentally redistribute reusable linking tokens.

## Local Oracle DB Check

For this branch, the Oracle SQLite DB was copied locally to:

```text
.config/oracle-test/stremio-ftp.sqlite
```

That path is ignored by git. The copy was migrated locally only; the Oracle database was not modified. Verification on the local copy after migration:

```text
profiles: 24
ftp servers: 120
shared groups: 0
scan target column: present
```

