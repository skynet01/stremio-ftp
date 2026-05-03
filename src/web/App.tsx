import { Copy, RefreshCw } from "lucide-react";
import { createElement as h, type ReactNode, useEffect, useState } from "react";
import {
  createProfile,
  loadCustomization,
  loadFtpSettings,
  loadScanStatus,
  loadSetupStatus,
  rescanIndex,
  saveCustomization,
  saveFtpSettings,
  saveScanSchedule,
  testFtpSettings,
  unlockProfile,
} from "./api.js";
import type { AddonCustomization, ConnectionStatus, IndexStatus, LoadedFtpConfig, ScanSchedule, ScanStatus } from "./api.js";

type StatusTone = "green" | "amber" | "red" | "gray";
const STORAGE_KEYS = {
  recoveryUid: "stremio-ftp-recovery-uid",
  passphrase: "stremio-ftp-passphrase",
  manifestUrl: "stremio-ftp-manifest-url",
  stremioInstallUrl: "stremio-ftp-stremio-install-url",
} as const;
const DEFAULT_CUSTOMIZATION: AddonCustomization = {
  addonName: "Stremio FTP Addon",
  addonLogoUrl: "",
  addonDescription:
    "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
  catalogEnabled: false,
  catalogTmdbApiKey: "",
  catalogContentTypes: { movies: true, series: true, anime: false },
  libraryLayout: "auto",
  streamDeliveryMode: "proxy",
};
const GITHUB_URL = "https://github.com/skynet01/stremio-ftp";
const APP_VERSION = __APP_VERSION__;
const APP_CHANGELOG = __APP_CHANGELOG__;
const DEFAULT_SCAN_STATUS: ScanStatus = {
  id: null,
  status: "idle",
  trigger: null,
  progressPercent: 0,
  entriesSeen: 0,
  filesSeen: 0,
  directoriesSeen: 0,
  currentPath: null,
  estimatedSecondsRemaining: null,
  message: null,
  error: null,
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  mediaItems: 0,
};
const DEFAULT_SCAN_SCHEDULE: ScanSchedule = {
  intervalMinutes: 0,
  nextScheduledScanAt: null,
};

function StatusBadge({ tone, children }: { tone: StatusTone; children?: ReactNode }) {
  return h("span", { className: `badge badge-${tone}` }, children);
}

function field(label: string, id: string, control: ReactNode, className = "field-stack") {
  return h("div", { className }, h("label", { htmlFor: id }, label), control);
}

function Notice({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return h("p", { className: `notice notification ${className}`.trim(), role: "status" }, children);
}

function formatScanTime(lastScanAt: string | null) {
  if (!lastScanAt) return "Never";
  const date = new Date(lastScanAt);
  if (Number.isNaN(date.getTime())) return lastScanAt;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatConnectionStatus(status: ConnectionStatus) {
  if (!status.lastTestedAt) return "Untested";
  return `${status.ok ? "Passed" : "Failed"} ${formatScanTime(status.lastTestedAt)}`;
}

function formatNextScan(nextScheduledScanAt: string | null) {
  if (!nextScheduledScanAt) return "Not scheduled";
  const date = new Date(nextScheduledScanAt);
  if (Number.isNaN(date.getTime())) return nextScheduledScanAt;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "Due now";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return formatScanTime(nextScheduledScanAt);
}

function formatEta(seconds: number | null) {
  if (seconds === null) return "Estimating";
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.ceil(seconds / 60)}m left`;
}

function scanIsActive(status: ScanStatus) {
  return status.status === "queued" || status.status === "running";
}

function filledClass(value: string | number | boolean | null | undefined, extra = "") {
  const filled = typeof value === "boolean" ? value : String(value ?? "").trim().length > 0;
  return [extra, filled ? "filled-control" : ""].filter(Boolean).join(" ");
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
  const hasSetupToken = Boolean(new URLSearchParams(window.location.search).get("setup"));
  const needsSetupProbe = window.location.pathname === "/configure" && !hasSetupToken;
  const [setupTokenRequired, setSetupTokenRequired] = useState<boolean | null>(() => (needsSetupProbe ? null : false));
  const showSetupTokenMessage = window.location.pathname === "/configure" && !hasSetupToken && setupTokenRequired !== false;
  const [recoveryUid, setRecoveryUid] = useState(() => {
    const stored = window.localStorage.getItem(STORAGE_KEYS.recoveryUid);
    if (stored) return stored;
    const generated = browserUid();
    window.localStorage.setItem(STORAGE_KEYS.recoveryUid, generated);
    return generated;
  });
  const [passphrase, setPassphrase] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("21");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tlsMode, setTlsMode] = useState("explicit");
  const [allowInvalidCertificate, setAllowInvalidCertificate] = useState(false);
  const [rootPaths, setRootPaths] = useState("/");
  const [profileState, setProfileState] = useState<"new" | "creating" | "created" | "unlocked" | "error">("new");
  const [profileMessage, setProfileMessage] = useState("Create or unlock this browser profile to install the addon.");
  const [ftpMessage, setFtpMessage] = useState("Save FTP settings, then refresh the index.");
  const [indexState, setIndexState] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [mediaItems, setMediaItems] = useState<number | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus>(DEFAULT_SCAN_STATUS);
  const [scanSchedule, setScanSchedule] = useState<ScanSchedule>(DEFAULT_SCAN_SCHEDULE);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ lastTestedAt: null, ok: null });
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const [stremioInstallUrl, setStremioInstallUrl] = useState<string | null>(null);
  const [addonName, setAddonName] = useState(DEFAULT_CUSTOMIZATION.addonName);
  const [addonLogoUrl, setAddonLogoUrl] = useState(DEFAULT_CUSTOMIZATION.addonLogoUrl);
  const [addonDescription, setAddonDescription] = useState(DEFAULT_CUSTOMIZATION.addonDescription);
  const [catalogEnabled, setCatalogEnabled] = useState(DEFAULT_CUSTOMIZATION.catalogEnabled);
  const [catalogTmdbApiKey, setCatalogTmdbApiKey] = useState(DEFAULT_CUSTOMIZATION.catalogTmdbApiKey || "");
  const [catalogContentTypes, setCatalogContentTypes] = useState(DEFAULT_CUSTOMIZATION.catalogContentTypes!);
  const [libraryLayout, setLibraryLayout] = useState<"auto" | "folders" | "flat">(DEFAULT_CUSTOMIZATION.libraryLayout || "auto");
  const [streamDeliveryMode, setStreamDeliveryMode] = useState<"proxy" | "direct">(DEFAULT_CUSTOMIZATION.streamDeliveryMode || "proxy");
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingLogo, setEditingLogo] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [customizationMessage, setCustomizationMessage] = useState("Click the title, subtitle, or avatar to customize the Stremio addon.");

  const profileReady = profileState === "created" || profileState === "unlocked";
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    if (!needsSetupProbe) return;
    void loadSetupStatus()
      .then((status) => setSetupTokenRequired(status.setupTokenRequired))
      .catch(() => setSetupTokenRequired(true));
  }, []);

  useEffect(() => {
    if (showSetupTokenMessage || setupTokenRequired === null) return;
    const rememberedPassphrase = window.localStorage.getItem(STORAGE_KEYS.passphrase);
    if (!rememberedPassphrase) return;
    void restoreRememberedProfile(rememberedPassphrase);
    // Restore once from this browser's persisted session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupTokenRequired]);

  useEffect(() => {
    if (!profileReady || !scanIsActive(scanStatus)) return;
    const timer = window.setInterval(() => {
      void refreshScanStatus();
    }, 1000);
    return () => window.clearInterval(timer);
    // Poll only while the current scan is active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileReady, scanStatus.status]);

  function rememberInstall(manifest: string, stremioInstall: string) {
    setManifestUrl(manifest);
    setStremioInstallUrl(stremioInstall);
    window.localStorage.setItem(STORAGE_KEYS.manifestUrl, manifest);
    window.localStorage.setItem(STORAGE_KEYS.stremioInstallUrl, stremioInstall);
  }

  function rememberSession(nextPassphrase: string, manifest: string, stremioInstall: string) {
    window.localStorage.setItem(STORAGE_KEYS.recoveryUid, recoveryUid);
    window.localStorage.setItem(STORAGE_KEYS.passphrase, nextPassphrase);
    rememberInstall(manifest, stremioInstall);
  }

  function applyLoadedFtpConfig(ftpConfig: LoadedFtpConfig) {
    setHost(ftpConfig.host);
    setPort(String(ftpConfig.port));
    setUsername(ftpConfig.username);
    setPassword(ftpConfig.password);
    setTlsMode(ftpConfig.tlsMode);
    setAllowInvalidCertificate(ftpConfig.allowInvalidCertificate);
    setRootPaths(ftpConfig.roots.join("\n"));
    setFtpMessage(
      ftpConfig.passwordConfigured
        ? "Saved FTP settings loaded."
        : "Saved FTP settings loaded.",
    );
  }

  function applyLoadedIndexStatus(indexStatus: IndexStatus) {
    setLastScanAt(indexStatus.lastScanAt);
    setMediaItems(indexStatus.mediaItems);
    if (indexStatus.lastScanAt) setIndexState("ready");
  }

  function applyScanStatus(status: ScanStatus) {
    setScanStatus(status);
    if (scanIsActive(status)) {
      setIndexState("working");
      setFtpMessage(status.message || "Scanning FTP library.");
      return;
    }
    if (status.status === "succeeded") {
      setIndexState("ready");
      setFtpMessage(status.message || `Indexed ${status.filesSeen} media file${status.filesSeen === 1 ? "" : "s"}.`);
      setMediaItems(status.mediaItems);
      return;
    }
    if (status.status === "failed") {
      setIndexState("error");
      setFtpMessage(status.error || status.message || "Scan failed.");
      return;
    }
    if (status.status === "skipped") {
      setIndexState("idle");
      setFtpMessage(status.message || "Scan skipped.");
    }
  }

  function applyScanSchedule(schedule: ScanSchedule) {
    setScanSchedule(schedule);
  }

  function applyConnectionStatus(status: ConnectionStatus) {
    setConnectionStatus(status);
  }

  function applyCustomization(customization: AddonCustomization) {
    setAddonName(customization.addonName || DEFAULT_CUSTOMIZATION.addonName);
    setAddonLogoUrl(customization.addonLogoUrl || "");
    setAddonDescription(customization.addonDescription || DEFAULT_CUSTOMIZATION.addonDescription);
    setCatalogEnabled(customization.catalogEnabled ?? DEFAULT_CUSTOMIZATION.catalogEnabled);
    setCatalogTmdbApiKey(customization.catalogTmdbApiKey || "");
    setCatalogContentTypes(customization.catalogContentTypes || DEFAULT_CUSTOMIZATION.catalogContentTypes!);
    setLibraryLayout(customization.libraryLayout || DEFAULT_CUSTOMIZATION.libraryLayout || "auto");
    setStreamDeliveryMode(customization.streamDeliveryMode || DEFAULT_CUSTOMIZATION.streamDeliveryMode || "proxy");
  }

  function normalizedCustomization(): AddonCustomization {
    return {
      addonName: addonName.trim() || DEFAULT_CUSTOMIZATION.addonName,
      addonLogoUrl: addonLogoUrl.trim(),
      addonDescription: addonDescription.trim() || DEFAULT_CUSTOMIZATION.addonDescription,
      catalogEnabled,
      catalogTmdbApiKey: catalogTmdbApiKey.trim(),
      catalogContentTypes,
      libraryLayout,
      streamDeliveryMode,
    };
  }

  function hasCustomBranding(customization = normalizedCustomization()) {
    return (
      customization.addonName !== DEFAULT_CUSTOMIZATION.addonName ||
      customization.addonLogoUrl !== DEFAULT_CUSTOMIZATION.addonLogoUrl ||
      customization.addonDescription !== DEFAULT_CUSTOMIZATION.addonDescription ||
      customization.catalogEnabled !== DEFAULT_CUSTOMIZATION.catalogEnabled ||
      customization.catalogTmdbApiKey !== DEFAULT_CUSTOMIZATION.catalogTmdbApiKey ||
      customization.libraryLayout !== DEFAULT_CUSTOMIZATION.libraryLayout ||
      customization.streamDeliveryMode !== DEFAULT_CUSTOMIZATION.streamDeliveryMode ||
      JSON.stringify(customization.catalogContentTypes) !== JSON.stringify(DEFAULT_CUSTOMIZATION.catalogContentTypes)
    );
  }

  async function loadSavedFtpSettings(nextPassphrase = passphrase) {
    try {
      const loaded = await loadFtpSettings({ browserUid: recoveryUid, passphrase: nextPassphrase });
      applyLoadedFtpConfig(loaded.ftpConfig);
      applyLoadedIndexStatus(loaded.indexStatus);
      applyScanStatus(loaded.scanStatus);
      applyScanSchedule(loaded.scanSchedule);
      applyConnectionStatus(loaded.connectionStatus);
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

  async function loadSavedCustomization(nextPassphrase = passphrase) {
    const loaded = await loadCustomization({ browserUid: recoveryUid, passphrase: nextPassphrase });
    applyCustomization(loaded.customization);
    return loaded.customization;
  }

  async function restoreRememberedProfile(rememberedPassphrase: string) {
    setPassphrase(rememberedPassphrase);
    setProfileState("creating");
    setProfileMessage("Loading saved profile...");

    const rememberedManifest = window.localStorage.getItem(STORAGE_KEYS.manifestUrl);
    const rememberedStremioInstall = window.localStorage.getItem(STORAGE_KEYS.stremioInstallUrl);

    try {
      if (rememberedManifest && rememberedStremioInstall) {
        setManifestUrl(rememberedManifest);
        setStremioInstallUrl(rememberedStremioInstall);
        setProfileState("unlocked");
        await loadSavedCustomization(rememberedPassphrase);
        const loaded = await loadSavedFtpSettings(rememberedPassphrase);
        setProfileMessage(loaded ? "Profile loaded. Saved FTP settings loaded." : "Profile loaded.");
        return;
      }

      const unlocked = await unlockProfile({ browserUid: recoveryUid, passphrase: rememberedPassphrase });
      rememberSession(rememberedPassphrase, unlocked.manifestUrl, unlocked.stremioInstallUrl);
      setProfileState("unlocked");
      await loadSavedCustomization(rememberedPassphrase);
      const loaded = await loadSavedFtpSettings(rememberedPassphrase);
      setProfileMessage(loaded ? "Profile loaded. Saved FTP settings loaded." : "Profile loaded.");
    } catch {
      window.localStorage.removeItem(STORAGE_KEYS.passphrase);
      setProfileState("new");
      setProfileMessage("Enter your passphrase to unlock this browser profile.");
    }
  }

  async function saveProfile() {
    setProfileState("creating");
    setProfileMessage(hasCompleteFtpConfig() ? "Creating profile and saving FTP settings..." : "Creating profile...");
    try {
      const created = await createProfile({ browserUid: recoveryUid, passphrase });
      rememberSession(passphrase, created.manifestUrl, created.stremioInstallUrl);
      setProfileState("created");
      const profileCustomization = normalizedCustomization();
      if (hasCustomBranding(profileCustomization)) {
        try {
          await saveCustomization({ browserUid: recoveryUid, passphrase, customization: profileCustomization });
          setCustomizationMessage("Addon branding saved. Reinstall or refresh the addon in Stremio to see it there.");
        } catch (customizationError) {
          setCustomizationMessage(customizationError instanceof Error ? customizationError.message : "Unable to save addon branding.");
        }
      }
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
          const unlocked = await unlockProfile({ browserUid: recoveryUid, passphrase });
          rememberSession(passphrase, unlocked.manifestUrl, unlocked.stremioInstallUrl);
          setProfileState("unlocked");
          await loadSavedCustomization();
          const loaded = await loadSavedFtpSettings();
          setProfileMessage(loaded ? "Profile unlocked. Saved FTP settings loaded." : "Profile unlocked.");
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
      const unlocked = await unlockProfile({ browserUid: recoveryUid, passphrase });
      rememberSession(passphrase, unlocked.manifestUrl, unlocked.stremioInstallUrl);
      setProfileState("unlocked");
      await loadSavedCustomization();
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
      const result = await testFtpSettings({ browserUid: recoveryUid, passphrase, ftpConfig: currentFtpConfig() });
      applyConnectionStatus(result.connectionStatus);
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
      try {
        await saveCustomization({ browserUid: recoveryUid, passphrase, customization: normalizedCustomization() });
        setCustomizationMessage("Library settings saved. Reinstall or refresh the addon in Stremio to see catalogs there.");
      } catch (customizationError) {
        setCustomizationMessage(customizationError instanceof Error ? customizationError.message : "Unable to save library settings.");
      }
      setIndexState("ready");
      setFtpMessage("FTP and library settings saved. Refresh the index to find files.");
    } catch (error) {
      setIndexState("error");
      setFtpMessage(error instanceof Error ? error.message : "Unable to save FTP settings.");
    }
  }

  async function refreshIndex() {
    setIndexState("working");
    setFtpMessage("Queueing FTP index refresh...");
    try {
      const result = await rescanIndex({ browserUid: recoveryUid, passphrase });
      applyScanStatus(result.scanStatus);
    } catch (error) {
      setIndexState("error");
      setFtpMessage(error instanceof Error ? error.message : "Unable to refresh index.");
    }
  }

  async function refreshScanStatus() {
    const result = await loadScanStatus({ browserUid: recoveryUid, passphrase });
    applyLoadedIndexStatus(result.indexStatus);
    applyScanStatus(result.scanStatus);
    applyScanSchedule(result.scanSchedule);
  }

  async function updateScanSchedule(intervalMinutes: number) {
    setScanSchedule({ ...scanSchedule, intervalMinutes });
    if (!profileReady) return;
    try {
      const result = await saveScanSchedule({ browserUid: recoveryUid, passphrase, intervalMinutes });
      applyScanSchedule(result.scanSchedule);
      setFtpMessage(intervalMinutes > 0 ? "Automatic scan schedule saved." : "Automatic scans disabled.");
    } catch (error) {
      setFtpMessage(error instanceof Error ? error.message : "Unable to save scan schedule.");
    }
  }

  async function saveAddonBranding(nextCustomization: AddonCustomization) {
    applyCustomization(nextCustomization);
    if (!profileReady) {
      setCustomizationMessage("Create or unlock your profile to save this branding.");
      return;
    }
    try {
      await saveCustomization({ browserUid: recoveryUid, passphrase, customization: nextCustomization });
      setCustomizationMessage("Addon branding saved. Reinstall or refresh the addon in Stremio to see it there.");
    } catch (error) {
      setCustomizationMessage(error instanceof Error ? error.message : "Unable to save addon branding.");
    }
  }

  function commitAddonName() {
    setEditingName(false);
    void saveAddonBranding(normalizedCustomization());
  }

  function commitAddonDescription() {
    setEditingDescription(false);
    void saveAddonBranding(normalizedCustomization());
  }

  function commitAddonLogo() {
    setEditingLogo(false);
    void saveAddonBranding(normalizedCustomization());
  }

  function updateCatalogEnabled(nextEnabled: boolean) {
    setCatalogEnabled(nextEnabled);
    void saveAddonBranding({ ...normalizedCustomization(), catalogEnabled: nextEnabled });
  }

  function updateCatalogContentType(key: keyof NonNullable<AddonCustomization["catalogContentTypes"]>, enabled: boolean) {
    const nextContentTypes = { ...catalogContentTypes, [key]: enabled };
    setCatalogContentTypes(nextContentTypes);
    void saveAddonBranding({ ...normalizedCustomization(), catalogContentTypes: nextContentTypes });
  }

  function updateLibraryLayout(nextLayout: "auto" | "folders" | "flat") {
    setLibraryLayout(nextLayout);
    void saveAddonBranding({ ...normalizedCustomization(), libraryLayout: nextLayout });
  }

  function updateStreamDeliveryMode(nextMode: "proxy" | "direct") {
    setStreamDeliveryMode(nextMode);
    void saveAddonBranding({ ...normalizedCustomization(), streamDeliveryMode: nextMode });
  }

  function commitCatalogTmdbApiKey() {
    void saveAddonBranding({ ...normalizedCustomization(), catalogTmdbApiKey: catalogTmdbApiKey.trim() });
  }

  const passphraseField = field(
    "Passphrase",
    "passphrase",
    h("input", {
      id: "passphrase",
      type: "password",
      className: filledClass(passphrase),
      value: passphrase,
      autoComplete: "current-password",
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
        className: filledClass(recoveryUid),
        value: recoveryUid,
        onChange: (event) => {
          setRecoveryUid(event.currentTarget.value);
          window.localStorage.setItem(STORAGE_KEYS.recoveryUid, event.currentTarget.value);
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
      className: filledClass(host),
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
      className: filledClass(port),
      value: port,
      onChange: (event) => setPort(event.currentTarget.value),
    }),
    "field-stack port-field",
  );

  const usernameField = field(
    "Username",
    "username",
    h("input", {
      id: "username",
      className: filledClass(username),
      value: username,
      autoComplete: "username",
      onChange: (event) => setUsername(event.currentTarget.value),
    }),
    "field-stack username-field",
  );

  const passwordField = field(
    "Password",
    "password",
    h("input", {
      id: "password",
      type: "password",
      className: filledClass(password),
      value: password,
      autoComplete: "new-password",
      onChange: (event) => setPassword(event.currentTarget.value),
      placeholder: "FTP account password",
    }),
    "field-stack password-field",
  );

  const securityField = h(
    "div",
    { className: "field-stack tls-field" },
    h("label", { htmlFor: "tlsMode" }, "TLS mode"),
    h(
      "select",
      {
        id: "tlsMode",
        className: filledClass(tlsMode),
        value: tlsMode,
        onChange: (event) => setTlsMode((event.currentTarget as HTMLSelectElement).value),
      },
      h("option", { value: "none" }, "Disabled"),
      h("option", { value: "explicit" }, "Explicit TLS"),
      h("option", { value: "implicit" }, "Implicit TLS"),
    ),
    h(
      "label",
      { className: "toggle-row compact-toggle-row", htmlFor: "allowInvalidCertificate" },
      h("input", {
        id: "allowInvalidCertificate",
        type: "checkbox",
        checked: allowInvalidCertificate,
        onChange: (event) => setAllowInvalidCertificate(event.currentTarget.checked),
      }),
      "Allow invalid certificate",
    ),
  );

  const rootPathsField = field(
    "Root paths",
    "rootPaths",
    h("textarea", {
      id: "rootPaths",
      className: filledClass(rootPaths),
      value: rootPaths,
      onChange: (event) => setRootPaths((event.currentTarget as HTMLTextAreaElement).value),
      rows: 4,
    }),
    "field-stack root-paths-field",
  );

  const librarySettings = h(
    "div",
    { className: "library-settings" },
    h(
      "div",
      { className: "library-settings-header" },
      h("h3", null, "Library settings"),
    ),
    h(
      "div",
      { className: "library-settings-grid" },
      field(
        "TMDB API key",
        "catalogTmdbApiKey",
        h("input", {
          id: "catalogTmdbApiKey",
          className: filledClass(catalogTmdbApiKey),
          value: catalogTmdbApiKey,
          placeholder: "Use server default",
          onChange: (event) => setCatalogTmdbApiKey(event.currentTarget.value),
          onBlur: commitCatalogTmdbApiKey,
        }),
      ),
      field(
        "Library layout",
        "libraryLayout",
        h(
          "select",
          {
            id: "libraryLayout",
            className: filledClass(libraryLayout),
            value: libraryLayout,
            onChange: (event) => updateLibraryLayout((event.currentTarget as HTMLSelectElement).value as "auto" | "folders" | "flat"),
          },
          h("option", { value: "auto" }, "Auto detect"),
          h("option", { value: "folders" }, "Organized by folders"),
          h("option", { value: "flat" }, "Single folder of files"),
        ),
      ),
      field(
        "Stream delivery",
        "streamDeliveryMode",
        h(
          "select",
          {
            id: "streamDeliveryMode",
            className: filledClass(streamDeliveryMode),
            value: streamDeliveryMode,
            onChange: (event) => updateStreamDeliveryMode((event.currentTarget as HTMLSelectElement).value as "proxy" | "direct"),
          },
          h("option", { value: "proxy" }, "Proxy through addon"),
          h("option", { value: "direct" }, "Direct FTP URL"),
        ),
      ),
      h(
        "div",
        { className: "content-type-options", role: "group", "aria-label": "Server content types" },
        h(
          "div",
          { className: "server-content-row" },
          h("span", { className: "field-label" }, "Server content"),
          h(
            "div",
            { className: "server-content-toggles" },
            h(
              "label",
              { className: "toggle-row", htmlFor: "catalogMovies" },
              h("input", {
                id: "catalogMovies",
                type: "checkbox",
                checked: catalogContentTypes.movies,
                onChange: (event) => updateCatalogContentType("movies", event.currentTarget.checked),
              }),
              "Movies",
            ),
            h(
              "label",
              { className: "toggle-row", htmlFor: "catalogSeries" },
              h("input", {
                id: "catalogSeries",
                type: "checkbox",
                checked: catalogContentTypes.series,
                onChange: (event) => updateCatalogContentType("series", event.currentTarget.checked),
              }),
              "Series",
            ),
            h(
              "label",
              { className: "toggle-row", htmlFor: "catalogAnime" },
              h("input", {
                id: "catalogAnime",
                type: "checkbox",
                checked: catalogContentTypes.anime,
                onChange: (event) => updateCatalogContentType("anime", event.currentTarget.checked),
              }),
              "Anime",
            ),
          ),
        ),
        h(
          "label",
          { className: "toggle-row catalog-toggle", htmlFor: "catalogEnabled" },
          h("input", {
            id: "catalogEnabled",
            type: "checkbox",
            checked: catalogEnabled,
            onChange: (event) => updateCatalogEnabled(event.currentTarget.checked),
          }),
          "Show indexed FTP catalog in Stremio",
        ),
      ),
    ),
    streamDeliveryMode === "direct"
      ? h(
          "p",
          { className: "direct-stream-warning" },
          "Direct FTP sends FTP URLs to Stremio clients. Some clients may not support it, and credentials can be visible in the stream URL, but playback no longer depends on the addon server bandwidth.",
        )
      : null,
  );

  const installPanel = h(
    "section",
    { className: "panel install-panel", "aria-labelledby": "install-heading" },
    h(
      "div",
      { className: "panel-header" },
      h(
        "div",
        null,
        h("span", { className: "section-label" }, "Install"),
        h("h2", { id: "install-heading" }, profileReady ? "Manifest" : "Profile setup"),
        h(
          "p",
          null,
          profileReady
            ? "Use this private manifest URL in Stremio."
            : "Enter your passphrase once. This browser will load the profile automatically next time.",
        ),
      ),
    ),
    profileReady
      ? [
          manifestUrl
            ? h(
                "div",
                { key: "manifest", className: "manifest-url" },
                h("span", null, "Manifest URL"),
                h(
                  "div",
                  { className: "inline-control" },
                  h("code", null, manifestUrl),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "icon-button",
                      "aria-label": "Copy manifest URL",
                      onClick: () => void navigator.clipboard?.writeText(manifestUrl),
                    },
                    h(Copy, { size: 18, "aria-hidden": true }),
                  ),
                ),
              )
            : null,
          h(
            "div",
            { key: "actions", className: "install-action-row" },
            h(Notice, { key: "message", className: "install-notice" }, profileMessage),
            stremioInstallUrl ? h("a", { className: "primary-button button-link", href: stremioInstallUrl }, "Install in Stremio") : null,
          ),
        ]
      : [
          h("div", { key: "fields", className: "profile-grid" }, recoveryField, passphraseField),
          h(Notice, { key: "message" }, profileMessage),
          h(
            "div",
            { key: "actions", className: "button-row" },
            h(
              "button",
              {
                type: "button",
                className: "primary-button",
                "aria-label": "Create profile",
                disabled: profileState === "creating",
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
          ),
        ],
  );

  const hero = h(
    "section",
    { className: "hero" },
    h("span", { className: "section-label" }, "Private source addon"),
    editingName
      ? h("input", {
          className: filledClass(addonName, "hero-title-input"),
          "aria-label": "Addon name",
          value: addonName,
          autoFocus: true,
          maxLength: 80,
          onChange: (event) => setAddonName(event.currentTarget.value),
          onBlur: commitAddonName,
          onKeyDown: (event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setAddonName(addonName.trim() || DEFAULT_CUSTOMIZATION.addonName);
              setEditingName(false);
            }
          },
        })
      : h(
          "button",
          {
            type: "button",
            className: "editable-title",
            "aria-label": "Edit addon name",
            onClick: () => setEditingName(true),
          },
          h("h1", null, addonName),
        ),
    editingDescription
      ? h("textarea", {
          className: filledClass(addonDescription, "hero-description-input"),
          "aria-label": "Addon description",
          value: addonDescription,
          autoFocus: true,
          maxLength: 260,
          rows: 3,
          onChange: (event) => setAddonDescription((event.currentTarget as HTMLTextAreaElement).value),
          onBlur: commitAddonDescription,
          onKeyDown: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setAddonDescription(addonDescription.trim() || DEFAULT_CUSTOMIZATION.addonDescription);
              setEditingDescription(false);
            }
          },
        })
      : h(
          "button",
          {
            type: "button",
            className: "editable-description",
            "aria-label": "Edit addon description",
            onClick: () => setEditingDescription(true),
          },
          h("p", null, addonDescription),
    ),
    h(Notice, { className: "customization-notice" }, customizationMessage),
    editingLogo
      ? h(
          "div",
          { className: "avatar-editor" },
          h("label", { htmlFor: "addonLogoUrl" }, "Addon avatar URL"),
          h("input", {
            id: "addonLogoUrl",
            className: filledClass(addonLogoUrl),
            value: addonLogoUrl,
            autoFocus: true,
            placeholder: "https://example.com/logo.png",
            onChange: (event) => setAddonLogoUrl(event.currentTarget.value),
            onBlur: commitAddonLogo,
            onKeyDown: (event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setEditingLogo(false);
            },
          }),
        )
      : null,
  );

  const setupTokenPanel = h(
    "section",
    { className: "panel setup-token-panel", "aria-labelledby": "setup-token-heading" },
    h("span", { className: "section-label" }, "Configuration locked"),
    h("h2", { id: "setup-token-heading" }, "Setup token required"),
    h(Notice, null, "Open the configure page with your setup token to manage FTP credentials and generate a private Stremio manifest."),
  );

  return h(
    "main",
    { className: "app-shell" },
    h(
      "header",
      { className: "topbar" },
      h(
        "div",
        { className: "brand-lockup" },
        h(
          "button",
          {
            type: "button",
            className: "brand-mark",
            "aria-label": "Edit addon avatar",
            style: addonLogoUrl ? { backgroundImage: `url(${addonLogoUrl})` } : undefined,
            onClick: () => setEditingLogo(true),
          },
          addonLogoUrl ? h("span", { className: "visually-hidden" }, "Addon avatar") : "TVA",
        ),
        h("div", null, h("p", { className: "brand-title" }, addonName), h("p", null, "Configure your private Stremio source")),
      ),
      h(StatusBadge, { tone: profileReady ? "green" : "gray" }, profileState === "created" ? "Ready to install" : profileState === "unlocked" ? "Unlocked" : "Not installed"),
    ),
    hero,
    showSetupTokenMessage ? setupTokenPanel : null,
    showSetupTokenMessage
      ? null
      : h(
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
          h("div", { className: "field-grid ftp-field-grid" }, hostField, portField, usernameField, passwordField, securityField, rootPathsField),
          librarySettings,
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
          h("div", null, h("dt", null, "Last scan"), h("dd", null, formatScanTime(lastScanAt))),
          h("div", null, h("dt", null, "Next scan"), h("dd", null, formatNextScan(scanSchedule.nextScheduledScanAt))),
          h("div", null, h("dt", null, "Media items"), h("dd", null, mediaItems === null ? "0" : String(mediaItems))),
          h(
            "div",
            null,
            h("dt", null, "Connection"),
            h(
              "dd",
              null,
              h(
                StatusBadge,
                {
                  tone: connectionStatus.ok === true ? "green" : connectionStatus.ok === false ? "red" : host ? "gray" : "red",
                },
                connectionStatus.lastTestedAt ? formatConnectionStatus(connectionStatus) : host ? "Untested" : "Missing host",
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "scan-controls" },
          field(
            "Rescan frequency",
            "scanInterval",
            h(
              "select",
              {
                id: "scanInterval",
                className: filledClass(scanSchedule.intervalMinutes),
                value: String(scanSchedule.intervalMinutes),
                disabled: !profileReady,
                onChange: (event) => void updateScanSchedule(Number((event.currentTarget as HTMLSelectElement).value)),
              },
              h("option", { value: "0" }, "Manual only"),
              h("option", { value: "360" }, "Every 6 hours"),
              h("option", { value: "720" }, "Every 12 hours"),
              h("option", { value: "1440" }, "Daily"),
              h("option", { value: "10080" }, "Weekly"),
            ),
          ),
          h(
            "div",
            { className: "scan-progress-block" },
            h(
              "div",
              { className: "scan-progress-meta" },
              h("span", null, scanStatus.status === "idle" ? "No active scan" : scanStatus.status),
              h("span", null, scanIsActive(scanStatus) ? formatEta(scanStatus.estimatedSecondsRemaining) : `${scanStatus.progressPercent}%`),
            ),
            h(
              "div",
              {
                className: "scan-progress",
                role: "progressbar",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": scanStatus.progressPercent,
              },
              h("span", { style: { width: `${scanStatus.progressPercent}%` } }),
            ),
            scanStatus.currentPath ? h("p", { className: "scan-current-path" }, scanStatus.currentPath) : null,
          ),
        ),
        h(Notice, null, ftpMessage),
        h(
          "div",
          { className: "button-grid" },
          h(
            "button",
            {
              type: "button",
              className: "secondary-button",
              disabled: !profileReady || scanIsActive(scanStatus),
              onClick: () => void refreshIndex(),
            },
            [h(RefreshCw, { key: "icon", size: 17, "aria-hidden": true }), "Rescan"],
          ),
        ),
      ),
      installPanel,
    ),
    h(
      "footer",
      { className: "site-footer" },
      h("p", null, `Copyright ${currentYear} Stremio FTP Addon. v${APP_VERSION}`),
      h("p", null, "Not responsible for files, streams, or other content hosted on connected servers."),
      h("button", { type: "button", className: "footer-link-button", onClick: () => setChangelogOpen(true) }, "Changelog"),
      h("a", { href: GITHUB_URL, target: "_blank", rel: "noreferrer" }, GITHUB_URL),
    ),
    changelogOpen
      ? h(
          "div",
          { className: "changelog-backdrop" },
          h(
            "aside",
            { className: "changelog-drawer", role: "dialog", "aria-modal": true, "aria-labelledby": "changelog-heading" },
            h(
              "div",
              { className: "changelog-header" },
              h("div", null, h("span", { className: "section-label" }, `v${APP_VERSION}`), h("h2", { id: "changelog-heading" }, "Latest changes")),
              h("button", { type: "button", className: "secondary-button", onClick: () => setChangelogOpen(false) }, "Close"),
            ),
            APP_CHANGELOG.length
              ? h(
                  "ol",
                  { className: "changelog-list" },
                  APP_CHANGELOG.map((commit) =>
                    h(
                      "li",
                      { key: commit.hash },
                      h("code", null, commit.hash),
                      h("span", null, commit.subject),
                    ),
                  ),
                )
              : h(Notice, null, "No commit metadata was available for this build."),
          ),
        )
      : null,
  );
}
