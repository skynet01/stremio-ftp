import { Copy } from "lucide-react";
import { field, filledClass, Notice } from "./ui.js";

type ProfileState = "new" | "creating" | "created" | "unlocked" | "error";

export function InstallPanel({
  profileReady,
  manifestUrl,
  stremioInstallUrl,
  profileMessage,
  profileState,
  recoveryUid,
  passphrase,
  onRecoveryUidChange,
  onPassphraseChange,
  onCreateProfile,
  onUnlockProfile,
}: {
  profileReady: boolean;
  manifestUrl: string | null;
  stremioInstallUrl: string | null;
  profileMessage: string;
  profileState: ProfileState;
  recoveryUid: string;
  passphrase: string;
  onRecoveryUidChange: (value: string) => void;
  onPassphraseChange: (value: string) => void;
  onCreateProfile: () => void;
  onUnlockProfile: () => void;
}) {
  return (
    <section className="panel install-panel" aria-labelledby="install-heading">
      <div className="panel-header">
        <div>
          <span className="section-label">Install</span>
          <h2 id="install-heading">{profileReady ? "Manifest" : "Profile setup"}</h2>
          <p>
            {profileReady
              ? "Use this private manifest URL in Stremio."
              : "Enter your passphrase once. This browser will load the profile automatically next time."}
          </p>
        </div>
      </div>
      {profileReady ? (
        <>
          {manifestUrl ? (
            <div className="manifest-url">
              <span>Manifest URL</span>
              <div className="inline-control">
                <code>{manifestUrl}</code>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Copy manifest URL"
                  onClick={() => void navigator.clipboard?.writeText(manifestUrl)}
                >
                  <Copy size={18} aria-hidden={true} />
                </button>
              </div>
            </div>
          ) : null}
          <div className="install-action-row">
            <Notice className="install-notice">{profileMessage}</Notice>
            {stremioInstallUrl ? (
              <a className="primary-button button-link" href={stremioInstallUrl}>
                Install in Stremio
              </a>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="profile-grid">
            {field(
              "Recovery UID",
              "recoveryUid",
              <div className="inline-control">
                <input
                  id="recoveryUid"
                  className={filledClass(recoveryUid)}
                  value={recoveryUid}
                  onChange={(event) => onRecoveryUidChange(event.currentTarget.value)}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Copy recovery UID"
                  onClick={() => void navigator.clipboard?.writeText(recoveryUid)}
                >
                  <Copy size={18} aria-hidden={true} />
                </button>
              </div>,
            )}
            {field(
              "Passphrase",
              "passphrase",
              <input
                id="passphrase"
                type="password"
                className={filledClass(passphrase)}
                value={passphrase}
                autoComplete="current-password"
                onChange={(event) => onPassphraseChange(event.currentTarget.value)}
                placeholder="Minimum 8 characters"
              />,
            )}
          </div>
          <Notice>{profileMessage}</Notice>
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              aria-label="Create profile"
              disabled={profileState === "creating"}
              onClick={onCreateProfile}
            >
              {profileState === "creating" ? "Working..." : "Create profile"}
            </button>
            <button
              type="button"
              className="secondary-button"
              aria-label="Unlock profile"
              disabled={profileState === "creating"}
              onClick={onUnlockProfile}
            >
              Unlock profile
            </button>
          </div>
        </>
      )}
    </section>
  );
}
