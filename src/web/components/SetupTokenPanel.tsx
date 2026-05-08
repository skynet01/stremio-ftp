import { useState } from "react";
import { Notice } from "./ui.js";

export function SetupTokenPanel({
  error,
  validating,
  onSubmit,
}: {
  error?: string | null;
  validating?: boolean;
  onSubmit: (setupToken: string) => void;
}) {
  const [setupToken, setSetupToken] = useState("");

  return (
    <section className="panel setup-token-panel" aria-labelledby="setup-token-heading">
      <span className="section-label">Configuration locked</span>
      <h2 id="setup-token-heading">Setup token required</h2>
      <Notice>
        Enter your setup token to manage FTP credentials and generate a private Stremio manifest.
      </Notice>
      <form
        className="setup-token-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (setupToken.trim()) onSubmit(setupToken);
        }}
      >
        <label htmlFor="setupToken">Setup token</label>
        <input
          id="setupToken"
          type="password"
          value={setupToken}
          autoComplete="current-password"
          onChange={(event) => setSetupToken(event.currentTarget.value)}
        />
        <button type="submit" className="primary-button" disabled={validating || !setupToken.trim()}>
          {validating ? "Checking..." : "Unlock configuration"}
        </button>
      </form>
      {error ? <Notice>{error}</Notice> : null}
    </section>
  );
}
