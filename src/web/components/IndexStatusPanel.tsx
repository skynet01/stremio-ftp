import { CircleStop, RefreshCw } from "lucide-react";
import type { ConnectionStatus, ScanSchedule, ScanStatus } from "../api.js";
import { field, filledClass, formatConnectionStatus, formatEta, formatNextScan, formatScanTime, Notice, scanIsActive, StatusBadge } from "./ui.js";

export function IndexStatusPanel({
  indexState,
  lastScanAt,
  scanSchedule,
  mediaItems,
  connectionStatus,
  host,
  scanStatus,
  ftpMessage,
  profileReady,
  onUpdateScanSchedule,
  onRefreshIndex,
  onCancelScan,
}: {
  indexState: "idle" | "working" | "ready" | "error";
  lastScanAt: string | null;
  scanSchedule: ScanSchedule;
  mediaItems: number | null;
  connectionStatus: ConnectionStatus;
  host: string;
  scanStatus: ScanStatus;
  ftpMessage: string;
  profileReady: boolean;
  onUpdateScanSchedule: (intervalMinutes: number) => void;
  onRefreshIndex: () => void;
  onCancelScan: () => void;
}) {
  return (
    <section className="panel status-panel" aria-labelledby="status-heading">
      <div className="panel-header">
        <div>
          <span className="section-label">Library</span>
          <h2 id="status-heading">Index status</h2>
          <p>Refresh after changing FTP folders.</p>
        </div>
        <StatusBadge tone={indexState === "ready" ? "green" : indexState === "error" ? "red" : indexState === "working" ? "amber" : "gray"}>
          {indexState === "working" ? "Scanning" : indexState === "ready" ? "Ready" : indexState === "error" ? "Needs attention" : "Idle"}
        </StatusBadge>
      </div>
      <dl className="status-list">
        <div>
          <dt>Last scan</dt>
          <dd>{formatScanTime(lastScanAt)}</dd>
        </div>
        <div>
          <dt>Next scan</dt>
          <dd>{formatNextScan(scanSchedule.nextScheduledScanAt)}</dd>
        </div>
        <div>
          <dt>Media items</dt>
          <dd>{mediaItems === null ? "0" : String(mediaItems)}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd>
            <StatusBadge tone={connectionStatus.ok === true ? "green" : connectionStatus.ok === false ? "red" : host ? "gray" : "red"}>
              {connectionStatus.lastTestedAt ? formatConnectionStatus(connectionStatus) : host ? "Untested" : "Missing host"}
            </StatusBadge>
          </dd>
        </div>
      </dl>
      <div className="scan-controls">
        {field(
          "Rescan frequency",
          "scanInterval",
          <select
            id="scanInterval"
            className={filledClass(scanSchedule.intervalMinutes)}
            value={String(scanSchedule.intervalMinutes)}
            disabled={!profileReady}
            onChange={(event) => onUpdateScanSchedule(Number(event.currentTarget.value))}
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
            <span>{scanStatus.status === "idle" ? "No active scan" : scanStatus.status}</span>
            <span>{scanIsActive(scanStatus) ? formatEta(scanStatus.estimatedSecondsRemaining) : `${scanStatus.progressPercent}%`}</span>
          </div>
          <div
            className="scan-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={scanStatus.progressPercent}
          >
            <span style={{ width: `${scanStatus.progressPercent}%` }} />
          </div>
          {scanStatus.currentPath ? <p className="scan-current-path">{scanStatus.currentPath}</p> : null}
        </div>
      </div>
      <Notice>{ftpMessage}</Notice>
      <div className="button-grid">
        {scanIsActive(scanStatus) ? (
          <button type="button" className="secondary-button danger-button" disabled={!profileReady} onClick={onCancelScan}>
            <CircleStop size={17} aria-hidden={true} />
            Halt scan
          </button>
        ) : (
          <button type="button" className="secondary-button" disabled={!profileReady} onClick={onRefreshIndex}>
            <RefreshCw size={17} aria-hidden={true} />
            Rescan
          </button>
        )}
      </div>
    </section>
  );
}
