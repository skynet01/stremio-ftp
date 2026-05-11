import { Copy, Trash2 } from "lucide-react";
import { StatusBadge } from "./ui.js";

type ProfileState = "new" | "creating" | "created" | "unlocked" | "error";

export function Topbar({
  addonName,
  addonLogoUrl,
  editable,
  profileReady,
  recoveryUid,
  manifestReady,
  onEditLogo,
  onLogout,
  onDeleteProfile,
}: {
  addonName: string;
  addonLogoUrl: string;
  editable: boolean;
  profileReady: boolean;
  profileState?: ProfileState;
  recoveryUid?: string;
  manifestReady?: boolean;
  onEditLogo: () => void;
  onLogout?: () => void;
  onDeleteProfile?: () => void;
}) {
  const badge = badgeFor(profileReady, Boolean(manifestReady));
  return (
    <header className="topbar">
      <div className="brand-lockup">
        {editable ? (
          <button
            type="button"
            className="brand-mark"
            aria-label="Edit addon avatar"
            style={addonLogoUrl ? { backgroundImage: `url(${addonLogoUrl})` } : undefined}
            onClick={onEditLogo}
          >
            {addonLogoUrl ? <span className="visually-hidden">Addon avatar</span> : "TVA"}
          </button>
        ) : (
          <div className="brand-mark" style={addonLogoUrl ? { backgroundImage: `url(${addonLogoUrl})` } : undefined} aria-hidden="true">
            {addonLogoUrl ? null : "TVA"}
          </div>
        )}
        <div>
          <p className="brand-title">{addonName}</p>
          <p>Configure your private Stremio source</p>
        </div>
      </div>
      <div className="topbar-actions">
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {profileReady && onDeleteProfile ? (
          <button type="button" className="icon-button topbar-delete" aria-label="Delete profile" title="Delete profile" onClick={onDeleteProfile}>
            <Trash2 size={16} aria-hidden={true} />
          </button>
        ) : null}
        {profileReady && recoveryUid ? (
          <span className="topbar-uid" title={recoveryUid}>
            <span className="topbar-uid-label">UID</span>
            <code>{shortUid(recoveryUid)}</code>
            <button
              type="button"
              className="icon-button topbar-uid-copy"
              aria-label="Copy recovery UID"
              onClick={() => void navigator.clipboard?.writeText(recoveryUid)}
            >
              <Copy size={14} aria-hidden={true} />
            </button>
          </span>
        ) : null}
        {profileReady && onLogout ? (
          <button type="button" className="secondary-button topbar-logout" onClick={onLogout}>
            Log out
          </button>
        ) : null}
      </div>
    </header>
  );
}

function badgeFor(profileReady: boolean, manifestReady: boolean): { tone: "green" | "gray"; label: string } {
  if (profileReady && manifestReady) return { tone: "green", label: "Ready to install" };
  if (profileReady) return { tone: "gray", label: "Unlocked" };
  return { tone: "gray", label: "Not installed" };
}

function shortUid(uid: string) {
  if (uid.length <= 12) return uid;
  return `${uid.slice(0, 4)}…${uid.slice(-4)}`;
}
