import { useEffect, useState } from "react";
import { Copy, Link2, RefreshCw, Search, Shield, ShieldCheck, Trash2 } from "lucide-react";
import {
  bulkAdminProfiles,
  deleteAdminProfile,
  issueAdminManifestToken,
  loadAdminProfiles,
  rescanAdminProfile,
  setAdminProfileEnabled,
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

  async function runBulkAction(action: "delete" | "rescan" | "convert_to_proxy") {
    const profileIds = profiles.filter((profile) => selectedProfileIds.has(profile.id)).map((profile) => profile.id);
    if (!profileIds.length) return;
    if (action === "delete") {
      const confirmed = window.confirm(`Delete ${profileIds.length} selected profiles? This removes their FTP servers, indexed files, and manifest URLs.`);
      if (!confirmed) return;
    }

    setBulkBusy(true);
    try {
      await bulkAdminProfiles({ browserUid, passphrase, profileIds, action });
      if (action === "delete") setSelectedProfileIds(new Set());
      setMessage(bulkActionMessage(action, profileIds.length));
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
  const visibleSelectedCount = visibleProfiles.filter((profile) => selectedProfileIds.has(profile.id)).length;
  const selectedCount = profiles.filter((profile) => selectedProfileIds.has(profile.id)).length;
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
              <button type="button" className="secondary-button" disabled={bulkBusy} onClick={() => void runBulkAction("rescan")}>
                Rescan selected
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

function bulkActionMessage(action: "delete" | "rescan" | "convert_to_proxy", count: number) {
  if (action === "delete") return `Deleted ${count} selected profiles.`;
  if (action === "rescan") return `Queued rescans for ${count} selected profiles.`;
  return `Converted ${count} selected profiles and their FTP servers to proxy streaming.`;
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
