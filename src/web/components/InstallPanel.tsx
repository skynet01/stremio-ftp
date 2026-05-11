import { Copy, Download, Upload, X } from "lucide-react";
import { useRef } from "react";
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
  importStatusMessage,
  importLoaded,
  exportStripCredentials,
  onRecoveryUidChange,
  onPassphraseChange,
  onCreateProfile,
  onUnlockProfile,
  onImportSettings,
  onClearImportedSettings,
  onExportSettings,
  onExportStripCredentialsChange,
}: {
  profileReady: boolean;
  manifestUrl: string | null;
  stremioInstallUrl: string | null;
  profileMessage: string;
  profileState: ProfileState;
  recoveryUid: string;
  passphrase: string;
  importStatusMessage?: string | null;
  importLoaded?: boolean;
  exportStripCredentials?: boolean;
  onRecoveryUidChange: (value: string) => void;
  onPassphraseChange: (value: string) => void;
  onCreateProfile: () => void;
  onUnlockProfile: () => void;
  onImportSettings?: (file: File) => void;
  onClearImportedSettings?: () => void;
  onExportSettings?: () => void;
  onExportStripCredentialsChange?: (value: boolean) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file && onImportSettings) onImportSettings(file);
    event.currentTarget.value = "";
  };
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
          {onExportSettings ? (
            <div className="settings-export-row">
              <button type="button" className="secondary-button" onClick={onExportSettings}>
                <Download size={16} aria-hidden={true} />
                Export settings
              </button>
              <label className="toggle-row settings-export-strip" htmlFor="exportStripCreds">
                <input
                  id="exportStripCreds"
                  type="checkbox"
                  checked={Boolean(exportStripCredentials)}
                  onChange={(event) => onExportStripCredentialsChange?.(event.currentTarget.checked)}
                />
                Strip username &amp; password
              </label>
            </div>
          ) : null}
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
          <div className="button-row install-button-row">
            {onImportSettings ? (
              <div className="settings-import-cluster">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="visually-hidden"
                  onChange={handleImportFile}
                />
                {importLoaded ? (
                  <button type="button" className="text-link" onClick={onClearImportedSettings}>
                    <X size={14} aria-hidden={true} />
                    Clear imported settings
                  </button>
                ) : (
                  <button type="button" className="text-link" onClick={() => fileInputRef.current?.click()}>
                    <Upload size={14} aria-hidden={true} />
                    Import settings
                  </button>
                )}
                {importStatusMessage ? <span className="settings-import-status">{importStatusMessage}</span> : null}
              </div>
            ) : (
              <span className="settings-import-cluster" aria-hidden="true" />
            )}
            <div className="install-button-group">
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
                disabled={profileState === "creating" || Boolean(importLoaded)}
                title={importLoaded ? "Unlock is unavailable while imported settings are staged" : undefined}
                onClick={onUnlockProfile}
              >
                Unlock profile
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
