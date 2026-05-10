import { Copy } from "lucide-react";
import { StatusBadge } from "./ui.js";

type ProfileState = "new" | "creating" | "created" | "unlocked" | "error";

export function Topbar({
  addonName,
  addonLogoUrl,
  editable,
  profileReady,
  profileState,
  recoveryUid,
  onEditLogo,
  onLogout,
}: {
  addonName: string;
  addonLogoUrl: string;
  editable: boolean;
  profileReady: boolean;
  profileState: ProfileState;
  recoveryUid?: string;
  onEditLogo: () => void;
  onLogout?: () => void;
}) {
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
        <StatusBadge tone={profileReady ? "green" : "gray"}>
          {profileState === "created" ? "Ready to install" : profileState === "unlocked" ? "Unlocked" : "Not installed"}
        </StatusBadge>
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

function shortUid(uid: string) {
  if (uid.length <= 12) return uid;
  return `${uid.slice(0, 4)}…${uid.slice(-4)}`;
}
