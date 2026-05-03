import type { ChangelogEntry } from "../types.js";
import { Notice } from "./ui.js";

export function ChangelogDrawer({
  appVersion,
  entries,
  onClose,
}: {
  appVersion: string;
  entries: ChangelogEntry[];
  onClose: () => void;
}) {
  return (
    <div className="changelog-backdrop">
      <aside className="changelog-drawer" role="dialog" aria-modal={true} aria-labelledby="changelog-heading">
        <div className="changelog-header">
          <div>
            <span className="section-label">{`v${appVersion}`}</span>
            <h2 id="changelog-heading">Latest changes</h2>
          </div>
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        </div>
        {entries.length ? (
          <ol className="changelog-list">
            {entries.map((commit) => (
              <li key={commit.hash}>
                <code>{commit.hash}</code>
                <span>{commit.subject}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Notice>No commit metadata was available for this build.</Notice>
        )}
      </aside>
    </div>
  );
}
