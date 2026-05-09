import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { GlobalStats } from "../api.js";
import { formatScanTime } from "./ui.js";

export type GlobalScanProgress = {
  progressPercent: number;
  label: string;
  currentPath: string | null;
};

export function GlobalStatusPanel({
  stats,
  scanProgress,
  profileReady,
  scanActive,
  onRescanAll,
  onForceReindexAll,
  children,
}: {
  stats: GlobalStats;
  scanProgress: GlobalScanProgress | null;
  profileReady: boolean;
  scanActive: boolean;
  onRescanAll: () => void;
  onForceReindexAll?: () => void;
  children?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const actionDisabled = !profileReady || scanActive;
  const lastScanTitle =
    typeof stats.lastCompletedScanNewItems === "number"
      ? `${stats.lastCompletedScanNewItems} new ${stats.lastCompletedScanNewItems === 1 ? "item was" : "items were"} pulled during the last update.`
      : undefined;

  useEffect(() => {
    if (!menuOpen) return;
    function closeOnOutsidePointer(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <section className="panel global-status-panel" aria-labelledby="global-status-heading">
      <div className="panel-header">
        <div>
          <span className="section-label">Manifest overview</span>
          <h2 id="global-status-heading">Global index status</h2>
          <p>Combined library state across every FTP server in this manifest.</p>
        </div>
        <div className="global-status-state">
          <span title={lastScanTitle}>Last scan {formatScanTime(stats.lastCompletedScanAt)}</span>
          <div className="global-rescan-actions" ref={menuRef}>
            <button type="button" className="secondary-button global-rescan-button" disabled={actionDisabled} onClick={onRescanAll}>
              Rescan All
            </button>
            <button
              type="button"
              className="icon-button global-rescan-menu-button"
              aria-label="Rescan all options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls="global-rescan-menu"
              disabled={actionDisabled || !onForceReindexAll}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            {menuOpen && onForceReindexAll ? (
              <div className="global-rescan-menu" id="global-rescan-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onForceReindexAll();
                  }}
                >
                  Force reindex all
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <dl className="status-list global-status-list">
        <div>
          <dt>Items</dt>
          <dd><AnimatedStatValue value={stats.totalItems} /></dd>
        </div>
        <div>
          <dt>Movies</dt>
          <dd><AnimatedStatValue value={stats.movies} /></dd>
        </div>
        <div>
          <dt>Series</dt>
          <dd><AnimatedStatValue value={stats.series} /></dd>
        </div>
        <div>
          <dt>Anime</dt>
          <dd><AnimatedStatValue value={stats.anime} /></dd>
        </div>
        <div>
          <dt>Servers</dt>
          <dd><AnimatedStatValue value={stats.servers} /></dd>
        </div>
        <div>
          <dt>Active scans</dt>
          <dd><AnimatedStatValue value={stats.activeScans} /></dd>
        </div>
        <div>
          <dt>Pending scans</dt>
          <dd><AnimatedStatValue value={stats.pendingScans} /></dd>
        </div>
        <div>
          <dt>Uncategorized</dt>
          <dd><AnimatedStatValue value={stats.uncategorized} /></dd>
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
            <span style={{ transform: `scaleX(${Math.max(0, Math.min(100, scanProgress.progressPercent)) / 100})` }} />
          </div>
          {scanProgress.currentPath ? <p className="scan-current-path">{scanProgress.currentPath}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function AnimatedStatValue({ value }: { value: number }) {
  const previousValue = useRef(value);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    setPulse(false);
    const start = window.setTimeout(() => setPulse(true), 0);
    const stop = window.setTimeout(() => setPulse(false), 850);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(stop);
    };
  }, [value]);

  return <span className={pulse ? "stat-value stat-value-pulse" : "stat-value"}>{value}</span>;
}
