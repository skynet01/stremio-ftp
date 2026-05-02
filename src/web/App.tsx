import { Copy, Pause, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { createElement as h, type ReactNode, useState } from "react";
import { createProfile, unlockProfile } from "./api.js";

type StatusTone = "green" | "amber" | "red" | "gray";
const unavailableReason = "Backend endpoint not available yet";

function StatusBadge({ tone, children }: { tone: StatusTone; children?: ReactNode }) {
  return h("span", { className: `badge badge-${tone}` }, children);
}

function field(label: string, id: string, control: ReactNode, className = "field-stack") {
  return h("div", { className }, h("label", { htmlFor: id }, label), control);
}

function unavailableButton(className: string, children: ReactNode, ariaLabel?: string) {
  return h(
    "button",
    {
      type: "button",
      className,
      disabled: true,
      title: unavailableReason,
      "aria-label": ariaLabel,
    },
    children,
  );
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
  const [recoveryUid] = useState(browserUid);
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
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const [stremioInstallUrl, setStremioInstallUrl] = useState<string | null>(null);

  async function saveProfile() {
    setProfileState("creating");
    setProfileMessage("Saving profile...");
    try {
      const created = await createProfile({ browserUid: recoveryUid, passphrase });
      setManifestUrl(created.manifestUrl);
      setStremioInstallUrl(created.stremioInstallUrl);
      setProfileState("created");
      setProfileMessage("Profile created. Install link is ready.");
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
      h("input", { id: "recoveryUid", value: recoveryUid, readOnly: true }),
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
    "field-stack span-2",
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
      placeholder: "Leave blank to keep current",
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
      h("option", { value: "disabled" }, "Disabled"),
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
      h("div", null, h("h1", null, "FTP Streams"), h("p", null, "Self-hosted configuration portal")),
      h(StatusBadge, { tone: profileState === "created" || profileState === "unlocked" ? "green" : "gray" }, profileState === "created" ? "Ready to install" : profileState === "unlocked" ? "Unlocked" : "Not installed"),
    ),
    h(
      "div",
      { className: "portal-grid" },
      h(
        "section",
        { className: "panel profile-panel", "aria-labelledby": "profile-heading" },
        h(
          "div",
          { className: "panel-header" },
          h(
            "div",
            null,
            h("h2", { id: "profile-heading" }, "First-run profile"),
            h("p", null, "Create or unlock the local encrypted profile."),
          ),
        ),
        passphraseField,
        recoveryField,
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
              "aria-label": "Save profile",
              disabled: profileState === "creating" || profileState === "created",
              onClick: () => void saveProfile(),
            },
            profileState === "creating" ? "Saving..." : "Save",
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
      h(
        "section",
        { className: "panel status-panel", "aria-labelledby": "status-heading" },
        h(
          "div",
          { className: "panel-header" },
          h(
            "div",
            null,
            h("h2", { id: "status-heading" }, "Index status"),
            h("p", null, "Track scan health and control indexing."),
          ),
          h(StatusBadge, { tone: "amber" }, "Idle"),
        ),
        h(
          "dl",
          { className: "status-list" },
          h("div", null, h("dt", null, "Last scan"), h("dd", null, "Never")),
          h("div", null, h("dt", null, "Media items"), h("dd", null, "0")),
          h(
            "div",
            null,
            h("dt", null, "Connection"),
            h("dd", null, h(StatusBadge, { tone: host ? "gray" : "red" }, host ? "Untested" : "Missing host")),
          ),
        ),
        h("p", { className: "notice", role: "status" }, "Index and FTP controls are visible but disabled until backend endpoints are added."),
        h(
          "div",
          { className: "button-grid" },
          unavailableButton("secondary-button", [h(RefreshCw, { key: "icon", size: 17, "aria-hidden": true }), "Rescan"]),
          unavailableButton("secondary-button", [h(Pause, { key: "icon", size: 17, "aria-hidden": true }), "Pause"]),
          unavailableButton("secondary-button", [h(RotateCcw, { key: "icon", size: 17, "aria-hidden": true }), "Rotate"]),
          unavailableButton("danger-button", [h(Trash2, { key: "icon", size: 17, "aria-hidden": true }), "Delete"]),
        ),
      ),
      h(
        "section",
        { className: "panel ftp-panel", "aria-labelledby": "ftp-heading" },
        h(
          "div",
          { className: "panel-header" },
          h(
            "div",
            null,
            h("h2", { id: "ftp-heading" }, "FTP settings"),
            h("p", null, "Configure the upstream file source."),
          ),
        ),
        h(
          "form",
          { className: "ftp-form" },
          h("div", { className: "field-grid" }, hostField, portField, usernameField, passwordField, tlsModeField, rootPathsField),
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
              { type: "button", className: "secondary-button", disabled: true, title: unavailableReason },
              "Test connection",
            ),
            unavailableButton("primary-button", "Save", "Save FTP settings"),
          ),
        ),
      ),
    ),
  );
}
