import { useEffect, useState } from "react";
import { Copy, Link2, RefreshCw, Search, Shield, ShieldCheck, Trash2 } from "lucide-react";
import {
  deleteAdminProfile,
  issueAdminManifestToken,
  loadAdminProfiles,
  setAdminProfileEnabled,
  type AdminProfileListResponse,
  type AdminProfileSummary,
} from "../api.js";
import { Notice, formatScanTime, StatusBadge } from "./ui.js";

type AdminDashboardProps = {
  browserUid: string;
  passphrase: string;
};

export function AdminDashboard({ browserUid, passphrase }: AdminDashboardProps) {
  const [data, setData] = useState<AdminProfileListResponse | null>(null);
  const [message, setMessage] = useState("Loading admin profile list...");
  const [loading, setLoading] = useState(false);
  const [busyProfileId, setBusyProfileId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  async function refreshProfiles() {
    setLoading(true);
    setMessage("Loading admin profile list...");
    try {
      const loaded = await loadAdminProfiles({ browserUid, passphrase });
      setData(loaded);
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
          <div className="admin-profile-table-wrap">
          <table className="admin-profile-table">
            <thead>
              <tr>
                <th scope="col">Recovery UID</th>
                <th scope="col">Country</th>
                <th scope="col">Admin</th>
                <th scope="col">Servers</th>
                <th scope="col">Indexed</th>
                <th scope="col">Last scan</th>
                <th scope="col">State</th>
                <th scope="col">Manifest</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredProfiles.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    <code>{profile.browserUid}</code>
                    <span>Created {formatScanTime(profile.createdAt)}</span>
                  </td>
                  <td>
                    <span className="admin-country-code">{profile.lastCountryCode ?? "Unknown"}</span>
                  </td>
                  <td>
                    <AdminState profile={profile} />
                  </td>
                  <td>
                    {profile.configuredFtpServers}/{profile.ftpServers}
                  </td>
                  <td>{profile.indexedItems}</td>
                  <td>{formatScanTime(profile.lastScanAt)}</td>
                  <td>
                    <ProfileStateBadge profile={profile} />
                  </td>
                  <td>
                    {profile.manifestUrl ? (
                      <button
                        type="button"
                        className="secondary-button admin-manifest-copy"
                        onClick={() => void navigator.clipboard?.writeText(profile.manifestUrl!)}
                      >
                        <Copy size={14} aria-hidden="true" />
                        Copy URL
                      </button>
                    ) : (
                      <span className="admin-empty-value">Not issued</span>
                    )}
                  </td>
                  <td>
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

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ProfileStateBadge({ profile }: { profile: AdminProfileSummary }) {
  if (profile.activeScans > 0) return <StatusBadge tone="green">Scanning</StatusBadge>;
  if (profile.pendingScans > 0) return <StatusBadge tone="amber">Pending</StatusBadge>;
  if (profile.indexedItems > 0) return <StatusBadge tone="green">Indexed</StatusBadge>;
  if (profile.configuredFtpServers > 0) return <StatusBadge tone="gray">Configured</StatusBadge>;
  return <StatusBadge tone="gray">Empty</StatusBadge>;
}

function AdminState({ profile }: { profile: AdminProfileSummary }) {
  if (profile.adminSource === "environment") return <StatusBadge tone="green">Env admin</StatusBadge>;
  if (profile.adminEnabled) return <StatusBadge tone="green">Admin</StatusBadge>;
  return <StatusBadge tone="gray">User</StatusBadge>;
}
