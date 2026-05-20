import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleStop, Copy, Crown, createLucideIcon, KeyRound, Link2, RefreshCw, Search, ShieldCheck, Trash2, User, X } from "lucide-react";
import {
  bulkAdminProfiles,
  cancelAdminSharedIndexScan,
  createAdminSharedIndexGroup,
  deleteAdminSharedIndexGroup,
  deleteAdminProfile,
  issueAdminManifestToken,
  linkAdminSharedIndexServer,
  loadAdminSharedIndexGroups,
  loadAdminProfiles,
  rescanAdminSharedIndexGroup,
  rotateAdminSharedIndexKey,
  scheduleAdminSharedIndexGroup,
  setAdminProfileEnabled,
  unlinkAdminSharedIndexServer,
  updateAdminSharedIndexGroup,
  type AdminBulkProfileAction,
  type AdminBulkProfilesResponse,
  type AdminProfileListResponse,
  type AdminProfileSummary,
  type AdminSharedIndexGroup,
  type AdminSharedIndexLinkedServer,
} from "../api.js";
import { useConfirmDialog } from "./ConfirmDialog.js";
import { Notice, formatNextScan, formatScanTime, StatusBadge, type StatusTone } from "./ui.js";

const RotateCcwKey = createLucideIcon("rotate-ccw-key", [
  ["path", { d: "M12 7v6", key: "lw1j43" }],
  ["path", { d: "M12 9h2", key: "1lpap9" }],
  ["path", { d: "M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8", key: "g2jlw" }],
  ["path", { d: "M3 3v5h5", key: "1xhq8a" }],
  ["circle", { cx: "12", cy: "15", r: "2", key: "1vpstw" }],
]);

type AdminDashboardProps = {
  browserUid: string;
  passphrase: string;
};

type AdminSortKey = "browserUid" | "admin" | "servers" | "indexed" | "lastManifestAccessedAt" | "state";
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
  errors: Array<{
    serverName: string;
    profileUid: string;
    message: string;
  }>;
};

type CreateSharedGroupTarget = {
  profileId: number;
  profileUid: string;
  serverId: number;
  serverName: string;
  host: string | null;
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
  const [busySharedGroupId, setBusySharedGroupId] = useState<number | "create" | null>(null);
  const [revealedSharedKey, setRevealedSharedKey] = useState<{ groupId: number; key: string } | null>(null);
  const [serverModalProfileId, setServerModalProfileId] = useState<number | null>(null);
  const [serverLinkSelections, setServerLinkSelections] = useState<Record<string, string>>({});
  const [editingSharedScheduleId, setEditingSharedScheduleId] = useState<number | null>(null);
  const [linkedServersGroupId, setLinkedServersGroupId] = useState<number | null>(null);
  const [createSharedTarget, setCreateSharedTarget] = useState<CreateSharedGroupTarget | null>(null);
  const [createSharedDraft, setCreateSharedDraft] = useState({ name: "", keyHint: "" });
  const { confirm, confirmDialog } = useConfirmDialog();

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

  async function refreshUnlinkedIndexes(targetProfiles: AdminProfileSummary[], label: string) {
    const profileIds = targetProfiles.map((profile) => profile.id);
    if (!profileIds.length) {
      setMessage("No unlinked configured servers need a refresh.");
      return;
    }
    setBulkBusy(true);
    try {
      const result = await bulkAdminProfiles({ browserUid, passphrase, profileIds, action: "rescan" });
      setBulkResult(result);
      setMessage(`Queued ${result.summary?.queued ?? 0} unlinked server scans for ${label}.`);
      await refreshAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to queue unlinked refresh.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function requestRefreshUnlinkedIndexes(targetProfiles: AdminProfileSummary[], label: string) {
    const serverCount = targetProfiles.reduce((sum, profile) => sum + unlinkedConfiguredServers(profile).length, 0);
    if (!serverCount) {
      setMessage("No unlinked configured servers need a refresh.");
      return;
    }
    const confirmed = await confirm({
      title: `Refresh ${serverCount} unlinked server${serverCount === 1 ? "" : "s"}?`,
      body: "This queues FTP rescans only for unlinked configured servers. Linked servers continue to use their shared index groups.",
      confirmLabel: "Refresh unlinked",
    });
    if (confirmed) await refreshUnlinkedIndexes(targetProfiles, label);
  }

  useEffect(() => {
    void refreshAdminData();
  }, [browserUid, passphrase]);

  function openCreateSharedGroupDialog(profile: AdminProfileSummary, server: AdminServerDetail) {
    setCreateSharedTarget({
      profileId: profile.id,
      profileUid: profile.browserUid,
      serverId: server.id,
      serverName: server.name,
      host: server.host,
    });
    setCreateSharedDraft({ name: server.name.trim() || `Server ${server.id}`, keyHint: "" });
  }

  async function createSharedGroup() {
    if (!createSharedTarget || !createSharedDraft.name.trim()) return;
    setBusySharedGroupId("create");
    try {
      const created = await createAdminSharedIndexGroup({
        browserUid,
        passphrase,
        profileId: createSharedTarget.profileId,
        serverId: createSharedTarget.serverId,
        name: createSharedDraft.name,
        keyHint: createSharedDraft.keyHint || undefined,
      });
      setSharedGroups((current) => upsertSharedGroup(current, created.group));
      setRevealedSharedKey({ groupId: created.group.id, key: created.sharedIndexKey });
      setCreateSharedTarget(null);
      setCreateSharedDraft({ name: "", keyHint: "" });
      setMessage(`Shared index group created for ${created.group.host}.`);
      await refreshAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create shared index group.");
    } finally {
      setBusySharedGroupId(null);
    }
  }

  async function updateSharedGroup(group: AdminSharedIndexGroup, patch: Partial<Pick<AdminSharedIndexGroup, "name" | "enabled" | "autoLinkImports">>) {
    setBusySharedGroupId(group.id);
    try {
      const updated = await updateAdminSharedIndexGroup({
        browserUid,
        passphrase,
        groupId: group.id,
        name: patch.name ?? group.name,
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

  async function requestRotateSharedKey(group: AdminSharedIndexGroup) {
    const confirmed = await confirm({
      title: `Rotate key for ${group.name}?`,
      body: "Existing import files with the current shared index key will stop auto-linking. Linked servers stay linked.",
      confirmLabel: "Rotate key",
      danger: true,
    });
    if (confirmed) await rotateSharedKey(group);
  }

  async function deleteSharedGroup(group: AdminSharedIndexGroup) {
    setBusySharedGroupId(group.id);
    try {
      await deleteAdminSharedIndexGroup({ browserUid, passphrase, groupId: group.id });
      setSharedGroups((current) => current.filter((candidate) => candidate.id !== group.id));
      if (revealedSharedKey?.groupId === group.id) setRevealedSharedKey(null);
      setMessage(`${group.name} deleted.`);
      await refreshAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete shared index group.");
    } finally {
      setBusySharedGroupId(null);
    }
  }

  async function requestDeleteSharedGroup(group: AdminSharedIndexGroup) {
    const confirmed = await confirm({
      title: `Delete ${group.name}?`,
      body: "This removes the disabled shared index group and its shared index data. Profile servers linked to it will become unlinked.",
      confirmLabel: "Delete group",
      danger: true,
    });
    if (confirmed) await deleteSharedGroup(group);
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

  async function updateSharedSchedule(group: AdminSharedIndexGroup, intervalMinutes: number) {
    setBusySharedGroupId(group.id);
    try {
      const result = await scheduleAdminSharedIndexGroup({ browserUid, passphrase, groupId: group.id, intervalMinutes });
      setSharedGroups((current) => upsertSharedGroup(current, result.group));
      setEditingSharedScheduleId(null);
      setMessage(intervalMinutes > 0 ? `${group.name} shared scan schedule saved.` : `${group.name} automatic scans disabled.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update shared scan schedule.");
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
      setMessage(`Manifest URL issued and copied for ${profile.browserUid}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to issue manifest URL.");
    } finally {
      setBusyProfileId(null);
    }
  }

  function requestRescanProfile(profile: AdminProfileSummary) {
    void requestRefreshUnlinkedIndexes([profile], truncateUid(profile.browserUid));
  }

  async function removeProfile(profile: AdminProfileSummary) {
    const confirmed = await confirm({
      title: `Delete ${truncateUid(profile.browserUid)}?`,
      body: `This removes profile ${profile.browserUid}, its FTP servers, indexed files, and manifest URLs.`,
      confirmLabel: "Delete profile",
      danger: true,
    });
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
      const confirmed = await confirm({
        title: `Delete ${profileIds.length} selected profile${profileIds.length === 1 ? "" : "s"}?`,
        body: "This removes their FTP servers, indexed files, and manifest URLs.",
        confirmLabel: "Delete selected",
        danger: true,
      });
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
      const errors: BulkLinkResult["errors"] = [];
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
          } catch (error) {
            failed += 1;
            errors.push({
              serverName: server.serverName,
              profileUid: server.profileUid,
              message: error instanceof Error ? error.message : "Unable to link server.",
            });
          }
        }
      }

      if (updatedGroup) setSharedGroups((current) => upsertSharedGroup(current, updatedGroup));
      setBulkLinkResult({ linked, failed, skipped, errors });
      setMessage(errors.length ? `Bulk link complete with ${failed} failed. Open the link dialog for details.` : `Bulk link complete: ${linked} linked, ${skipped} skipped, ${failed} failed.`);
      await refreshAdminData();
    } finally {
      setBulkBusy(false);
    }
  }

  async function linkServerFromModal(profileId: number, serverId: number) {
    const key = serverSelectionKey(profileId, serverId);
    const groupId = Number(serverLinkSelections[key]);
    if (!groupId) {
      setMessage("Choose a shared index group before linking this server.");
      return;
    }
    setBusyProfileId(profileId);
    try {
      const result = await linkAdminSharedIndexServer({ browserUid, passphrase, groupId, profileId, serverId });
      setSharedGroups((current) => upsertSharedGroup(current, result.group));
      setMessage("Server linked to shared index group.");
      await refreshAdminData();
    } catch (error) {
      const serverName = profiles.find((profile) => profile.id === profileId)?.ftpServerDetails?.find((server) => server.id === serverId)?.name ?? "Server";
      setMessage(`${serverName} link failed: ${error instanceof Error ? error.message : "Unable to link server."}`);
    } finally {
      setBusyProfileId(null);
    }
  }

  async function unlinkServerFromModal(profileId: number, serverId: number, groupId: number) {
    setBusyProfileId(profileId);
    try {
      const result = await unlinkAdminSharedIndexServer({ browserUid, passphrase, groupId, profileId, serverId });
      setSharedGroups((current) => upsertSharedGroup(current, result.group));
      setMessage("Server unlinked from shared index group.");
      await refreshAdminData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to unlink server.");
    } finally {
      setBusyProfileId(null);
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
  const serverModalProfile = profiles.find((profile) => profile.id === serverModalProfileId) ?? null;
  const linkedServersGroup = sharedGroups.find((group) => group.id === linkedServersGroupId) ?? null;
  const displayStats = adminDisplayStats(profiles, sharedGroups, summary);

  return (
    <section className="panel admin-dashboard-panel" aria-labelledby="admin-dashboard-heading">
      <div className="panel-header admin-dashboard-header">
        <div>
          <span className="section-label">Admin tools</span>
          <h2 id="admin-dashboard-heading">Admin dashboard</h2>
          <p>Inspect profile setup, linked indexes, and scan state.</p>
        </div>
        <div className="admin-header-actions">
          <button type="button" className="secondary-button" disabled={loading} onClick={() => void refreshAdminData()}>
            <RefreshCw size={16} aria-hidden="true" />
            Reload
          </button>
          <button type="button" className="secondary-button" disabled={bulkBusy || loading} onClick={() => void requestRefreshUnlinkedIndexes(profilesWithUnlinkedServers(profiles), "all non-empty profiles")}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh unlinked
          </button>
        </div>
      </div>

      <dl className="status-list admin-summary-list">
        <SummaryStat label="Profiles" value={displayStats.nonEmptyProfiles} title={`${displayStats.totalProfiles} total profiles - ${displayStats.createdToday} created today`} />
        <SummaryStat label="FTP servers" value={displayStats.uniqueServers} title={`${displayStats.totalServers} total server rows`} />
        <SummaryStat label="Indexed items" value={displayStats.uniqueIndexedItems} title={`${displayStats.totalIndexedItems} total indexed rows before dedupe`} />
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
                  <SortHeader label="Admin" sortKey="admin" sort={sort} onSort={updateSort} />
                  <SortHeader label="Recovery UID" sortKey="browserUid" sort={sort} onSort={updateSort} />
                  <SortHeader label="Servers" sortKey="servers" sort={sort} onSort={updateSort} />
                  <SortHeader label="Indexed" sortKey="indexed" sort={sort} onSort={updateSort} />
                  <SortHeader label="Last used" sortKey="lastManifestAccessedAt" sort={sort} onSort={updateSort} />
                  <SortHeader label="State" sortKey="state" sort={sort} onSort={updateSort} />
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
                    <td data-label="Admin">
                      <AdminState profile={profile} />
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
                    <td data-label="Servers">
                      <button type="button" className="admin-server-cell admin-server-cell-button" onClick={() => setServerModalProfileId(profile.id)}>
                        <span>{profile.configuredFtpServers}/{profile.ftpServers}</span>
                        {profile.ftpServerDetails?.length ? (
                          <span className="admin-server-id-list">
                            {serverLinkSummary(profile)}
                          </span>
                        ) : null}
                      </button>
                    </td>
                    <td data-label="Indexed">{profile.indexedItems}</td>
                    <td data-label="Last used">{formatScanTime(profile.lastManifestAccessedAt)}</td>
                    <td data-label="State">
                      <ProfileStateBadge profile={profile} />
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
                          {profile.adminEnabled ? <ShieldCheck size={16} aria-hidden="true" /> : <User size={16} aria-hidden="true" />}
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
                          onClick={() => requestRescanProfile(profile)}
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
        busyGroupId={busySharedGroupId}
        revealedKey={revealedSharedKey}
        onUpdate={updateSharedGroup}
        onRotate={requestRotateSharedKey}
        onDelete={requestDeleteSharedGroup}
        onScan={runSharedScan}
        onOpenLinkedServers={(group) => setLinkedServersGroupId(group.id)}
        editingScheduleId={editingSharedScheduleId}
        onToggleScheduleEditor={(group) => setEditingSharedScheduleId((current) => (current === group.id ? null : group.id))}
        onSchedule={updateSharedSchedule}
      />
      {serverModalProfile ? (
        <ProfileServersDialog
          profile={serverModalProfile}
          groups={sharedGroups}
          selections={serverLinkSelections}
          busy={busyProfileId === serverModalProfile.id}
          onSelectionChange={(key, groupId) => setServerLinkSelections((current) => ({ ...current, [key]: groupId }))}
          onLink={linkServerFromModal}
          onUnlink={unlinkServerFromModal}
          onCreateGroup={openCreateSharedGroupDialog}
          onClose={() => setServerModalProfileId(null)}
        />
      ) : null}
      {linkedServersGroup ? (
        <LinkedServersDialog
          group={linkedServersGroup}
          busy={busyProfileId !== null || busySharedGroupId !== null}
          onUnlink={(server) => void unlinkServerFromModal(server.profileId, server.serverId, linkedServersGroup.id)}
          onClose={() => setLinkedServersGroupId(null)}
        />
      ) : null}
      {createSharedTarget ? (
        <CreateSharedGroupDialog
          target={createSharedTarget}
          draft={createSharedDraft}
          busy={busySharedGroupId === "create"}
          onDraftChange={(patch) => setCreateSharedDraft((current) => ({ ...current, ...patch }))}
          onCreate={() => void createSharedGroup()}
          onClose={() => {
            setCreateSharedTarget(null);
            setCreateSharedDraft({ name: "", keyHint: "" });
          }}
        />
      ) : null}
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
      {confirmDialog}
    </section>
  );
}

function upsertSharedGroup(groups: AdminSharedIndexGroup[], group: AdminSharedIndexGroup) {
  const next = groups.some((candidate) => candidate.id === group.id)
    ? groups.map((candidate) => (candidate.id === group.id ? group : candidate))
    : [...groups, group];
  return next.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

function profilesWithUnlinkedServers(profiles: AdminProfileSummary[]) {
  return profiles.filter((profile) => unlinkedConfiguredServers(profile).length > 0);
}

function unlinkedConfiguredServers(profile: AdminProfileSummary) {
  return configuredServerDetails(profile).filter((server) => !server.sharedIndex);
}

function adminDisplayStats(
  profiles: AdminProfileSummary[],
  sharedGroups: AdminSharedIndexGroup[],
  summary: AdminProfileListResponse["summary"] | undefined,
) {
  const sharedGroupItems = new Map(sharedGroups.map((group) => [group.id, group.indexedMediaCount]));
  const uniqueServerKeys = new Set<string>();
  const includedSharedGroups = new Set<number>();
  const unlinkedIndexedByServer = new Map<string, number>();

  for (const profile of profiles) {
    for (const server of configuredServerDetails(profile)) {
      const key = uniqueServerKey(server);
      uniqueServerKeys.add(key);
      if (server.sharedIndex) {
        includedSharedGroups.add(server.sharedIndex.id);
      } else {
        unlinkedIndexedByServer.set(key, Math.max(unlinkedIndexedByServer.get(key) ?? 0, server.indexedItems ?? 0));
      }
    }
  }

  const sharedIndexedItems = [...includedSharedGroups].reduce((sum, groupId) => {
    const fallback = profiles
      .flatMap((profile) => profile.ftpServerDetails ?? [])
      .find((server) => server.sharedIndex?.id === groupId)?.sharedIndex?.indexedMediaCount;
    return sum + (sharedGroupItems.get(groupId) ?? fallback ?? 0);
  }, 0);

  return {
    nonEmptyProfiles: profiles.filter((profile) => profile.configuredFtpServers > 0).length,
    totalProfiles: summary?.profiles ?? profiles.length,
    createdToday: profiles.filter((profile) => isToday(profile.createdAt)).length,
    uniqueServers: uniqueServerKeys.size || summary?.configuredFtpServers || 0,
    totalServers: summary?.ftpServers ?? profiles.reduce((sum, profile) => sum + profile.ftpServers, 0),
    uniqueIndexedItems: sharedIndexedItems + [...unlinkedIndexedByServer.values()].reduce((sum, value) => sum + value, 0),
    totalIndexedItems: summary?.indexedItems ?? profiles.reduce((sum, profile) => sum + profile.indexedItems, 0),
  };
}

function uniqueServerKey(server: AdminServerDetail) {
  if (server.sharedIndex) return `shared:${server.sharedIndex.id}`;
  return `server:${normalizedServerName(server.host ?? "")}:${normalizedServerName(server.name)}`;
}

function isToday(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
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

function serverSelectionKey(profileId: number, serverId: number) {
  return `${profileId}:${serverId}`;
}

type AdminServerDetail = NonNullable<AdminProfileSummary["ftpServerDetails"]>[number];

function configuredServerDetails(profile: AdminProfileSummary) {
  return (profile.ftpServerDetails ?? []).filter((server) => server.host);
}

function sharedGroupExistsForServer(groups: AdminSharedIndexGroup[], profileId: number, serverId: number) {
  return groups.some((group) => group.masterServer?.profileId === profileId && group.masterServer.serverId === serverId);
}

function serverLinkedStatus(server: AdminServerDetail) {
  if (!server.sharedIndex) return "Unlinked";
  return server.sharedIndex.autoLinked ? "Auto-L" : "Linked";
}

function serverStatusTone(status: ReturnType<typeof serverLinkedStatus>): StatusTone {
  if (status === "Auto-L") return "blue";
  if (status === "Linked") return "purple";
  return "gray";
}

function serverIndexCount(server: AdminServerDetail) {
  return server.sharedIndex ? (server.sharedIndex.indexedMediaCount ?? 0) : (server.indexedItems ?? 0);
}

function serverLinkSummary(profile: AdminProfileSummary) {
  const configured = configuredServerDetails(profile);
  const linked = configured.filter((server) => server.sharedIndex);
  if (!configured.length) return `${profile.ftpServerDetails?.length ?? 0} server${profile.ftpServerDetails?.length === 1 ? "" : "s"}`;
  return `${linked.length}/${configured.length} linked`;
}

function sharedProfileState(profile: AdminProfileSummary): "Auto-L" | "Linked" | "Partial" | null {
  const configured = configuredServerDetails(profile);
  if (!configured.length) return null;
  const linked = configured.filter((server) => server.sharedIndex);
  if (!linked.length) return null;
  if (linked.length !== configured.length) return "Partial";
  const autoLinked = linked.filter((server) => server.sharedIndex?.autoLinked);
  if (autoLinked.length === linked.length) return "Auto-L";
  if (autoLinked.length === 0) return "Linked";
  return "Partial";
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

function nextSharedScanLabel(group: AdminSharedIndexGroup) {
  if (group.scanStatus.status === "queued") return formatScanTime(group.scanStatus.queuedAt);
  if (group.scanStatus.status === "running") return "Running now";
  return formatNextScan(group.scanSchedule.nextScheduledScanAt);
}

function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}

function SharedIndexAdminSection({
  groups,
  busyGroupId,
  revealedKey,
  onUpdate,
  onRotate,
  onDelete,
  onScan,
  onOpenLinkedServers,
  editingScheduleId,
  onToggleScheduleEditor,
  onSchedule,
}: {
  groups: AdminSharedIndexGroup[];
  busyGroupId: number | "create" | null;
  revealedKey: { groupId: number; key: string } | null;
  onUpdate: (group: AdminSharedIndexGroup, patch: Partial<Pick<AdminSharedIndexGroup, "name" | "enabled" | "autoLinkImports">>) => void;
  onRotate: (group: AdminSharedIndexGroup) => void;
  onDelete: (group: AdminSharedIndexGroup) => void;
  onScan: (group: AdminSharedIndexGroup) => void;
  onOpenLinkedServers: (group: AdminSharedIndexGroup) => void;
  editingScheduleId: number | null;
  onToggleScheduleEditor: (group: AdminSharedIndexGroup) => void;
  onSchedule: (group: AdminSharedIndexGroup, intervalMinutes: number) => void;
}) {
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const skipNameBlurRef = useRef(false);

  function startEditingName(group: AdminSharedIndexGroup) {
    if (busyGroupId === group.id) return;
    skipNameBlurRef.current = false;
    setEditingNameId(group.id);
    setDraftName(group.name);
  }

  function cancelEditingName() {
    setEditingNameId(null);
    setDraftName("");
  }

  function commitEditingName(group: AdminSharedIndexGroup) {
    const nextName = draftName.trim();
    cancelEditingName();
    if (!nextName || nextName === group.name) return;
    onUpdate(group, { name: nextName });
  }

  function handleNameBlur(group: AdminSharedIndexGroup) {
    if (skipNameBlurRef.current) {
      skipNameBlurRef.current = false;
      return;
    }
    commitEditingName(group);
  }

  return (
    <section className="admin-shared-index-section" aria-labelledby="admin-shared-index-heading">
      <div className="admin-subsection-header">
        <div>
          <span className="section-label">Shared indexes</span>
          <h3 id="admin-shared-index-heading">Shared index groups</h3>
        </div>
      </div>

      {groups.length ? (
        <div className="admin-shared-grid">
          {groups.map((group) => {
            const active = group.scanStatus.status === "queued" || group.scanStatus.status === "running";
            const canDelete = !group.enabled && !active;
            const editingName = editingNameId === group.id;
            return (
              <article className="admin-shared-card" key={group.id}>
                <div className="admin-shared-card-header">
                  <div>
                    <h4>
                      {editingName ? (
                        <input
                          className="admin-shared-title-input"
                          aria-label={`Rename ${group.name}`}
                          value={draftName}
                          autoFocus
                          disabled={busyGroupId === group.id}
                          onChange={(event) => setDraftName(event.currentTarget.value)}
                          onBlur={() => handleNameBlur(group)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              skipNameBlurRef.current = true;
                              commitEditingName(group);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              skipNameBlurRef.current = true;
                              cancelEditingName();
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="admin-shared-title-button"
                          title="Rename shared index group"
                          onDoubleClick={() => startEditingName(group)}
                        >
                          {group.name}
                        </button>
                      )}
                    </h4>
                    <p>
                      {group.host}:{group.port} - {group.rootPaths.join(", ")}
                    </p>
                  </div>
                  <div className="admin-shared-top-actions">
                    <button
                      type="button"
                      className="admin-linked-count-button"
                      aria-label={`Show linked servers for ${group.name}`}
                      title={`${group.linkedServerCount} linked server${group.linkedServerCount === 1 ? "" : "s"}`}
                      disabled={busyGroupId === group.id}
                      onClick={() => onOpenLinkedServers(group)}
                    >
                      {group.linkedServerCount}
                    </button>
                    <button
                      type="button"
                      className={`admin-tag-toggle ${group.enabled ? "is-on" : "is-off"}`}
                      aria-pressed={group.enabled}
                      disabled={busyGroupId === group.id}
                      onClick={() => onUpdate(group, { enabled: !group.enabled })}
                    >
                      {group.enabled ? "Enabled" : "Disabled"}
                    </button>
                    {!group.enabled ? (
                      <button type="button" className="icon-button danger-button" title={active ? "Halt shared scan before deleting" : "Delete group"} aria-label={`Delete ${group.name}`} disabled={busyGroupId === group.id || !canDelete} onClick={() => onDelete(group)}>
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </div>
                <dl className="status-list admin-shared-stats">
                  <SummaryStat label="Items" value={group.indexedMediaCount} />
                </dl>
                <div className="admin-shared-content-grid" aria-label={`${group.name} catalog content types`}>
                  {sharedContentCells(group).map((cell) => (
                    <div key={cell.label}>
                      <span>{cell.label}</span>
                      <strong>{cell.value}</strong>
                    </div>
                  ))}
                </div>
                <div className="admin-shared-detail">
                  <span>Last scan</span>
                  <strong>{formatScanTime(group.lastIndexedAt)}</strong>
                </div>
                <div className="admin-shared-detail">
                  <span>Next scan</span>
                  <button type="button" className="admin-shared-detail-button" onClick={() => onToggleScheduleEditor(group)}>
                    {nextSharedScanLabel(group)}
                  </button>
                </div>
                {editingScheduleId === group.id ? (
                  <label className="admin-shared-schedule-editor">
                    <span>Scan interval</span>
                    <select
                      aria-label={`Scan interval for ${group.name}`}
                      value={String(group.scanSchedule.intervalMinutes)}
                      disabled={busyGroupId === group.id || !group.masterServer}
                      onChange={(event) => onSchedule(group, Number(event.currentTarget.value))}
                    >
                      <option value="0">Manual only</option>
                      <option value="360">Every 6 hours</option>
                      <option value="720">Every 12 hours</option>
                      <option value="1440">Daily</option>
                      <option value="4320">Every 3 days</option>
                      <option value="10080">Weekly</option>
                    </select>
                  </label>
                ) : null}
                <div className="admin-shared-detail">
                  <span>Master</span>
                  <strong>{group.masterServer ? `${truncateUid(group.masterServer.browserUid)} / ${group.masterServer.serverName}` : "None"}</strong>
                </div>
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
                <div className="admin-shared-actions">
                  <button
                    type="button"
                    className={`icon-button admin-icon-toggle ${group.autoLinkImports ? "is-on" : ""}`}
                    aria-pressed={group.autoLinkImports}
                    title={group.autoLinkImports ? "Auto-link imports on" : "Auto-link imports off"}
                    aria-label={`${group.autoLinkImports ? "Disable" : "Enable"} auto-link imports for ${group.name}`}
                    disabled={busyGroupId === group.id}
                    onClick={() => onUpdate(group, { autoLinkImports: !group.autoLinkImports })}
                  >
                    <Link2 size={15} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-button admin-rekey-button" title="Rekey shared index" aria-label={`Rotate key for ${group.name}`} disabled={busyGroupId === group.id} onClick={() => onRotate(group)}>
                    <RotateCcwKey size={15} aria-hidden="true" />
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

function ProfileServersDialog({
  profile,
  groups,
  selections,
  busy,
  onSelectionChange,
  onLink,
  onUnlink,
  onCreateGroup,
  onClose,
}: {
  profile: AdminProfileSummary;
  groups: AdminSharedIndexGroup[];
  selections: Record<string, string>;
  busy: boolean;
  onSelectionChange: (key: string, groupId: string) => void;
  onLink: (profileId: number, serverId: number) => void;
  onUnlink: (profileId: number, serverId: number, groupId: number) => void;
  onCreateGroup: (profile: AdminProfileSummary, server: AdminServerDetail) => void;
  onClose: () => void;
}) {
  const servers = profile.ftpServerDetails ?? [];
  return (
    <ModalPortal>
      <div className="admin-bulk-dialog-backdrop">
      <div className="admin-bulk-dialog admin-server-dialog" role="dialog" aria-modal={true} aria-labelledby="admin-server-dialog-heading">
        <div className="admin-bulk-dialog-header">
          <div>
            <span className="section-label">Servers</span>
            <h3 id="admin-server-dialog-heading">{truncateUid(profile.browserUid)}</h3>
          </div>
          <button type="button" className="icon-button" aria-label="Close server list" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="admin-server-dialog-table-wrap">
          <table className="admin-server-dialog-table">
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Host</th>
                <th scope="col">Items</th>
                <th scope="col">Last scan</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const key = serverSelectionKey(profile.id, server.id);
                const status = serverLinkedStatus(server);
                const linkedGroupId = server.sharedIndex?.id ?? null;
                const hasCreatedGroup = sharedGroupExistsForServer(groups, profile.id, server.id);
                return (
                  <tr key={server.id}>
                    <td data-label="Server">
                      <strong>{server.name}</strong>
                      <span>#{server.id}</span>
                    </td>
                    <td data-label="Host">{server.host ?? "Not configured"}</td>
                    <td data-label="Items">{serverIndexCount(server)}</td>
                    <td data-label="Last scan">{formatScanTime(server.sharedIndex ? server.sharedIndex.lastIndexedAt : server.lastIndexedAt)}</td>
                    <td data-label="Status">
                      <StatusBadge tone={serverStatusTone(status)}>{status}</StatusBadge>
                      {server.sharedIndex ? <span>{server.sharedIndex.name}</span> : null}
                    </td>
                    <td data-label="Action">
                      {linkedGroupId ? (
                        <button type="button" className="secondary-button danger-button" disabled={busy} onClick={() => onUnlink(profile.id, server.id, linkedGroupId)}>
                          Unlink
                        </button>
                      ) : (
                        <div className="admin-server-link-controls">
                          <select
                            aria-label={`Shared index group for ${server.name}`}
                            value={selections[key] ?? ""}
                            disabled={busy || !groups.length}
                            onChange={(event) => onSelectionChange(key, event.target.value)}
                          >
                            <option value="">Choose group</option>
                            {groups.map((group) => (
                              <option key={group.id} value={group.id}>
                                {group.name}
                              </option>
                            ))}
                          </select>
                          <button type="button" className="secondary-button" disabled={busy || !groups.length} onClick={() => onLink(profile.id, server.id)}>
                            Link
                          </button>
                          {!hasCreatedGroup ? (
                            <button type="button" className="secondary-button" disabled={busy || !server.host} onClick={() => onCreateGroup(profile, server)}>
                              <KeyRound size={15} aria-hidden="true" />
                              Create group
                            </button>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </ModalPortal>
  );
}

function LinkedServersDialog({
  group,
  busy,
  onUnlink,
  onClose,
}: {
  group: AdminSharedIndexGroup;
  busy: boolean;
  onUnlink: (server: AdminSharedIndexLinkedServer) => void;
  onClose: () => void;
}) {
  return (
    <ModalPortal>
      <div className="admin-bulk-dialog-backdrop">
      <div className="admin-bulk-dialog admin-linked-servers-dialog" role="dialog" aria-modal={true} aria-labelledby="admin-linked-servers-heading">
        <div className="admin-bulk-dialog-header">
          <div>
            <span className="section-label">Linked servers</span>
            <h3 id="admin-linked-servers-heading">{group.name}</h3>
          </div>
          <button type="button" className="icon-button" aria-label="Close linked servers" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {group.linkedServers.length ? (
          <div className="admin-server-dialog-table-wrap">
            <table className="admin-server-dialog-table">
              <thead>
                <tr>
                  <th scope="col">UID</th>
                  <th scope="col">Server #</th>
                  <th scope="col">Server</th>
                  <th scope="col">Role</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {group.linkedServers.map((server) => {
                  const isMaster = group.masterServer?.profileId === server.profileId && group.masterServer.serverId === server.serverId;
                  return (
                    <tr key={`${server.profileId}-${server.serverId}`}>
                      <td data-label="UID">
                        <span className="admin-linked-uid-cell">
                          <span className="admin-country-flag" aria-hidden="true">
                            {countryFlag(server.countryCode)}
                          </span>
                          <code>{truncateUid(server.browserUid)}</code>
                        </span>
                      </td>
                      <td data-label="Server #">
                        <code>{server.serverId}</code>
                      </td>
                      <td data-label="Server">
                        <strong>{server.serverName}</strong>
                      </td>
                      <td data-label="Role">
                        <StatusBadge tone={isMaster ? "blue" : "purple"}>{isMaster ? "Master" : "Linked"}</StatusBadge>
                      </td>
                      <td data-label="Action">
                        {isMaster ? null : (
                          <button type="button" className="admin-inline-danger-link" disabled={busy} onClick={() => onUnlink(server)}>
                            Unlink
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="admin-empty-value">No linked servers.</p>
        )}
      </div>
      </div>
    </ModalPortal>
  );
}

function CreateSharedGroupDialog({
  target,
  draft,
  busy,
  onDraftChange,
  onCreate,
  onClose,
}: {
  target: CreateSharedGroupTarget;
  draft: { name: string; keyHint: string };
  busy: boolean;
  onDraftChange: (patch: Partial<{ name: string; keyHint: string }>) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <ModalPortal>
      <div className="admin-bulk-dialog-backdrop">
      <div className="admin-bulk-dialog admin-create-shared-dialog" role="dialog" aria-modal={true} aria-labelledby="admin-create-shared-heading">
        <div className="admin-bulk-dialog-header">
          <div>
            <span className="section-label">Create group</span>
            <h3 id="admin-create-shared-heading">{target.serverName}</h3>
          </div>
          <button type="button" className="icon-button" aria-label="Close create group" disabled={busy} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="admin-bulk-link-summary">
          {truncateUid(target.profileUid)} / {target.host ?? "No host configured"} / server #{target.serverId}
        </p>
        <label className="field-stack">
          <span>Group name</span>
          <input
            aria-label="Shared group name"
            value={draft.name}
            disabled={busy}
            autoFocus
            onChange={(event) => onDraftChange({ name: event.currentTarget.value })}
          />
        </label>
        <label className="field-stack">
          <span>Key hint</span>
          <input
            aria-label="Shared key hint"
            value={draft.keyHint}
            disabled={busy}
            placeholder="Generated from name"
            onChange={(event) => onDraftChange({ keyHint: event.currentTarget.value })}
          />
        </label>
        <div className="admin-bulk-link-footer">
          <button type="button" className="secondary-button" disabled={busy || !draft.name.trim()} onClick={onCreate}>
            <KeyRound size={15} aria-hidden="true" />
            {busy ? "Creating..." : "Create group"}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
      </div>
    </ModalPortal>
  );
}

function sharedContentCells(group: AdminSharedIndexGroup) {
  return [
    { label: "Movie", value: group.catalogItemCounts.movies },
    { label: "Anime", value: group.catalogItemCounts.anime },
    { label: "Series", value: group.catalogItemCounts.series },
    { label: "Other", value: group.catalogItemCounts.uncategorized },
  ];
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
    <ModalPortal>
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
    </ModalPortal>
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
    <ModalPortal>
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
        {result?.errors.length ? (
          <ul className="admin-bulk-link-errors" aria-label="Link failures">
            {result.errors.map((error, index) => (
              <li key={`${error.profileUid}-${error.serverName}-${index}`}>
                <strong>{error.serverName}</strong>
                <span>{truncateUid(error.profileUid)}</span>
                <em>{error.message}</em>
              </li>
            ))}
          </ul>
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
    </ModalPortal>
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
    case "lastManifestAccessedAt":
      return profile.lastManifestAccessedAt ? Date.parse(profile.lastManifestAccessedAt) : 0;
    case "state":
      return profileStateLabel(profile);
  }
}

function SummaryStat({ label, value, title }: { label: string; value: number; title?: string }) {
  return (
    <div title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ProfileStateBadge({ profile }: { profile: AdminProfileSummary }) {
  const label = profileStateLabel(profile);
  const tone = profileStateTone(label);
  const sharedState = sharedProfileState(profile);
  return (
    <span className="admin-state-stack">
      <StatusBadge tone={tone}>{label}</StatusBadge>
      {sharedState && sharedState !== label ? <StatusBadge tone={profileStateTone(sharedState)}>{sharedState}</StatusBadge> : null}
    </span>
  );
}

function profileStateTone(label: string): StatusTone {
  if (label === "Auto-L") return "blue";
  if (label === "Linked") return "purple";
  if (label === "Partial" || label === "Pending") return "amber";
  if (label === "Scanning" || label === "Indexed") return "green";
  return "gray";
}

function profileStateLabel(profile: AdminProfileSummary) {
  if (profile.activeScans > 0) return "Scanning";
  if (profile.pendingScans > 0) return "Pending";
  const sharedState = sharedProfileState(profile);
  if (sharedState) return sharedState;
  if (profile.indexedItems > 0) return "Indexed";
  if (profile.configuredFtpServers > 0) return "Configured";
  return "Empty";
}

function AdminState({ profile }: { profile: AdminProfileSummary }) {
  if (profile.superAdminEnabled || profile.adminSource === "environment") {
    return (
      <span className="admin-role-icon admin-role-super" title="Super admin" aria-label="Super admin">
        <Crown size={16} aria-hidden="true" />
      </span>
    );
  }
  if (profile.adminEnabled) {
    return (
      <span className="admin-role-icon admin-role-admin" title="Admin" aria-label="Admin">
        <ShieldCheck size={16} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="admin-role-icon admin-role-user" title="User" aria-label="User">
      <User size={16} aria-hidden="true" />
    </span>
  );
}
