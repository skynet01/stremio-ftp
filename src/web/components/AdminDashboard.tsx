import { useEffect, useState } from "react";
import { CircleStop, Copy, KeyRound, Link2, RefreshCw, Search, Shield, ShieldCheck, Trash2, Unlink, X } from "lucide-react";
import {
  bulkAdminProfiles,
  cancelAdminSharedIndexScan,
  createAdminSharedIndexGroup,
  deleteAdminProfile,
  issueAdminManifestToken,
  linkAdminSharedIndexServer,
  loadAdminSharedIndexGroups,
  loadAdminProfiles,
  rescanAdminProfile,
  rescanAdminSharedIndexGroup,
  rotateAdminSharedIndexKey,
  setAdminProfileEnabled,
  setAdminSharedIndexMaster,
  unlinkAdminSharedIndexServer,
  updateAdminSharedIndexGroup,
  type AdminBulkProfileAction,
  type AdminBulkProfilesResponse,
  type AdminProfileListResponse,
  type AdminProfileSummary,
  type AdminSharedIndexGroup,
} from "../api.js";
import { Notice, formatScanTime, StatusBadge } from "./ui.js";

type AdminDashboardProps = {
  browserUid: string;
  passphrase: string;
};

type AdminSortKey = "browserUid" | "admin" | "servers" | "indexed" | "lastScanAt" | "state" | "manifest";
type AdminSort = {
  key: AdminSortKey;
  direction: "asc" | "desc";
};

type ServerBucket = {
  key: string;
  name: string;
  servers: Array<{
    profileId: number;
    profileUid: string;
    serverId: number;
    serverName: string;
    host: string | null;
  }>;
};

type BulkLinkResult = {
  linked: number;
  skipped: number;
  failed: number;
};

export function AdminDashboard({ browserUid, passphrase }: AdminDashboardProps) {
  const [data, setData] = useState<AdminProfileListResponse | null>(null);
  const [message, setMessage] = useState("Loading admin profile list...");
  const [loading, setLoading] = useState(false);
  const [busyProfileId, setBusyProfileId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<AdminBulkProfilesResponse | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<number>>(() => new Set());
  const [bulkLinkOpen, setBulkLinkOpen] = useState(false);
  const [bulkLinkMappings, setBulkLinkMappings] = useState<Record<string, string>>({});
  const [bulkLinkResult, setBulkLinkResult] = useState<BulkLinkResult | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<AdminSort | null>(null);
  const [sharedGroups, setSharedGroups] = useState<AdminSharedIndexGroup[]>([]);
  const [sharedCreateForm, setSharedCreateForm] = useState({ profileId: "", serverId: "", name: "", keyHint: "" });
  const [sharedTargetForms, setSharedTargetForms] = useState<Record<number, { profileId: string; serverId: string }>>({});
  const [busySharedGroupId, setBusySharedGroupId] = useState<number | "create" | null>(null);
  const [revealedSharedKey, setRevealedSharedKey] = useState<{ groupId: number; key: string } | null>(null);

  async function refreshProfiles() {
    setLoading(true);
    setMessage("Loading admin profile list...");
    try {
      const loaded = await loadAdminProfiles({ browserUid, passphrase });
      setData(loaded);
      setSelectedProfileIds((current) => new Set([...current].filter((profileId) => loaded.profiles.some((profile) => profile.id === profileId))));
      setMessage(loaded.profiles.length ? "Admin profile list loaded." : "No profiles are set up yet.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load admin profiles.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshSharedGroups() {
    try {
      const loaded = await loadAdminSharedIndexGroups({ browserUid, passphrase });
      setSharedGroups(loaded.groups);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load shared index groups.");
    }
  }

  async function refreshAdminData() {
    await refreshProfiles();
    await refreshSharedGroups();
  }

  useEffect(() => {
    void refreshAdminData();
  }, [browserUid, passphrase]);

  async function createSharedGroup() {
    const profileId = Number(sharedCreateForm.profileId);
    const serverId = Number(sharedCreateForm.serverId);
    if (!profileId || !serverId || !sharedCreateForm.name.trim()) return;
    setBusySharedGroupId("create");
    try {
      const created = await createAdminSharedIndexGroup({
        browserUid,
        passphrase,
        profileId,
        serverId,
        name: sharedCreateForm.name,
        keyHint: sharedCreateForm.keyHint || undefined,
      });
      setSharedGroups((current) => upsertSharedGroup(current, created.group));
      setRevealedSharedKey({ groupId: created.group.id, key: created.sharedIndexKey });
      setSharedCreateForm({ profileId: "", serverId: "", name: "", keyHint: "" });
      setMessage(`Shared index group created for ${created.group.host}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create shared index group.");
    } finally {
      setBusySharedGroupId(null);
    }
  }

  async function updateSharedGroup(group: AdminSharedIndexGroup, patch: Partial<Pick<AdminSharedIndexGroup, "enabled" | "autoLinkImports">>) {
    setBusySharedGroupId(group.id);
    try {
      const updated = await updateAdminSharedIndexGroup({
        browserUid,
        passphrase,
        groupId: group.id,
        enabled: patch.enabled ?? group.enabled,
        autoLinkImports: patch.autoLinkImports ?? group.autoLinkImports,
      });
      setSharedGroups((current) => upsertSharedGroup(current, updated.group));
      setMessage(`${group.name} updated.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update shared index group.");
    } finally {
      setBusySharedGroupId(null);
    }
  }

  async function rotateSharedKey(group: AdminSharedIndexGroup) {
    setBusySharedGroupId(group.id);
    try {
      const rotated = await rotateAdminSharedIndexKey({ browserUid, passphrase, groupId: group.id });
      setSharedGroups((current) => upsertSharedGroup(current, rotated.group));
      setRevealedSharedKey({ groupId: group.id, key: rotated.sharedIndexKey });
      await navigator.clipboard?.writeText(rotated.sharedIndexKey);
      setMessage(`Shared index key rotated for ${group.name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to rotate shared index key.");
    } finally {
      setBusySharedGroupId(null);
    }
  }

  async function runSharedScan(group: AdminSharedIndexGroup) {
    const active = group.scanStatus.status === "queued" || group.scanStatus.status === "running";
    setBusySharedGroupId(group.id);
    try {
      const result = active
        ? await cancelAdminSharedIndexScan({ browserUid, passphrase, groupId: group.id })
        : await rescanAdminSharedIndexGroup({ browserUid, passphrase, groupId: group.id });
      setSharedGroups((current) => upsertSharedGroup(current, { ...result.group, scanStatus: result.scanStatus }));
      setMessage(active ? `Shared scan halted for ${group.name}.` : `Shared scan queued for ${group.name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update shared scan.");
    } finally {
      setBusySharedGroupId(null);
    }
  }

  async function applySharedTarget(group: AdminSharedIndexGroup, action: "link" | "unlink" | "master") {
    const target = sharedTargetForms[group.id] ?? { profileId: "", serverId: "" };
    const profileId = Number(target.profileId);
    const serverId = Number(target.serverId);
    if (!profileId || !serverId) return;
    setBusySharedGroupId(group.id);
    try {
      const result =
        action === "link"
          ? await linkAdminSharedIndexServer({ browserUid, passphrase, groupId: group.id, profileId, serverId })
          : action === "unlink"
            ? await unlinkAdminSharedIndexServer({ browserUid, passphrase, groupId: group.id, profileId, serverId })
            : await setAdminSharedIndexMaster({ browserUid, passphrase, groupId: group.id, profileId, serverId });
      setSharedGroups((current) => upsertSharedGroup(current, result.group));
      setMessage(`${group.name} ${action === "master" ? "master updated" : action === "link" ? "linked" : "unlinked"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update shared index server.");
    } finally {
      setBusySharedGroupId(null);
    }
  }

  async function issueManifest(profile: AdminProfileSummary) {
    setBusyProfileId(profile.id);
    try {
      const issued = await issueAdminManifestToken({ browserUid, passphrase, profileId: profile.id });
      setData((current) =>
        current
          ? {
              ...current,
              profiles: current.profiles.map((candidate) =>
                candidate.id === profile.id
                  ? { ...candidate, manifestUrl: issued.manifestUrl, stremioInstallUrl: issued.stremioInstallUrl }
                  : candidate,
              ),
            }
          : current,
      );
      await navigator.clipboard?.writeText(issued.manifestUrl);
      setMessage(`Manifest URL issued for ${profile.browserUid}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to issue manifest URL.");
    } finally {
      setBusyProfileId(null);
    }
  }

  async function rescanProfile(profile: AdminProfileSummary) {
    setBusyProfileId(profile.id);
    try {
      await rescanAdminProfile({ browserUid, passphrase, profileId: profile.id });
      setData((current) =>
        current
          ? {
              ...current,
              profiles: current.profiles.map((candidate) =>
                candidate.id === profile.id ? { ...candidate, pendingScans: Math.max(candidate.pendingScans, 1) } : candidate,
              ),
            }
          : current,
      );
      setMessage(`Rescan queued for ${profile.browserUid}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to queue profile rescan.");
    } finally {
      setBusyProfileId(null);
    }
  }

  async function removeProfile(profile: AdminProfileSummary) {
    const confirmed = window.confirm(`Delete profile ${profile.browserUid}? This removes its FTP servers, indexed files, and manifest URLs.`);
    if (!confirmed) return;
    setBusyProfileId(profile.id);
    try {
      await deleteAdminProfile({ browserUid, passphrase, profileId: profile.id });
      setMessage(`Deleted profile ${profile.browserUid}.`);
      await refreshProfiles();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete profile.");
    } finally {
      setBusyProfileId(null);
    }
  }

  async function toggleAdmin(profile: AdminProfileSummary) {
    const nextAdminEnabled = !profile.adminEnabled;
    setBusyProfileId(profile.id);
    try {
      const updated = await setAdminProfileEnabled({ browserUid, passphrase, profileId: profile.id, adminEnabled: nextAdminEnabled });
      setData((current) =>
        current
          ? {
              ...current,
              profiles: current.profiles.map((candidate) =>
                candidate.id === profile.id
                  ? { ...candidate, adminEnabled: updated.adminEnabled, adminSource: updated.adminSource }
                  : candidate,
              ),
            }
          : current,
      );
      setMessage(`${profile.browserUid} is ${updated.adminEnabled ? "an admin" : "no longer an admin"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update admin access.");
    } finally {
      setBusyProfileId(null);
    }
  }

  async function copyRecoveryUid(profile: AdminProfileSummary) {
    await navigator.clipboard?.writeText(profile.browserUid);
    setMessage(`Recovery UID copied for ${profile.browserUid}.`);
  }

  async function runBulkAction(action: AdminBulkProfileAction) {
    const profileIds = selectedProfiles.map((profile) => profile.id);
    if (!profileIds.length) return;
    if (action === "delete") {
      const confirmed = window.confirm(`Delete ${profileIds.length} selected profiles? This removes their FTP servers, indexed files, and manifest URLs.`);
      if (!confirmed) return;
    }

    setBulkBusy(true);
    try {
      const result = await bulkAdminProfiles({ browserUid, passphrase, profileIds, action });
      setBulkResult(result);
      if (action === "delete") setSelectedProfileIds(new Set());
      setMessage(bulkActionMessage(result, profileIds.length));
      await refreshProfiles();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to run bulk admin action.");
    } finally {
      setBulkBusy(false);
    }
  }

  function openBulkLinkDialog() {
    const buckets = serverBucketsForProfiles(selectedProfiles);
    const nextMappings = Object.fromEntries(
      buckets.map((bucket) => [bucket.key, String(defaultGroupIdForBucket(bucket, sharedGroups) ?? "")]),
    );
    setBulkLinkMappings(nextMappings);
    setBulkLinkResult(null);
    setBulkLinkOpen(true);
  }

  async function linkServerBuckets(buckets: ServerBucket[]) {
    if (!buckets.length) return;

    setBulkBusy(true);
    try {
      let linked = 0;
      let failed = 0;
      let skipped = 0;
      let updatedGroup: AdminSharedIndexGroup | null = null;
      for (const bucket of buckets) {
        const groupId = Number(bulkLinkMappings[bucket.key]);
        if (!groupId) {
          skipped += bucket.servers.length;
          continue;
        }
        for (const server of bucket.servers) {
          try {
            const result = await linkAdminSharedIndexServer({ browserUid, passphrase, groupId, profileId: server.profileId, serverId: server.serverId });
            updatedGroup = result.group;
            linked += 1;
          } catch {
            failed += 1;
          }
        }
      }

      if (updatedGroup) setSharedGroups((current) => upsertSharedGroup(current, updatedGroup));
      setBulkLinkResult({ linked, failed, skipped });
      setMessage(`Bulk link complete: ${linked} linked, ${skipped} skipped, ${failed} failed.`);
      await refreshAdminData();
    } finally {
      setBulkBusy(false);
    }
  }

  function updateSort(key: AdminSortKey) {
    setSort((current) => (current?.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }));
  }

  function toggleProfileSelection(profileId: number, selected: boolean) {
    setSelectedProfileIds((current) => {
      const next = new Set(current);
      if (selected) next.add(profileId);
      else next.delete(profileId);
      return next;
    });
  }

  function toggleVisibleSelection(selected: boolean) {
    setSelectedProfileIds((current) => {
      const next = new Set(current);
      visibleProfiles.forEach((profile) => {
        if (selected) next.add(profile.id);
        else next.delete(profile.id);
      });
      return next;
    });
  }

  const summary = data?.summary;
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const profiles = data?.profiles ?? [];
  const filteredProfiles = normalizedSearch
    ? profiles.filter((profile) =>
        [
          profile.browserUid,
          profile.lastCountryCode ?? "unknown",
          profile.adminEnabled ? "admin" : "user",
          profile.adminSource ?? "",
          String(profile.id),
          ...(profile.ftpServerDetails?.flatMap((server) => [
            String(server.id),
            server.name,
            server.host ?? "",
            server.sharedIndex?.name ?? "",
            server.sharedIndex?.keyHint ?? "",
          ]) ?? []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch),
      )
    : profiles;
  const visibleProfiles = sort ? [...filteredProfiles].sort((left, right) => compareProfiles(left, right, sort)) : filteredProfiles;
  const selectedProfiles = profiles.filter((profile) => selectedProfileIds.has(profile.id));
  const visibleSelectedCount = visibleProfiles.filter((profile) => selectedProfileIds.has(profile.id)).length;
  const selectedCount = selectedProfiles.length;
  const selectedHasScanActivity = selectedProfiles.some((profile) => profile.activeScans > 0 || profile.pendingScans > 0);
  const allVisibleSelected = visibleProfiles.length > 0 && visibleSelectedCount === visibleProfiles.length;

  return (
    <section className="panel admin-dashboard-panel" aria-labelledby="admin-dashboard-heading">
      <div className="panel-header admin-dashboard-header">
        <div>
          <span className="section-label">Admin tools</span>
          <h2 id="admin-dashboard-heading">Admin dashboard</h2>
          <p>Inspect profile setup, index state, and debug manifest URLs.</p>
        </div>
        <button type="button" className="secondary-button" disabled={loading} onClick={() => void refreshAdminData()}>
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <dl className="status-list admin-summary-list">
        <SummaryStat label="Profiles" value={summary?.profiles ?? 0} />
        <SummaryStat label="Configured" value={summary?.configuredProfiles ?? 0} />
        <SummaryStat label="FTP servers" value={summary?.ftpServers ?? 0} />
        <SummaryStat label="Indexed items" value={summary?.indexedItems ?? 0} />
        <SummaryStat label="Active scans" value={summary?.activeScans ?? 0} />
        <SummaryStat label="Pending scans" value={summary?.pendingScans ?? 0} />
      </dl>

      <Notice className="admin-dashboard-notice">{message}</Notice>

      {data?.profiles.length ? (
        <>
          <label className="admin-profile-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search profiles</span>
            <input
              type="search"
              aria-label="Search profiles"
              placeholder="Search UID, country, or admin state"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>
          {selectedCount ? (
            <div className="admin-bulk-actions" aria-label="Bulk profile actions">
              <span>{selectedCount} selected</span>
              <button
                type="button"
                className={`secondary-button ${selectedHasScanActivity ? "danger-button" : ""}`}
                disabled={bulkBusy}
                onClick={() => void runBulkAction(selectedHasScanActivity ? "cancel_scan" : "rescan")}
              >
                {selectedHasScanActivity ? <CircleStop size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                {selectedHasScanActivity ? "Halt selected scans" : "Rescan selected"}
              </button>
              <button type="button" className="secondary-button" disabled={bulkBusy} onClick={() => void runBulkAction("convert_to_proxy")}>
                Convert selected to proxy
              </button>
              {sharedGroups.length ? (
                <button type="button" className="secondary-button" disabled={bulkBusy} onClick={openBulkLinkDialog}>
                  <Link2 size={15} aria-hidden="true" />
                  Bulk link servers
                </button>
              ) : null}
              <button type="button" className="secondary-button danger-button" disabled={bulkBusy} onClick={() => void runBulkAction("delete")}>
                Delete selected
              </button>
            </div>
          ) : null}
          <div className="admin-profile-table-wrap">
            <table className="admin-profile-table">
              <thead>
                <tr>
                  <th scope="col" className="admin-select-header">
                    <input
                      type="checkbox"
                      className="admin-profile-select"
                      aria-label="Select all visible profiles"
                      checked={allVisibleSelected}
                      onChange={(event) => toggleVisibleSelection(event.target.checked)}
                    />
                  </th>
                  <SortHeader label="Recovery UID" sortKey="browserUid" sort={sort} onSort={updateSort} />
                  <SortHeader label="Admin" sortKey="admin" sort={sort} onSort={updateSort} />
                  <SortHeader label="Servers" sortKey="servers" sort={sort} onSort={updateSort} />
                  <SortHeader label="Indexed" sortKey="indexed" sort={sort} onSort={updateSort} />
                  <SortHeader label="Last scan" sortKey="lastScanAt" sort={sort} onSort={updateSort} />
                  <SortHeader label="State" sortKey="state" sort={sort} onSort={updateSort} />
                  <SortHeader label="Manifest" sortKey="manifest" sort={sort} onSort={updateSort} />
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleProfiles.map((profile) => (
                  <tr key={profile.id}>
                    <td data-label="Select" className="admin-select-cell">
                      <input
                        type="checkbox"
                        className="admin-profile-select"
                        aria-label={`Select ${profile.browserUid}`}
                        checked={selectedProfileIds.has(profile.id)}
                        onChange={(event) => toggleProfileSelection(profile.id, event.target.checked)}
                      />
                    </td>
                    <td data-label="Recovery UID">
                      <button
                        type="button"
                        className="admin-profile-identity-button"
                        aria-label={`Copy recovery UID ${profile.browserUid}`}
                        title={profile.lastCountryCode ?? "Unknown"}
                        onClick={() => void copyRecoveryUid(profile)}
                      >
                        <span className="admin-country-flag" aria-hidden="true">
                          {countryFlag(profile.lastCountryCode)}
                        </span>
                        <code>{truncateUid(profile.browserUid)}</code>
                      </button>
                    </td>
                    <td data-label="Admin">
                      <AdminState profile={profile} />
                    </td>
                    <td data-label="Servers">
                      <div className="admin-server-cell">
                        <span>{profile.configuredFtpServers}/{profile.ftpServers}</span>
                        {profile.ftpServerDetails?.length ? (
                          <span className="admin-server-id-list">
                            {profile.ftpServerDetails.length} server{profile.ftpServerDetails.length === 1 ? "" : "s"} available for bulk link
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Indexed">{profile.indexedItems}</td>
                    <td data-label="Last scan">{formatScanTime(profile.lastScanAt)}</td>
                    <td data-label="State">
                      <ProfileStateBadge profile={profile} />
                    </td>
                    <td data-label="Manifest">
                      {profile.manifestUrl ? (
                        <button
                          type="button"
                          className="icon-button admin-manifest-copy"
                          aria-label={`Copy manifest URL for ${profile.browserUid}`}
                          title="Copy manifest URL"
                          onClick={() => void navigator.clipboard?.writeText(profile.manifestUrl!)}
                        >
                          <Copy size={16} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="admin-empty-value">Not issued</span>
                      )}
                    </td>
                    <td data-label="Actions">
                      <div className="admin-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={profile.adminEnabled ? `Demote ${profile.browserUid} from admin` : `Promote ${profile.browserUid} to admin`}
                          title={profile.adminEnabled ? "Demote admin" : "Promote to admin"}
                          disabled={busyProfileId === profile.id || profile.adminSource === "environment"}
                          onClick={() => void toggleAdmin(profile)}
                        >
                          {profile.adminEnabled ? <ShieldCheck size={16} aria-hidden="true" /> : <Shield size={16} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Issue manifest URL for ${profile.browserUid}`}
                          title="Issue manifest URL"
                          disabled={busyProfileId === profile.id}
                          onClick={() => void issueManifest(profile)}
                        >
                          <Link2 size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Rescan ${profile.browserUid}`}
                          title="Rescan profile"
                          disabled={busyProfileId === profile.id}
                          onClick={() => void rescanProfile(profile)}
                        >
                          <RefreshCw size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="icon-button danger-button"
                          aria-label={`Delete profile ${profile.browserUid}`}
                          title="Delete profile"
                          disabled={busyProfileId === profile.id}
                          onClick={() => void removeProfile(profile)}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <SharedIndexAdminSection
        groups={sharedGroups}
        createForm={sharedCreateForm}
        targetForms={sharedTargetForms}
        busyGroupId={busySharedGroupId}
        revealedKey={revealedSharedKey}
        onCreateFormChange={(patch) => setSharedCreateForm((current) => ({ ...current, ...patch }))}
        onTargetFormChange={(groupId, patch) =>
          setSharedTargetForms((current) => ({ ...current, [groupId]: { ...(current[groupId] ?? { profileId: "", serverId: "" }), ...patch } }))
        }
        onCreate={() => void createSharedGroup()}
        onUpdate={updateSharedGroup}
        onRotate={rotateSharedKey}
        onScan={runSharedScan}
        onApplyTarget={applySharedTarget}
      />
      {bulkLinkOpen ? (
        <BulkLinkDialog
          buckets={serverBucketsForProfiles(selectedProfiles)}
          groups={sharedGroups}
          mappings={bulkLinkMappings}
          busy={bulkBusy}
          result={bulkLinkResult}
          onMappingChange={(bucketKey, groupId) => setBulkLinkMappings((current) => ({ ...current, [bucketKey]: groupId }))}
          onLink={linkServerBuckets}
          onClose={() => setBulkLinkOpen(false)}
        />
      ) : null}
      {bulkResult ? <BulkActionDialog result={bulkResult} profiles={profiles} onClose={() => setBulkResult(null)} /> : null}
    </section>
  );
}

function upsertSharedGroup(groups: AdminSharedIndexGroup[], group: AdminSharedIndexGroup) {
  const next = groups.some((candidate) => candidate.id === group.id)
    ? groups.map((candidate) => (candidate.id === group.id ? group : candidate))
    : [...groups, group];
  return next.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function serverBucketsForProfiles(profiles: AdminProfileSummary[]) {
  const buckets = new Map<string, ServerBucket>();
  for (const profile of profiles) {
    for (const server of profile.ftpServerDetails ?? []) {
      const key = normalizedServerName(server.name);
      if (!key) continue;
      const bucket = buckets.get(key) ?? { key, name: server.name.trim() || `Server ${server.id}`, servers: [] };
      bucket.servers.push({
        profileId: profile.id,
        profileUid: profile.browserUid,
        serverId: server.id,
        serverName: server.name,
        host: server.host,
      });
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function normalizedServerName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function defaultGroupIdForBucket(bucket: ServerBucket, groups: AdminSharedIndexGroup[]) {
  let best: { groupId: number; score: number; nameLength: number } | null = null;
  for (const group of groups) {
    const score = Math.max(groupMatchScore(bucket, group.name), groupMatchScore(bucket, group.keyHint), groupMatchScore(bucket, group.host));
    if (score === 0) continue;
    const candidate = { groupId: group.id, score, nameLength: group.name.length };
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.nameLength < best.nameLength)) best = candidate;
  }
  return best?.groupId ?? null;
}

function groupMatchScore(bucket: ServerBucket, value: string) {
  const normalizedValue = normalizedServerName(value);
  if (!normalizedValue) return 0;
  if (normalizedValue === bucket.key) return 100;
  if (normalizedValue.startsWith(`${bucket.key} `)) return 90;
  if (bucket.key.startsWith(`${normalizedValue} `)) return 80;
  if (normalizedValue.split(" ").includes(bucket.key)) return 70;
  return 0;
}

function SharedIndexAdminSection({
  groups,
  createForm,
  targetForms,
  busyGroupId,
  revealedKey,
  onCreateFormChange,
  onTargetFormChange,
  onCreate,
  onUpdate,
  onRotate,
  onScan,
  onApplyTarget,
}: {
  groups: AdminSharedIndexGroup[];
  createForm: { profileId: string; serverId: string; name: string; keyHint: string };
  targetForms: Record<number, { profileId: string; serverId: string }>;
  busyGroupId: number | "create" | null;
  revealedKey: { groupId: number; key: string } | null;
  onCreateFormChange: (patch: Partial<typeof createForm>) => void;
  onTargetFormChange: (groupId: number, patch: Partial<{ profileId: string; serverId: string }>) => void;
  onCreate: () => void;
  onUpdate: (group: AdminSharedIndexGroup, patch: Partial<Pick<AdminSharedIndexGroup, "enabled" | "autoLinkImports">>) => void;
  onRotate: (group: AdminSharedIndexGroup) => void;
  onScan: (group: AdminSharedIndexGroup) => void;
  onApplyTarget: (group: AdminSharedIndexGroup, action: "link" | "unlink" | "master") => void;
}) {
  return (
    <section className="admin-shared-index-section" aria-labelledby="admin-shared-index-heading">
      <div className="admin-subsection-header">
        <div>
          <span className="section-label">Shared indexes</span>
          <h3 id="admin-shared-index-heading">Shared index groups</h3>
        </div>
      </div>

      <div className="admin-shared-create">
        <input
          inputMode="numeric"
          aria-label="Master profile ID"
          placeholder="Profile ID"
          value={createForm.profileId}
          onChange={(event) => onCreateFormChange({ profileId: event.target.value })}
        />
        <input
          inputMode="numeric"
          aria-label="Master server ID"
          placeholder="Server ID"
          value={createForm.serverId}
          onChange={(event) => onCreateFormChange({ serverId: event.target.value })}
        />
        <input
          aria-label="Shared group name"
          placeholder="Group name"
          value={createForm.name}
          onChange={(event) => onCreateFormChange({ name: event.target.value })}
        />
        <input
          aria-label="Shared key hint"
          placeholder="Key hint"
          value={createForm.keyHint}
          onChange={(event) => onCreateFormChange({ keyHint: event.target.value })}
        />
        <button type="button" className="secondary-button" disabled={busyGroupId === "create"} onClick={onCreate}>
          <KeyRound size={15} aria-hidden="true" />
          Create group
        </button>
      </div>

      {groups.length ? (
        <div className="admin-shared-grid">
          {groups.map((group) => {
            const target = targetForms[group.id] ?? { profileId: "", serverId: "" };
            const active = group.scanStatus.status === "queued" || group.scanStatus.status === "running";
            return (
              <article className="admin-shared-card" key={group.id}>
                <div className="admin-shared-card-header">
                  <div>
                    <h4>{group.name}</h4>
                    <p>
                      {group.host}:{group.port} - {group.rootPaths.join(", ")}
                    </p>
                  </div>
                  <StatusBadge tone={group.enabled ? "green" : "gray"}>{group.enabled ? "Enabled" : "Disabled"}</StatusBadge>
                </div>
                <dl className="status-list admin-shared-stats">
                  <SummaryStat label="Linked" value={group.linkedServerCount} />
                  <SummaryStat label="Items" value={group.indexedMediaCount} />
                  <div>
                    <dt>Last scan</dt>
                    <dd>{formatScanTime(group.lastIndexedAt)}</dd>
                  </div>
                  <div>
                    <dt>Master</dt>
                    <dd>{group.masterServer ? `${truncateUid(group.masterServer.browserUid)} / ${group.masterServer.serverName}` : "None"}</dd>
                  </div>
                </dl>
                {revealedKey?.groupId === group.id ? (
                  <button
                    type="button"
                    className="admin-shared-key"
                    title="Copy shared index key"
                    onClick={() => void navigator.clipboard?.writeText(revealedKey.key)}
                  >
                    <Copy size={14} aria-hidden="true" />
                    <code>{revealedKey.key}</code>
                  </button>
                ) : null}
                <div className="admin-shared-toggles">
                  <label className="toggle-row" htmlFor={`shared-enabled-${group.id}`}>
                    <input
                      id={`shared-enabled-${group.id}`}
                      type="checkbox"
                      checked={group.enabled}
                      disabled={busyGroupId === group.id}
                      onChange={(event) => onUpdate(group, { enabled: event.target.checked })}
                    />
                    Enabled
                  </label>
                  <label className="toggle-row" htmlFor={`shared-autolink-${group.id}`}>
                    <input
                      id={`shared-autolink-${group.id}`}
                      type="checkbox"
                      checked={group.autoLinkImports}
                      disabled={busyGroupId === group.id}
                      onChange={(event) => onUpdate(group, { autoLinkImports: event.target.checked })}
                    />
                    Auto-link imports
                  </label>
                </div>
                <div className="admin-shared-target-row">
                  <input
                    inputMode="numeric"
                    aria-label={`Profile ID for ${group.name}`}
                    placeholder="Profile ID"
                    value={target.profileId}
                    onChange={(event) => onTargetFormChange(group.id, { profileId: event.target.value })}
                  />
                  <input
                    inputMode="numeric"
                    aria-label={`Server ID for ${group.name}`}
                    placeholder="Server ID"
                    value={target.serverId}
                    onChange={(event) => onTargetFormChange(group.id, { serverId: event.target.value })}
                  />
                </div>
                <div className="admin-shared-actions">
                  <button type="button" className="icon-button" title="Link server" aria-label={`Link server to ${group.name}`} disabled={busyGroupId === group.id} onClick={() => onApplyTarget(group, "link")}>
                    <Link2 size={15} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-button" title="Set master server" aria-label={`Set master for ${group.name}`} disabled={busyGroupId === group.id} onClick={() => onApplyTarget(group, "master")}>
                    <ShieldCheck size={15} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-button" title="Unlink server" aria-label={`Unlink server from ${group.name}`} disabled={busyGroupId === group.id} onClick={() => onApplyTarget(group, "unlink")}>
                    <Unlink size={15} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-button" title="Rotate key" aria-label={`Rotate key for ${group.name}`} disabled={busyGroupId === group.id} onClick={() => onRotate(group)}>
                    <KeyRound size={15} aria-hidden="true" />
                  </button>
                  <button type="button" className={`icon-button ${active ? "danger-button" : ""}`} title={active ? "Halt shared scan" : "Rescan shared index"} aria-label={active ? `Halt scan for ${group.name}` : `Rescan ${group.name}`} disabled={busyGroupId === group.id} onClick={() => onScan(group)}>
                    {active ? <CircleStop size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="admin-empty-value">No shared index groups configured.</p>
      )}
    </section>
  );
}

function truncateUid(uid: string) {
  return uid.length > 15 ? uid.slice(0, 15) : uid;
}

function countryFlag(countryCode: string | null) {
  const code = countryCode?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code)) return "??";
  const offset = 127397;
  return String.fromCodePoint(...[...code].map((character) => character.charCodeAt(0) + offset));
}

function bulkActionMessage(result: AdminBulkProfilesResponse, count: number) {
  if (result.action === "delete") return `Deleted ${result.summary?.deleted ?? result.deleted ?? count} selected profiles.`;
  if (result.action === "rescan") return `Queued ${result.summary?.queued ?? 0} scans across ${count} selected profiles.`;
  if (result.action === "cancel_scan") return `Halted ${result.summary?.cancelled ?? result.summary?.halting ?? 0} scans across ${count} selected profiles.`;
  return `Converted ${result.summary?.converted ?? result.converted ?? count} selected profiles and their FTP servers to proxy streaming.`;
}

function BulkActionDialog({
  result,
  profiles,
  onClose,
}: {
  result: AdminBulkProfilesResponse;
  profiles: AdminProfileSummary[];
  onClose: () => void;
}) {
  const stats = bulkResultStats(result);
  const profileNameById = new Map(profiles.map((profile) => [profile.id, profile.browserUid]));
  return (
    <div className="admin-bulk-dialog-backdrop">
      <div className="admin-bulk-dialog" role="dialog" aria-modal={true} aria-labelledby="admin-bulk-dialog-heading">
        <div className="admin-bulk-dialog-header">
          <div>
            <span className="section-label">{bulkActionLabel(result.action)}</span>
            <h3 id="admin-bulk-dialog-heading">Bulk action status</h3>
          </div>
          <button type="button" className="icon-button" aria-label="Close bulk action status" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="admin-bulk-result-grid">
          {stats.map((stat) => (
            <div key={stat.label}>{stat.value} {stat.label}</div>
          ))}
        </div>
        {result.scans?.length ? (
          <ul className="admin-bulk-result-list">
            {result.scans.slice(0, 12).map((scan) => (
              <li key={`${scan.profileId}-${scan.serverId}`}>
                <span>{truncateUid(profileNameById.get(scan.profileId) ?? String(scan.profileId))}</span>
                <span>{scan.serverName}</span>
                <StatusBadge tone={scan.scanStatus.status === "failed" ? "red" : scan.scanStatus.status === "queued" ? "amber" : "green"}>
                  {scan.scanStatus.status}
                </StatusBadge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function bulkActionLabel(action: AdminBulkProfileAction) {
  if (action === "delete") return "Delete";
  if (action === "rescan") return "Rescan";
  if (action === "cancel_scan") return "Halt scans";
  return "Proxy conversion";
}

function bulkResultStats(result: AdminBulkProfilesResponse) {
  const summary = result.summary;
  const stats = [
    { label: "profiles", value: summary?.profiles ?? result.profileIds.length },
    { label: "servers", value: summary?.servers ?? 0 },
    { label: "queued", value: summary?.queued ?? 0 },
    { label: "running", value: summary?.running ?? 0 },
    { label: "halting", value: summary?.halting ?? 0 },
    { label: "cancelled", value: summary?.cancelled ?? 0 },
    { label: "skipped", value: summary?.skipped ?? 0 },
    { label: "failed", value: summary?.failed ?? 0 },
    { label: "converted", value: summary?.converted ?? result.converted ?? 0 },
    { label: "deleted", value: summary?.deleted ?? result.deleted ?? 0 },
  ];
  return stats.filter((stat) => stat.value > 0 || stat.label === "profiles");
}

function BulkLinkDialog({
  buckets,
  groups,
  mappings,
  busy,
  result,
  onMappingChange,
  onLink,
  onClose,
}: {
  buckets: ServerBucket[];
  groups: AdminSharedIndexGroup[];
  mappings: Record<string, string>;
  busy: boolean;
  result: BulkLinkResult | null;
  onMappingChange: (bucketKey: string, groupId: string) => void;
  onLink: (buckets: ServerBucket[]) => void;
  onClose: () => void;
}) {
  const serverCount = buckets.reduce((total, bucket) => total + bucket.servers.length, 0);
  return (
    <div className="admin-bulk-dialog-backdrop">
      <div className="admin-bulk-dialog admin-bulk-link-dialog" role="dialog" aria-modal={true} aria-labelledby="admin-bulk-link-heading">
        <div className="admin-bulk-dialog-header">
          <div>
            <span className="section-label">Bulk link</span>
            <h3 id="admin-bulk-link-heading">Link selected servers</h3>
          </div>
          <button type="button" className="icon-button" aria-label="Close bulk link dialog" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="admin-bulk-link-summary">
          {serverCount} server{serverCount === 1 ? "" : "s"} across {buckets.length} server-name bucket{buckets.length === 1 ? "" : "s"}.
        </p>
        <div className="admin-bulk-link-grid">
          {buckets.map((bucket) => {
            const exampleUids = bucket.servers
              .slice(0, 3)
              .map((server) => truncateUid(server.profileUid))
              .join(", ");
            const host = bucket.servers.find((server) => server.host)?.host;
            return (
              <label className="admin-bulk-link-row" key={bucket.key}>
                <span className="admin-bulk-link-server">
                  <strong>{bucket.name}</strong>
                  <span>
                    {bucket.servers.length} server{bucket.servers.length === 1 ? "" : "s"}
                    {host ? ` on ${host}` : ""}{exampleUids ? ` - ${exampleUids}` : ""}
                  </span>
                </span>
                <select
                  aria-label={`Shared index group for ${bucket.name}`}
                  value={mappings[bucket.key] ?? ""}
                  disabled={busy}
                  onChange={(event) => onMappingChange(bucket.key, event.target.value)}
                >
                  <option value="">Skip</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
        {result ? (
          <div className="admin-bulk-link-result" aria-live="polite">
            <span>{result.linked} linked</span>
            <span>{result.skipped} skipped</span>
            <span>{result.failed} failed</span>
          </div>
        ) : null}
        <div className="admin-bulk-link-footer">
          <button type="button" className="secondary-button" disabled={busy || !buckets.length} onClick={() => onLink(buckets)}>
            <Link2 size={15} aria-hidden="true" />
            {busy ? "Linking..." : "Link server buckets"}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: AdminSortKey;
  sort: AdminSort | null;
  onSort: (key: AdminSortKey) => void;
}) {
  const active = sort?.key === sortKey;
  const indicator = active ? (sort.direction === "asc" ? "up" : "down") : "none";

  return (
    <th scope="col" aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="admin-sort-button" aria-label={`Sort by ${label}`} onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        <span className="admin-sort-indicator" aria-hidden="true">
          {indicator === "up" ? "^" : indicator === "down" ? "v" : "-"}
        </span>
      </button>
    </th>
  );
}

function compareProfiles(left: AdminProfileSummary, right: AdminProfileSummary, sort: AdminSort) {
  const leftValue = profileSortValue(left, sort.key);
  const rightValue = profileSortValue(right, sort.key);
  const direction = sort.direction === "asc" ? 1 : -1;

  if (typeof leftValue === "number" && typeof rightValue === "number") return (leftValue - rightValue) * direction;
  return String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: "base" }) * direction;
}

function profileSortValue(profile: AdminProfileSummary, key: AdminSortKey) {
  switch (key) {
    case "browserUid":
      return profile.browserUid;
    case "admin":
      return profile.adminEnabled ? 1 : 0;
    case "servers":
      return profile.configuredFtpServers;
    case "indexed":
      return profile.indexedItems;
    case "lastScanAt":
      return profile.lastScanAt ? Date.parse(profile.lastScanAt) : 0;
    case "state":
      return profileStateLabel(profile);
    case "manifest":
      return profile.manifestUrl ? 1 : 0;
  }
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ProfileStateBadge({ profile }: { profile: AdminProfileSummary }) {
  const label = profileStateLabel(profile);
  const tone = label === "Scanning" || label === "Indexed" ? "green" : label === "Pending" ? "amber" : "gray";
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

function profileStateLabel(profile: AdminProfileSummary) {
  if (profile.activeScans > 0) return "Scanning";
  if (profile.pendingScans > 0) return "Pending";
  if (profile.indexedItems > 0) return "Indexed";
  if (profile.configuredFtpServers > 0) return "Configured";
  return "Empty";
}

function AdminState({ profile }: { profile: AdminProfileSummary }) {
  if (profile.adminSource === "environment") return <StatusBadge tone="green">Env admin</StatusBadge>;
  if (profile.adminEnabled) return <StatusBadge tone="green">Admin</StatusBadge>;
  return <StatusBadge tone="gray">User</StatusBadge>;
}
