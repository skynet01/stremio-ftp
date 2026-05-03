import { Github } from "lucide-react";

export function Footer({
  appVersion,
  currentYear,
  githubUrl,
  onOpenChangelog,
}: {
  appVersion: string;
  currentYear: number;
  githubUrl: string;
  onOpenChangelog: () => void;
}) {
  return (
    <footer className="site-footer">
      <p>{`Copyright ${currentYear} Stremio FTP Addon. v${appVersion}`}</p>
      <p>Not responsible for files, streams, or other content hosted on connected servers.</p>
      <button type="button" className="footer-link-button" onClick={onOpenChangelog}>
        Changelog
      </button>
      <a href={githubUrl} target="_blank" rel="noreferrer" className="footer-icon-link" aria-label="GitHub repository">
        <Github size={18} aria-hidden={true} />
      </a>
    </footer>
  );
}
