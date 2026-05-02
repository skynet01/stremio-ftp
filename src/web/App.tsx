import { Copy, RefreshCw } from "lucide-react";
import { createElement as h, type ReactNode, useState } from "react";
import { createProfile, loadFtpSettings, rescanIndex, saveFtpSettings, testFtpSettings, unlockProfile } from "./api.js";
import type { LoadedFtpConfig } from "./api.js";

type StatusTone = "green" | "amber" | "red" | "gray";

function StatusBadge({ tone, children }: { tone: StatusTone; children?: ReactNode }) {
  return h("span", { className: `badge badge-${tone}` }, children);
}

function field(label: string, id: string, control: ReactNode, className = "field-stack") {
  return h("div", { className }, h("label", { htmlFor: id }, label), control);
}

function browserUid() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `uid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function App() {
  const [recoveryUid, setRecoveryUid] = useState(() => {
    const stored = window.localStorage.getItem("stremio-ftp-recovery-uid");
    if (stored) return stored;
    const generated = browserUid();
    window.localStorage.setItem("stremio-ftp-recovery-uid", generated);
    return generated;
  });
  const [passphrase, setPassphrase] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("21");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tlsMode, setTlsMode] = useState("explicit");
  const [allowInvalidCertificate, setAllowInvalidCertificate] = useState(false);
  const [rootPaths, setRootPaths] = useState("/media");
  const [profileState, setProfileState] = useState<"new" | "creating" | "created" | "unlocked" | "error">("new");
  const [profileMessage, setProfileMessage] = useState("Create or unlock this browser profile to install the addon.");
  const [ftpMessage, setFtpMessage] = useState("Save FTP settings, then refresh the index.");
  const [indexState, setIndexState] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [mediaItems, setMediaItems] = useState<number | null>(null);
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const [stremioInstallUrl, setStremioInstallUrl] = useState<string | null>(null);

  const profileReady = profileState === "created" || profileState === "unlocked";

  function applyLoadedFtpConfig(ftpConfig: LoadedFtpConfig) {
    setHost(ftpConfig.host);
    setPort(String(ftpConfig.port));
    setUsername(ftpConfig.username);
    setPassword("");
    setTlsMode(ftpConfig.tlsMode);
    setAllowInvalidCertificate(ftpConfig.allowInvalidCertificate);
    setRootPaths(ftpConfig.roots.join("\n"));
    setFtpMessage(
      ftpConfig.passwordConfigured
        ? "Saved FTP settings loaded. Leave password blank to keep the stored password."
        : "Saved FTP settings loaded.",
    );
  }

  async function loadSavedFtpSettings() {
    try {
      const loaded = await loadFtpSettings({ browserUid: recoveryUid, passphrase });
      applyLoadedFtpConfig(loaded.ftpConfig);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "No saved FTP settings found.";
      if (message === "FTP settings are not configured") {
        setFtpMessage("No saved FTP settings yet.");
        return false;
      }
      throw error;
    }
  }

  async function saveProfile() {
    setProfileState("creating");
    setProfileMessage(hasCompleteFtpConfig() ? "Creating profile and saving FTP settings..." : "Creating profile...");
    try {
      const created = await createProfile({ browserUid: recoveryUid, passphrase });
      setManifestUrl(created.manifestUrl);
      setStremioInstallUrl(created.stremioInstallUrl);
      setProfileState("created");
      if (hasCompleteFtpConfig()) {
        setIndexState("working");
        try {
          await saveFtpSettings({ browserUid: recoveryUid, passphrase, ftpConfig: currentFtpConfig() });
          setIndexState("ready");
          setFtpMessage("FTP settings saved. Refresh the index to find files.");
          setProfileMessage("Profile created. FTP settings saved. Install link is ready.");
        } catch (saveError) {
          setIndexState("error");
          setFtpMessage(saveError instanceof Error ? saveError.message : "Unable to save FTP settings.");
          setProfileMessage("Profile created. Install link is ready, but FTP settings were not saved.");
        }
      } else {
        setProfileMessage("Profile created. Install link is ready.");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Profile already exists") {
        try {
          await unlockProfile({ browserUid: recoveryUid, passphrase });
          setManifestUrl(null);
          setStremioInstallUrl(null);
          setProfileState("unlocked");
          setProfileMessage("Profile unlocked. Create in this browser session to get an install link.");
          return;
        } catch (unlockError) {
          setProfileState("error");
          setProfileMessage(unlockError instanceof Error ? unlockError.message : "Unable to unlock profile.");
          return;
        }
      }
      setProfileState("error");
      setProfileMessage(error instanceof Error ? error.message : "Unable to save profile.");
    }
  }

  async function unlockExistingProfile() {
    setProfileState("creating");
    setProfileMessage("Unlocking profile...");
    try {
      await unlockProfile({ browserUid: recoveryUid, passphrase });
      setManifestUrl(null);
      setStremioInstallUrl(null);
      setProfileState("unlocked");
      const loaded = await loadSavedFtpSettings();
      setProfileMessage(loaded ? "Profile unlocked. Saved FTP settings loaded." : "Profile unlocked.");
    } catch (error) {
      setProfileState("error");
      setProfileMessage(error instanceof Error ? error.message : "Unable to unlock profile.");
    }
  }

  function currentFtpConfig() {
    return {
      host: host.trim(),
      port: Number(port),
      username,
      password,
      tlsMode: tlsMode as "none" | "explicit" | "implicit",
      allowInvalidCertificate,
      roots: rootPaths
        .split(/\r?\n|,/)
        .map((root) => root.trim())
        .filter(Boolean),
    };
  }

  function hasCompleteFtpConfig() {
    const ftpConfig = currentFtpConfig();
    return Boolean(ftpConfig.host && ftpConfig.username && ftpConfig.password && Number.isFinite(ftpConfig.port) && ftpConfig.roots.length > 0);
  }

  async function testConnection() {
    setIndexState("working");
    setFtpMessage("Testing FTP connection...");
    try {
      await testFtpSettings({ browserUid: recoveryUid, passphrase, ftpConfig: currentFtpConfig() });
      setIndexState("ready");
      setFtpMessage("FTP connection succeeded.");
    } catch (error) {
      setIndexState("error");
      setFtpMessage(error instanceof Error ? error.message : "Unable to test FTP connection.");
    }
  }

  async function saveFtp() {
    setIndexState("working");
    setFtpMessage("Saving FTP settings...");
    try {
      await saveFtpSettings({ browserUid: recoveryUid, passphrase, ftpConfig: currentFtpConfig() });
      setIndexState("ready");
      setFtpMessage("FTP settings saved. Refresh the index to find files.");
    } catch (error) {
      setIndexState("error");
      setFtpMessage(error instanceof Error ? error.message : "Unable to save FTP settings.");
    }
  }

  async function refreshIndex() {
    setIndexState("working");
    setFtpMessage("Refreshing FTP index...");
    try {
      const result = await rescanIndex({ browserUid: recoveryUid, passphrase });
      setMediaItems(result.filesSeen);
      setIndexState("ready");
      setFtpMessage(`Indexed ${result.filesSeen} media file${result.filesSeen === 1 ? "" : "s"}.`);
    } catch (error) {
      setIndexState("error");
      setFtpMessage(error instanceof Error ? error.message : "Unable to refresh index.");
    }
  }

  const passphraseField = field(
    "Passphrase",
    "passphrase",
    h("input", {
      id: "passphrase",
      type: "password",
      value: passphrase,
      autoComplete: "new-password",
      onChange: (event) => setPassphrase(event.currentTarget.value),
      placeholder: "Minimum 8 characters",
    }),
  );

  const recoveryField = field(
    "Recovery UID",
    "recoveryUid",
    h(
      "div",
      { className: "inline-control" },
      h("input", {
        id: "recoveryUid",
        value: recoveryUid,
        onChange: (event) => {
          setRecoveryUid(event.currentTarget.value);
          window.localStorage.setItem("stremio-ftp-recovery-uid", event.currentTarget.value);
        },
      }),
      h(
        "button",
        {
          type: "button",
          className: "icon-button",
          "aria-label": "Copy recovery UID",
          onClick: () => void navigator.clipboard?.writeText(recoveryUid),
        },
        h(Copy, { size: 18, "aria-hidden": true }),
      ),
    ),
  );

  const hostField = field(
    "Host",
    "host",
    h("input", {
      id: "host",
      value: host,
      onChange: (event) => setHost(event.currentTarget.value),
      placeholder: "ftp.example.com",
    }),
    "field-stack host-field",
  );

  const portField = field(
    "Port",
    "port",
    h("input", {
      id: "port",
      inputMode: "numeric",
      value: port,
      onChange: (event) => setPort(event.currentTarget.value),
    }),
  );

  const usernameField = field(
    "Username",
    "username",
    h("input", {
      id: "username",
      value: username,
      autoComplete: "username",
      onChange: (event) => setUsername(event.currentTarget.value),
    }),
  );

  const passwordField = field(
    "Password",
    "password",
    h("input", {
      id: "password",
      type: "password",
      value: password,
      autoComplete: "new-password",
      onChange: (event) => setPassword(event.currentTarget.value),
      placeholder: "Leave blank to keep saved password",
    }),
  );

  const tlsModeField = field(
    "TLS mode",
    "tlsMode",
    h(
      "select",
      {
        id: "tlsMode",
        value: tlsMode,
        onChange: (event) => setTlsMode((event.currentTarget as HTMLSelectElement).value),
      },
      h("option", { value: "none" }, "Disabled"),
      h("option", { value: "explicit" }, "Explicit TLS"),
      h("option", { value: "implicit" }, "Implicit TLS"),
    ),
  );

  const rootPathsField = field(
    "Root paths",
    "rootPaths",
    h("textarea", {
      id: "rootPaths",
      value: rootPaths,
      onChange: (event) => setRootPaths((event.currentTarget as HTMLTextAreaElement).value),
      rows: 4,
    }),
    "field-stack span-2",
  );

  return h(
    "main",
    { className: "app-shell" },
    h(
      "header",
      { className: "topbar" },
      h("div", { className: "brand-lockup" }, h("span", { className: "brand-mark" }, "FS"), h("div", null, h("h1", null, "FTP Streams"), h("p", null, "Configure your private Stremio source"))),
      h(StatusBadge, { tone: profileReady ? "green" : "gray" }, profileState === "created" ? "Ready to install" : profileState === "unlocked" ? "Unlocked" : "Not installed"),
    ),
    h(
      "div",
      { className: "portal-grid" },
      h(
        "section",
        { className: "panel ftp-panel", "aria-labelledby": "ftp-heading" },
        h(
          "div",
          { className: "panel-header" },
          h(
            "div",
            null,
            h("span", { className: "section-label" }, "Source"),
            h("h2", { id: "ftp-heading" }, "FTP settings"),
            h("p", null, "Add the server, choose the folders to scan, then save it to your profile."),
          ),
        ),
        h(
          "form",
          { className: "ftp-form" },
          h("div", { className: "field-grid ftp-field-grid" }, hostField, portField, usernameField, passwordField, tlsModeField, rootPathsField),
          h(
            "label",
            { className: "toggle-row", htmlFor: "allowInvalidCertificate" },
            h("input", {
              id: "allowInvalidCertificate",
              type: "checkbox",
              checked: allowInvalidCertificate,
              onChange: (event) => setAllowInvalidCertificate(event.currentTarget.checked),
            }),
            "Allow invalid certificate",
          ),
          h(
            "div",
            { className: "button-row" },
            h(
              "button",
              { type: "button", className: "secondary-button", disabled: !profileReady || indexState === "working", onClick: () => void testConnection() },
              "Test connection",
            ),
            h(
              "button",
              {
                type: "button",
                className: "primary-button",
                "aria-label": "Save FTP settings",
                disabled: !profileReady || indexState === "working",
                onClick: () => void saveFtp(),
              },
              "Save FTP settings",
            ),
          ),
        ),
      ),
      h(
        "section",
        { className: "panel status-panel", "aria-labelledby": "status-heading" },
        h(
          "div",
          { className: "panel-header" },
          h(
            "div",
            null,
            h("span", { className: "section-label" }, "Library"),
            h("h2", { id: "status-heading" }, "Index status"),
            h("p", null, "Refresh after changing FTP folders."),
          ),
          h(StatusBadge, { tone: indexState === "ready" ? "green" : indexState === "error" ? "red" : indexState === "working" ? "amber" : "gray" }, indexState === "working" ? "Scanning" : indexState === "ready" ? "Ready" : indexState === "error" ? "Needs attention" : "Idle"),
        ),
        h(
          "dl",
          { className: "status-list" },
          h("div", null, h("dt", null, "Last scan"), h("dd", null, "Never")),
          h("div", null, h("dt", null, "Media items"), h("dd", null, mediaItems === null ? "0" : String(mediaItems))),
          h(
            "div",
            null,
            h("dt", null, "Connection"),
            h("dd", null, h(StatusBadge, { tone: host ? "gray" : "red" }, host ? "Untested" : "Missing host")),
          ),
        ),
        h("p", { className: "notice", role: "status" }, ftpMessage),
        h(
          "div",
          { className: "button-grid" },
          h(
            "button",
            {
              type: "button",
              className: "secondary-button",
              disabled: !profileReady || indexState === "working",
              onClick: () => void refreshIndex(),
            },
            [h(RefreshCw, { key: "icon", size: 17, "aria-hidden": true }), "Rescan"],
          ),
        ),
      ),
      h(
        "section",
        { className: "panel profile-panel", "aria-labelledby": "profile-heading" },
        h(
          "div",
          { className: "panel-header" },
          h(
            "div",
            null,
            h("span", { className: "section-label" }, "Install"),
            h("h2", { id: "profile-heading" }, "Profile setup"),
            h("p", null, "Create or unlock the encrypted browser profile that stores these settings."),
          ),
        ),
        h("div", { className: "profile-grid" }, passphraseField, recoveryField),
        h("p", { className: "notice", role: "status" }, profileMessage),
        manifestUrl ? h("p", { className: "manifest-url" }, h("span", null, "Manifest"), h("code", null, manifestUrl)) : null,
        h(
          "div",
          { className: "button-row" },
          h(
            "button",
            {
              type: "button",
              className: "primary-button",
              "aria-label": "Create profile",
              disabled: profileState === "creating" || profileState === "created",
              onClick: () => void saveProfile(),
            },
            profileState === "creating" ? "Working..." : "Create profile",
          ),
          h(
            "button",
            {
              type: "button",
              className: "secondary-button",
              "aria-label": "Unlock profile",
              disabled: profileState === "creating",
              onClick: () => void unlockExistingProfile(),
            },
            "Unlock profile",
          ),
          stremioInstallUrl
            ? h("a", { className: "secondary-button button-link", href: stremioInstallUrl }, "Install in Stremio")
            : h(
                "button",
                {
                  type: "button",
                  className: "secondary-button",
                  disabled: true,
                  title: "Create this profile first",
                },
                "Install in Stremio",
              ),
        ),
      ),
    ),
  );
}
