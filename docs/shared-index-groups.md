# Shared Index Groups

Shared index groups let multiple profile FTP servers reuse one scanned index when they expose the same library surface. Each profile still keeps its own FTP username and password, and playback opens FTP with the requesting profile's credentials.

## Admin Lifecycle

Only super admins from `SUPER_ADMIN_BROWSER_UIDS` can manage shared index groups.

1. Unlock the portal with a super-admin profile.
2. In the admin dashboard, create a group from an existing profile/server id. That server becomes the master scan server and is linked to the group.
3. Distribute the one-time `sharedIndexKey` through an admin-controlled import file if auto-linking is desired.
4. Link additional profile servers from the admin dashboard or let imports auto-link when the key and server identity match.
5. Trigger or halt scans from the shared group card. Linked user servers show the shared group and cannot schedule their own local scan frequency.

The master server can be changed to another linked-compatible profile server. Unlinking the master clears the master reference and blocks future shared rescans until a new master is selected.

## Matching Rules

Auto-linking requires all of these to match the group:

- shared index key hash
- host
- port
- TLS mode
- invalid-certificate setting
- canonical root paths

The first version intentionally does not support path transforms. If the same host exposes different libraries for different usernames, create separate groups.

## Key Safety

The raw `sharedIndexKey` is shown only when a group is created or its key is rotated. The database stores only a hash. Normal user exports omit shared keys so users do not accidentally redistribute reusable linking tokens.

Admin list responses include safe group metadata, linked server ids, master labels, counts, and scan status. They do not include FTP passwords or decrypted FTP configs.

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

