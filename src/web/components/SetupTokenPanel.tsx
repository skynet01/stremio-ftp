import { Notice } from "./ui.js";

export function SetupTokenPanel() {
  return (
    <section className="panel setup-token-panel" aria-labelledby="setup-token-heading">
      <span className="section-label">Configuration locked</span>
      <h2 id="setup-token-heading">Setup token required</h2>
      <Notice>
        Open the configure page with your setup token to manage FTP credentials and generate a private Stremio manifest.
      </Notice>
    </section>
  );
}
