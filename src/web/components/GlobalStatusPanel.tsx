import type { ReactNode } from "react";
import type { GlobalStats } from "../api.js";
import { formatScanTime, StatusBadge } from "./ui.js";

export type GlobalScanProgress = {
  progressPercent: number;
  label: string;
  currentPath: string | null;
};

export function GlobalStatusPanel({
  stats,
  scanProgress,
  children,
}: {
  stats: GlobalStats;
  scanProgress: GlobalScanProgress | null;
  children?: ReactNode;
}) {
  const tone = stats.status === "working" ? "amber" : stats.status === "ready" ? "green" : stats.status === "error" ? "red" : "gray";
  return (
    <section className="panel global-status-panel" aria-labelledby="global-status-heading">
      <div className="panel-header">
        <div>
          <span className="section-label">Manifest overview</span>
          <h2 id="global-status-heading">Global index status</h2>
          <p>Combined library state across every FTP server in this manifest.</p>
        </div>
        <StatusBadge tone={tone}>{stats.status === "working" ? "Scanning" : stats.status === "ready" ? "Ready" : "Idle"}</StatusBadge>
      </div>
      <dl className="status-list global-status-list">
        <div>
          <dt>Items</dt>
          <dd>{stats.totalItems}</dd>
        </div>
        <div>
          <dt>Movies</dt>
          <dd>{stats.movies}</dd>
        </div>
        <div>
          <dt>Series</dt>
          <dd>{stats.series}</dd>
        </div>
        <div>
          <dt>Anime</dt>
          <dd>{stats.anime}</dd>
        </div>
        <div>
          <dt>Servers</dt>
          <dd>{stats.servers}</dd>
        </div>
        <div>
          <dt>Active scans</dt>
          <dd>{stats.activeScans}</dd>
        </div>
        <div>
          <dt>Pending scans</dt>
          <dd>{stats.pendingScans}</dd>
        </div>
        <div>
          <dt>Last scan</dt>
          <dd>{formatScanTime(stats.lastCompletedScanAt)}</dd>
        </div>
      </dl>
      {scanProgress ? (
        <div className="global-scan-progress">
          <div className="scan-progress-meta">
            <span>{scanProgress.label}</span>
            <span>{scanProgress.progressPercent}%</span>
          </div>
          <div
            className="scan-progress"
            role="progressbar"
            aria-label="Global indexing progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={scanProgress.progressPercent}
          >
            <span style={{ width: `${scanProgress.progressPercent}%` }} />
          </div>
          {scanProgress.currentPath ? <p className="scan-current-path">{scanProgress.currentPath}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
