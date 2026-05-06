import { ChevronRight, CircleStop, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AddonCustomization, ConnectionStatus, IndexStatus, ScanSchedule, ScanStatus } from "../api.js";
import {
  field,
  filledClass,
  formatConnectionStatus,
  formatEta,
  formatNextScan,
  formatScanTime,
  Notice,
  scanIsActive,
  StatusBadge,
  type StatusTone,
} from "./ui.js";

type TlsMode = "none" | "explicit" | "implicit";
type LibraryLayout = "auto" | "folders" | "flat";
type StreamDeliveryMode = "proxy" | "direct";
type CatalogContentTypes = NonNullable<AddonCustomization["catalogContentTypes"]>;

export type ServerForm = {
  id: number;
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  passwordConfigured: boolean;
  tlsMode: TlsMode;
  allowInvalidCertificate: boolean;
  rootPaths: string;
  catalogEnabled: boolean;
  catalogContentTypes: CatalogContentTypes;
  libraryLayout: LibraryLayout;
  streamDeliveryMode: StreamDeliveryMode;
  indexStatus: IndexStatus;
  scanStatus: ScanStatus;
  scanSchedule: ScanSchedule;
  connectionStatus: ConnectionStatus;
  pendingScanAfter: string | null;
  message: string;
};

function serverSummary(server: ServerForm) {
  if (server.scanStatus.status === "queued") return "Queued for indexing";
  if (server.scanStatus.status === "running") {
    const path = server.scanStatus.currentPath ? ` - ${server.scanStatus.currentPath}` : "";
    return `${server.scanStatus.progressPercent}% scanning${path}`;
  }
  if (server.scanStatus.status === "failed") {
    const reason = server.scanStatus.error || server.scanStatus.message || "Scan failed";
    return server.pendingScanAfter ? `${reason} - retry pending` : reason;
  }
  return `${server.indexStatus.mediaItems} items - Last scan ${formatCompactScanTime(server.indexStatus.lastScanAt)}`;
}

function formatCompactScanTime(lastScanAt: string | null) {
  if (!lastScanAt) return "Never";
  const date = new Date(lastScanAt);
  if (Number.isNaN(date.getTime())) return lastScanAt;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function serverBadge(server: ServerForm): { tone: StatusTone; label: string } {
  if (server.scanStatus.status === "queued") return { tone: "amber", label: "Queued" };
  if (server.scanStatus.status === "running") return { tone: "amber", label: "Scanning" };
  if (server.scanStatus.status === "failed" && server.pendingScanAfter) return { tone: "amber", label: "Retry pending" };
  if (server.pendingScanAfter) return { tone: "amber", label: "Pending" };
  if (server.scanStatus.status === "failed") return { tone: "red", label: "Needs attention" };
  if (server.indexStatus.lastScanAt) return { tone: "green", label: "Ready" };
  return { tone: "gray", label: "Idle" };
}

function scanProgressLabel(scanStatus: ScanStatus) {
  if (scanStatus.status === "idle") return "No active scan";
  if (scanStatus.message?.startsWith("Enriching TMDB metadata")) return scanStatus.message;
  return scanStatus.status;
}

export function ServerAccordion({
  servers,
  expandedServerId,
  profileReady,
  onToggle,
  onAddServer,
  onDeleteServer,
  onServerChange,
  onSaveServer,
  onTestServer,
  onRefreshServer,
  onCancelServer,
  onUpdateScanSchedule,
}: {
  servers: ServerForm[];
  expandedServerId: number | null;
  profileReady: boolean;
  onToggle: (serverId: number) => void;
  onAddServer: () => void;
  onDeleteServer: (serverId: number) => void;
  onServerChange: (serverId: number, patch: Partial<ServerForm>) => void;
  onSaveServer: (serverId: number) => void;
  onTestServer: (serverId: number) => void;
  onRefreshServer: (serverId: number) => void;
  onCancelServer: (serverId: number) => void;
  onUpdateScanSchedule: (serverId: number, intervalMinutes: number) => void;
}) {
  return (
    <section className="panel server-accordion-panel" aria-labelledby="servers-heading">
      <div className="panel-header">
        <div>
          <span className="section-label">FTP servers</span>
          <h2 id="servers-heading">Servers</h2>
          <p>Each server has its own FTP, library, scan, and stream settings.</p>
        </div>
        <button type="button" className="secondary-button" disabled={!profileReady} onClick={onAddServer}>
          <Plus size={17} aria-hidden={true} />
          Add server
        </button>
      </div>
      <div className="server-accordion-list">
        {servers.map((server, index) => {
          const expanded = expandedServerId === server.id;
          const active = scanIsActive(server.scanStatus);
          const badge = serverBadge(server);
          const triggerId = `server-trigger-${server.id}`;
          const bodyId = `server-panel-${server.id}`;
          return (
            <div className="server-accordion-item" key={server.id}>
              <button
                type="button"
                className="server-accordion-trigger"
                id={triggerId}
                aria-expanded={expanded}
                aria-controls={bodyId}
                onClick={() => onToggle(server.id)}
              >
                <ChevronRight size={18} aria-hidden={true} />
                <span className="server-title">{server.name || `Server ${index + 1}`}</span>
                <span className="server-subtitle">{server.host || "No host configured"}</span>
                <span className="server-metrics">{serverSummary(server)}</span>
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
              </button>
              {expanded ? (
                <div className="server-accordion-body" id={bodyId} role="region" aria-labelledby={triggerId}>
                  <div className="library-settings server-section">
                    <div className="library-settings-header">
                      <h3>Library settings</h3>
                      <h4 className="catalog-options-title">Catalogs</h4>
                    </div>
                    <div className="library-settings-grid">
                      <div className="library-select-column">
                        <div className="library-select-row">
                          {field(
                            "Library layout",
                            `libraryLayout-${server.id}`,
                            <select
                              id={`libraryLayout-${server.id}`}
                              className={filledClass(server.libraryLayout)}
                              value={server.libraryLayout}
                              onChange={(event) => onServerChange(server.id, { libraryLayout: event.currentTarget.value as LibraryLayout })}
                            >
                              <option value="auto">Auto detect</option>
                              <option value="folders">Organized by folders</option>
                              <option value="flat">Single folder of files</option>
                            </select>,
                          )}
                          {field(
                            "Stream delivery",
                            `streamDeliveryMode-${server.id}`,
                            <select
                              id={`streamDeliveryMode-${server.id}`}
                              className={filledClass(server.streamDeliveryMode)}
                              value={server.streamDeliveryMode}
                              onChange={(event) => onServerChange(server.id, { streamDeliveryMode: event.currentTarget.value as StreamDeliveryMode })}
                            >
                              <option value="proxy">Proxy through addon</option>
                              <option value="direct">Direct FTP URL</option>
                            </select>,
                          )}
                        </div>
                        <div className="content-type-options" role="group" aria-label="Server content types">
                          <span className="field-label">Server content</span>
                          <div className="server-content-toggles">
                            {(["movies", "series", "anime"] as const).map((key) => (
                              <label className="toggle-row" htmlFor={`${key}-${server.id}`} key={key}>
                                <input
                                  id={`${key}-${server.id}`}
                                  type="checkbox"
                                  checked={server.catalogContentTypes[key]}
                                  onChange={(event) =>
                                    onServerChange(server.id, {
                                      catalogContentTypes: { ...server.catalogContentTypes, [key]: event.currentTarget.checked },
                                    })
                                  }
                                />
                                {key.charAt(0).toUpperCase() + key.slice(1)}
                              </label>
                            ))}
                          </div>
                        </div>
                        {server.streamDeliveryMode === "direct" ? (
                          <p className="field-hint">Direct FTP sends FTP URLs to Stremio clients that can open them.</p>
                        ) : null}
                      </div>
                      <div className="catalog-options-column" role="group" aria-label="Catalogs">
                        <label className="toggle-row" htmlFor={`catalogEnabled-${server.id}`}>
                          <input
                            id={`catalogEnabled-${server.id}`}
                            type="checkbox"
                            checked={server.catalogEnabled}
                            onChange={(event) => {
                              const catalogEnabled = event.currentTarget.checked;
                              onServerChange(
                                server.id,
                                catalogEnabled
                                  ? { catalogEnabled }
                                  : {
                                      catalogEnabled,
                                      catalogContentTypes: { ...server.catalogContentTypes, uncategorized: false },
                                    },
                              );
                            }}
                          />
                          Show content catalogs
                        </label>
                        <label className="toggle-row" htmlFor={`uncategorized-${server.id}`}>
                          <input
                            id={`uncategorized-${server.id}`}
                            type="checkbox"
                            checked={server.catalogContentTypes.uncategorized !== false}
                            disabled={!server.catalogEnabled}
                            onChange={(event) =>
                              onServerChange(server.id, {
                                catalogContentTypes: { ...server.catalogContentTypes, uncategorized: event.currentTarget.checked },
                              })
                            }
                          />
                          Show Uncategorized catalogs
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="server-detail-grid">
                    <div className="server-section">
                      <h3>Server Settings</h3>
                      <div className="field-grid ftp-field-grid">
                        {field(
                          "Server name",
                          `serverName-${server.id}`,
                          <input
                            id={`serverName-${server.id}`}
                            className={filledClass(server.name)}
                            value={server.name}
                            onChange={(event) => onServerChange(server.id, { name: event.currentTarget.value })}
                          />,
                          "field-stack server-name-field",
                        )}
                        {field(
                          "Host",
                          `host-${server.id}`,
                          <input
                            id={`host-${server.id}`}
                            className={filledClass(server.host)}
                            value={server.host}
                            placeholder="ftp.example.com"
                            onChange={(event) => onServerChange(server.id, { host: event.currentTarget.value })}
                          />,
                          "field-stack host-field",
                        )}
                        {field(
                          "Port",
                          `port-${server.id}`,
                          <input
                            id={`port-${server.id}`}
                            inputMode="numeric"
                            className={filledClass(server.port)}
                            value={server.port}
                            onChange={(event) => onServerChange(server.id, { port: event.currentTarget.value })}
                          />,
                          "field-stack port-field",
                        )}
                        {field(
                          "Username",
                          `username-${server.id}`,
                          <input
                            id={`username-${server.id}`}
                            className={filledClass(server.username)}
                            value={server.username}
                            autoComplete="username"
                            onChange={(event) => onServerChange(server.id, { username: event.currentTarget.value })}
                          />,
                          "field-stack username-field",
                        )}
                        {field(
                          "Password",
                          `password-${server.id}`,
                          <input
                            id={`password-${server.id}`}
                            type="password"
                            className={filledClass(server.password)}
                            value={server.password}
                            autoComplete="new-password"
                            placeholder={server.passwordConfigured ? "Leave blank to keep saved password" : "FTP account password"}
                            onChange={(event) => onServerChange(server.id, { password: event.currentTarget.value })}
                          />,
                          "field-stack password-field",
                        )}
                        <div className="field-stack tls-field">
                          <label htmlFor={`tlsMode-${server.id}`}>TLS mode</label>
                          <select
                            id={`tlsMode-${server.id}`}
                            className={filledClass(server.tlsMode)}
                            value={server.tlsMode}
                            onChange={(event) => onServerChange(server.id, { tlsMode: event.currentTarget.value as TlsMode })}
                          >
                            <option value="none">Disabled</option>
                            <option value="explicit">Explicit TLS</option>
                            <option value="implicit">Implicit TLS</option>
                          </select>
                        </div>
                        {field(
                          "Root paths",
                          `rootPaths-${server.id}`,
                          <textarea
                            id={`rootPaths-${server.id}`}
                            className={filledClass(server.rootPaths)}
                            value={server.rootPaths}
                            rows={4}
                            onChange={(event) => onServerChange(server.id, { rootPaths: event.currentTarget.value })}
                          />,
                          "field-stack root-paths-field",
                        )}
                        <label className="toggle-row invalid-certificate-field" htmlFor={`allowInvalidCertificate-${server.id}`}>
                          <input
                            id={`allowInvalidCertificate-${server.id}`}
                            type="checkbox"
                            checked={server.allowInvalidCertificate}
                            onChange={(event) => onServerChange(server.id, { allowInvalidCertificate: event.currentTarget.checked })}
                          />
                          Allow invalid certificate
                        </label>
                      </div>
                    </div>

                    <div className="server-section">
                      <h3>Index status</h3>
                      <dl className="status-list">
                        <div>
                          <dt>Last scan</dt>
                          <dd>{formatScanTime(server.indexStatus.lastScanAt)}</dd>
                        </div>
                        <div>
                          <dt>Next scan</dt>
                          <dd>{formatNextScan(server.scanSchedule.nextScheduledScanAt)}</dd>
                        </div>
                        <div>
                          <dt>Media items</dt>
                          <dd>{server.indexStatus.mediaItems}</dd>
                        </div>
                        <div>
                          <dt>Connection</dt>
                          <dd>
                            <StatusBadge tone={server.connectionStatus.ok === true ? "green" : server.connectionStatus.ok === false ? "red" : server.host ? "gray" : "red"}>
                              {server.connectionStatus.lastTestedAt ? formatConnectionStatus(server.connectionStatus) : server.host ? "Untested" : "Missing host"}
                            </StatusBadge>
                          </dd>
                        </div>
                      </dl>
                      <div className="scan-controls">
                        {field(
                          "Rescan frequency",
                          `scanInterval-${server.id}`,
                          <select
                            id={`scanInterval-${server.id}`}
                            className={filledClass(server.scanSchedule.intervalMinutes)}
                            value={String(server.scanSchedule.intervalMinutes)}
                            disabled={!profileReady}
                            onChange={(event) => onUpdateScanSchedule(server.id, Number(event.currentTarget.value))}
                          >
                            <option value="0">Manual only</option>
                            <option value="360">Every 6 hours</option>
                            <option value="720">Every 12 hours</option>
                            <option value="1440">Daily</option>
                            <option value="4320">Every 3 days</option>
                            <option value="10080">Weekly</option>
                          </select>,
                        )}
                        <div className="scan-progress-block">
                          <div className="scan-progress-meta">
                            <span>{scanProgressLabel(server.scanStatus)}</span>
                            <span>{active ? formatEta(server.scanStatus.estimatedSecondsRemaining) : `${server.scanStatus.progressPercent}%`}</span>
                          </div>
                          <div className="scan-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={server.scanStatus.progressPercent}>
                            <span style={{ transform: `scaleX(${Math.max(0, Math.min(100, server.scanStatus.progressPercent)) / 100})` }} />
                          </div>
                          {server.scanStatus.currentPath ? <p className="scan-current-path">{server.scanStatus.currentPath}</p> : null}
                        </div>
                      </div>
                      <Notice>{server.message}</Notice>
                    </div>
                  </div>

                  <div className="button-row server-button-row">
                    <button
                      type="button"
                      className="icon-button danger-button delete-server-button"
                      aria-label="Delete server"
                      title="Delete server"
                      disabled={!profileReady || servers.length <= 1}
                      onClick={() => onDeleteServer(server.id)}
                    >
                      <Trash2 size={17} aria-hidden={true} />
                    </button>
                    <button type="button" className="secondary-button" disabled={!profileReady || active} onClick={() => onTestServer(server.id)}>
                      Test connection
                    </button>
                    {active ? (
                      <button type="button" className="secondary-button danger-button server-scan-action" disabled={!profileReady} onClick={() => onCancelServer(server.id)}>
                        <CircleStop size={17} aria-hidden={true} />
                        Halt scan
                      </button>
                    ) : (
                      <button type="button" className="secondary-button server-scan-action" disabled={!profileReady} onClick={() => onRefreshServer(server.id)}>
                        <RefreshCw size={17} aria-hidden={true} />
                        Rescan
                      </button>
                    )}
                    <button type="button" className="primary-button save-server-button" aria-label="Save FTP settings" disabled={!profileReady || active} onClick={() => onSaveServer(server.id)}>
                      Save FTP settings
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
