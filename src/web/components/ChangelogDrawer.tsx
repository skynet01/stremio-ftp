import type { ChangelogEntry } from "../types.js";
import { Notice } from "./ui.js";

function changelogParts(subject: string) {
  const match = subject.match(/^([a-z]+)(?:\([^)]+\))?!?:\s+(.+)$/i);
  return match ? { tag: match[1].toLowerCase(), subject: match[2] } : { tag: "change", subject };
}

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
            {entries.map((commit) => {
              const entry = changelogParts(commit.subject);
              return (
                <li key={`${commit.hash}-${commit.subject}`}>
                  <code>{commit.hash}</code>
                  <span className="changelog-tag">{entry.tag}</span>
                  <span>{entry.subject}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <Notice>No commit metadata was available for this build.</Notice>
        )}
      </aside>
    </div>
  );
}
