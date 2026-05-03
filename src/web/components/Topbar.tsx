import { StatusBadge } from "./ui.js";

type ProfileState = "new" | "creating" | "created" | "unlocked" | "error";

export function Topbar({
  addonName,
  addonLogoUrl,
  profileReady,
  profileState,
  onEditLogo,
}: {
  addonName: string;
  addonLogoUrl: string;
  profileReady: boolean;
  profileState: ProfileState;
  onEditLogo: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <button
          type="button"
          className="brand-mark"
          aria-label="Edit addon avatar"
          style={addonLogoUrl ? { backgroundImage: `url(${addonLogoUrl})` } : undefined}
          onClick={onEditLogo}
        >
          {addonLogoUrl ? <span className="visually-hidden">Addon avatar</span> : "TVA"}
        </button>
        <div>
          <p className="brand-title">{addonName}</p>
          <p>Configure your private Stremio source</p>
        </div>
      </div>
      <StatusBadge tone={profileReady ? "green" : "gray"}>
        {profileState === "created" ? "Ready to install" : profileState === "unlocked" ? "Unlocked" : "Not installed"}
      </StatusBadge>
    </header>
  );
}
