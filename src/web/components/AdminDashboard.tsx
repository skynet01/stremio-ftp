import { useEffect, useState } from "react";
import { CircleStop, Copy, Link2, RefreshCw, Search, Shield, ShieldCheck, Trash2, X } from "lucide-react";
import {
  bulkAdminProfiles,
  deleteAdminProfile,
  issueAdminManifestToken,
  loadAdminProfiles,
  rescanAdminProfile,
  setAdminProfileEnabled,
  type AdminBulkProfileAction,
  type AdminBulkProfilesResponse,
  type AdminProfileListResponse,
  type AdminProfileSummary,
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

export function AdminDashboard({ browserUid, passphrase }: AdminDashboardProps) {
  const [data, setData] = useState<AdminProfileListResponse | null>(null);
  const [message, setMessage] = useState("Loading admin profile list...");
  const [loading, setLoading] = useState(false);
  const [busyProfileId, setBusyProfileId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<AdminBulkProfilesResponse | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<number>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<AdminSort | null>(null);

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

  useEffect(() => {
    void refreshProfiles();
  }, [browserUid, passphrase]);

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
        <button type="button" className="secondary-button" disabled={loading} onClick={() => void refreshProfiles()}>
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
                      {profile.configuredFtpServers}/{profile.ftpServers}
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
      {bulkResult ? <BulkActionDialog result={bulkResult} profiles={profiles} onClose={() => setBulkResult(null)} /> : null}
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
