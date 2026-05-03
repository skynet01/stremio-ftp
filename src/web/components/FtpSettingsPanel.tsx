import type { AddonCustomization } from "../api.js";
import { field, filledClass } from "./ui.js";

type TlsMode = "none" | "explicit" | "implicit";
type LibraryLayout = "auto" | "folders" | "flat";
type StreamDeliveryMode = "proxy" | "direct";
type CatalogContentTypes = NonNullable<AddonCustomization["catalogContentTypes"]>;

export function FtpSettingsPanel({
  host,
  port,
  username,
  password,
  tlsMode,
  allowInvalidCertificate,
  rootPaths,
  catalogTmdbApiKey,
  libraryLayout,
  streamDeliveryMode,
  catalogContentTypes,
  catalogEnabled,
  profileReady,
  indexState,
  onHostChange,
  onPortChange,
  onUsernameChange,
  onPasswordChange,
  onTlsModeChange,
  onAllowInvalidCertificateChange,
  onRootPathsChange,
  onCatalogTmdbApiKeyChange,
  onCommitCatalogTmdbApiKey,
  onLibraryLayoutChange,
  onStreamDeliveryModeChange,
  onCatalogContentTypeChange,
  onCatalogEnabledChange,
  onTestConnection,
  onSaveFtp,
}: {
  host: string;
  port: string;
  username: string;
  password: string;
  tlsMode: string;
  allowInvalidCertificate: boolean;
  rootPaths: string;
  catalogTmdbApiKey: string;
  libraryLayout: LibraryLayout;
  streamDeliveryMode: StreamDeliveryMode;
  catalogContentTypes: CatalogContentTypes;
  catalogEnabled: boolean;
  profileReady: boolean;
  indexState: "idle" | "working" | "ready" | "error";
  onHostChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onTlsModeChange: (value: TlsMode) => void;
  onAllowInvalidCertificateChange: (value: boolean) => void;
  onRootPathsChange: (value: string) => void;
  onCatalogTmdbApiKeyChange: (value: string) => void;
  onCommitCatalogTmdbApiKey: () => void;
  onLibraryLayoutChange: (value: LibraryLayout) => void;
  onStreamDeliveryModeChange: (value: StreamDeliveryMode) => void;
  onCatalogContentTypeChange: (key: keyof CatalogContentTypes, enabled: boolean) => void;
  onCatalogEnabledChange: (enabled: boolean) => void;
  onTestConnection: () => void;
  onSaveFtp: () => void;
}) {
  return (
    <section className="panel ftp-panel" aria-labelledby="ftp-heading">
      <div className="panel-header">
        <div>
          <span className="section-label">Source</span>
          <h2 id="ftp-heading">FTP settings</h2>
          <p>Add the server, choose the folders to scan, then save it to your profile.</p>
        </div>
      </div>
      <form className="ftp-form">
        <div className="field-grid ftp-field-grid">
          {field(
            "Host",
            "host",
            <input
              id="host"
              className={filledClass(host)}
              value={host}
              onChange={(event) => onHostChange(event.currentTarget.value)}
              placeholder="ftp.example.com"
            />,
            "field-stack host-field",
          )}
          {field(
            "Port",
            "port",
            <input
              id="port"
              inputMode="numeric"
              className={filledClass(port)}
              value={port}
              onChange={(event) => onPortChange(event.currentTarget.value)}
            />,
            "field-stack port-field",
          )}
          {field(
            "Username",
            "username",
            <input
              id="username"
              className={filledClass(username)}
              value={username}
              autoComplete="username"
              onChange={(event) => onUsernameChange(event.currentTarget.value)}
            />,
            "field-stack username-field",
          )}
          {field(
            "Password",
            "password",
            <input
              id="password"
              type="password"
              className={filledClass(password)}
              value={password}
              autoComplete="new-password"
              onChange={(event) => onPasswordChange(event.currentTarget.value)}
              placeholder="FTP account password"
            />,
            "field-stack password-field",
          )}
          <div className="field-stack tls-field">
            <label htmlFor="tlsMode">TLS mode</label>
            <select
              id="tlsMode"
              className={filledClass(tlsMode)}
              value={tlsMode}
              onChange={(event) => onTlsModeChange(event.currentTarget.value as TlsMode)}
            >
              <option value="none">Disabled</option>
              <option value="explicit">Explicit TLS</option>
              <option value="implicit">Implicit TLS</option>
            </select>
            <label className="toggle-row compact-toggle-row" htmlFor="allowInvalidCertificate">
              <input
                id="allowInvalidCertificate"
                type="checkbox"
                checked={allowInvalidCertificate}
                onChange={(event) => onAllowInvalidCertificateChange(event.currentTarget.checked)}
              />
              Allow invalid certificate
            </label>
          </div>
          {field(
            "Root paths",
            "rootPaths",
            <textarea
              id="rootPaths"
              className={filledClass(rootPaths)}
              value={rootPaths}
              onChange={(event) => onRootPathsChange(event.currentTarget.value)}
              rows={4}
            />,
            "field-stack root-paths-field",
          )}
        </div>
        <LibrarySettings
          catalogTmdbApiKey={catalogTmdbApiKey}
          libraryLayout={libraryLayout}
          streamDeliveryMode={streamDeliveryMode}
          catalogContentTypes={catalogContentTypes}
          catalogEnabled={catalogEnabled}
          onCatalogTmdbApiKeyChange={onCatalogTmdbApiKeyChange}
          onCommitCatalogTmdbApiKey={onCommitCatalogTmdbApiKey}
          onLibraryLayoutChange={onLibraryLayoutChange}
          onStreamDeliveryModeChange={onStreamDeliveryModeChange}
          onCatalogContentTypeChange={onCatalogContentTypeChange}
          onCatalogEnabledChange={onCatalogEnabledChange}
        />
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            disabled={!profileReady || indexState === "working"}
            onClick={onTestConnection}
          >
            Test connection
          </button>
          <button
            type="button"
            className="primary-button"
            aria-label="Save FTP settings"
            disabled={!profileReady || indexState === "working"}
            onClick={onSaveFtp}
          >
            Save FTP settings
          </button>
        </div>
      </form>
    </section>
  );
}

function LibrarySettings({
  catalogTmdbApiKey,
  libraryLayout,
  streamDeliveryMode,
  catalogContentTypes,
  catalogEnabled,
  onCatalogTmdbApiKeyChange,
  onCommitCatalogTmdbApiKey,
  onLibraryLayoutChange,
  onStreamDeliveryModeChange,
  onCatalogContentTypeChange,
  onCatalogEnabledChange,
}: {
  catalogTmdbApiKey: string;
  libraryLayout: LibraryLayout;
  streamDeliveryMode: StreamDeliveryMode;
  catalogContentTypes: CatalogContentTypes;
  catalogEnabled: boolean;
  onCatalogTmdbApiKeyChange: (value: string) => void;
  onCommitCatalogTmdbApiKey: () => void;
  onLibraryLayoutChange: (value: LibraryLayout) => void;
  onStreamDeliveryModeChange: (value: StreamDeliveryMode) => void;
  onCatalogContentTypeChange: (key: keyof CatalogContentTypes, enabled: boolean) => void;
  onCatalogEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="library-settings">
      <div className="library-settings-header">
        <h3>Library settings</h3>
      </div>
      <div className="library-settings-grid">
        {field(
          "TMDB API key",
          "catalogTmdbApiKey",
          <input
            id="catalogTmdbApiKey"
            className={filledClass(catalogTmdbApiKey)}
            value={catalogTmdbApiKey}
            placeholder="Use server default"
            onChange={(event) => onCatalogTmdbApiKeyChange(event.currentTarget.value)}
            onBlur={onCommitCatalogTmdbApiKey}
          />,
        )}
        {field(
          "Library layout",
          "libraryLayout",
          <select
            id="libraryLayout"
            className={filledClass(libraryLayout)}
            value={libraryLayout}
            onChange={(event) => onLibraryLayoutChange(event.currentTarget.value as LibraryLayout)}
          >
            <option value="auto">Auto detect</option>
            <option value="folders">Organized by folders</option>
            <option value="flat">Single folder of files</option>
          </select>,
        )}
        {field(
          "Stream delivery",
          "streamDeliveryMode",
          <select
            id="streamDeliveryMode"
            className={filledClass(streamDeliveryMode)}
            value={streamDeliveryMode}
            onChange={(event) => onStreamDeliveryModeChange(event.currentTarget.value as StreamDeliveryMode)}
          >
            <option value="proxy">Proxy through addon</option>
            <option value="direct">Direct FTP URL</option>
          </select>,
        )}
        <div className="content-type-options" role="group" aria-label="Server content types">
          <div className="server-content-row">
            <span className="field-label">Server content</span>
            <div className="server-content-toggles">
              <label className="toggle-row" htmlFor="catalogMovies">
                <input
                  id="catalogMovies"
                  type="checkbox"
                  checked={catalogContentTypes.movies}
                  onChange={(event) => onCatalogContentTypeChange("movies", event.currentTarget.checked)}
                />
                Movies
              </label>
              <label className="toggle-row" htmlFor="catalogSeries">
                <input
                  id="catalogSeries"
                  type="checkbox"
                  checked={catalogContentTypes.series}
                  onChange={(event) => onCatalogContentTypeChange("series", event.currentTarget.checked)}
                />
                Series
              </label>
              <label className="toggle-row" htmlFor="catalogAnime">
                <input
                  id="catalogAnime"
                  type="checkbox"
                  checked={catalogContentTypes.anime}
                  onChange={(event) => onCatalogContentTypeChange("anime", event.currentTarget.checked)}
                />
                Anime
              </label>
            </div>
          </div>
          <label className="toggle-row catalog-toggle" htmlFor="catalogEnabled">
            <input
              id="catalogEnabled"
              type="checkbox"
              checked={catalogEnabled}
              onChange={(event) => onCatalogEnabledChange(event.currentTarget.checked)}
            />
            Show indexed FTP catalog in Stremio
          </label>
        </div>
      </div>
      {streamDeliveryMode === "direct" ? (
        <p className="direct-stream-warning">
          Direct FTP sends FTP URLs to Stremio clients. Some clients may not support it, and credentials can be visible in the stream URL,
          but playback no longer depends on the addon server bandwidth.
        </p>
      ) : null}
    </div>
  );
}
