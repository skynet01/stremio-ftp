import { useEffect, useState } from "react";
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
  saveSetupToken,
  setupTokenAvailable,
  testFtpSettings,
  unlockProfile,
} from "./api.js";
import { APP_CHANGELOG } from "./changelog.js";
import { ChangelogDrawer } from "./components/ChangelogDrawer.js";
import { Footer } from "./components/Footer.js";
import { FtpSettingsPanel } from "./components/FtpSettingsPanel.js";
import { HeroPanel } from "./components/HeroPanel.js";
import { IndexStatusPanel } from "./components/IndexStatusPanel.js";
import { InstallPanel } from "./components/InstallPanel.js";
import { SetupTokenPanel } from "./components/SetupTokenPanel.js";
import { Topbar } from "./components/Topbar.js";
import { scanIsActive } from "./components/ui.js";
import type { AddonCustomization, ConnectionStatus, IndexStatus, LoadedFtpConfig, ScanSchedule, ScanStatus } from "./api.js";
import type { ChangelogEntry } from "./types.js";

type ProfileState = "new" | "creating" | "created" | "unlocked" | "error";
type IndexState = "idle" | "working" | "ready" | "error";
type TlsMode = "none" | "explicit" | "implicit";
type LibraryLayout = "auto" | "folders" | "flat";
type StreamDeliveryMode = "proxy" | "direct";

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
const GITHUB_COMMITS_API = "https://api.github.com/repos/skynet01/stremio-ftp/commits?per_page=6";

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
  const [hasSetupToken, setHasSetupToken] = useState(() => setupTokenAvailable());
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
  const [tlsMode, setTlsMode] = useState<TlsMode>("explicit");
  const [allowInvalidCertificate, setAllowInvalidCertificate] = useState(false);
  const [rootPaths, setRootPaths] = useState("/");
  const [profileState, setProfileState] = useState<ProfileState>("new");
  const [profileMessage, setProfileMessage] = useState("Create or unlock this browser profile to install the addon.");
  const [ftpMessage, setFtpMessage] = useState("Save FTP settings, then refresh the index.");
  const [indexState, setIndexState] = useState<IndexState>("idle");
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
  const [libraryLayout, setLibraryLayout] = useState<LibraryLayout>(DEFAULT_CUSTOMIZATION.libraryLayout || "auto");
  const [streamDeliveryMode, setStreamDeliveryMode] = useState<StreamDeliveryMode>(DEFAULT_CUSTOMIZATION.streamDeliveryMode || "proxy");
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingLogo, setEditingLogo] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelogEntries, setChangelogEntries] = useState<ChangelogEntry[]>(APP_CHANGELOG);
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
  }, [setupTokenRequired]);

  useEffect(() => {
    if (!profileReady || !scanIsActive(scanStatus)) return;
    const timer = window.setInterval(() => {
      void refreshScanStatus();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [profileReady, scanStatus.status]);

  useEffect(() => {
    if (!changelogOpen || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") return;
    const controller = new AbortController();
    void fetch(GITHUB_COMMITS_API, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!Array.isArray(body)) return;
        const commits = body
          .map((item): ChangelogEntry | null => {
            const sha = typeof item?.sha === "string" ? item.sha.slice(0, 7) : "";
            const message = typeof item?.commit?.message === "string" ? item.commit.message.split("\n")[0] : "";
            return sha && message ? { hash: sha, subject: message } : null;
          })
          .filter((entry): entry is ChangelogEntry => Boolean(entry));
        if (commits.length) setChangelogEntries(commits);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [changelogOpen]);

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

  function updateRecoveryUid(value: string) {
    setRecoveryUid(value);
    window.localStorage.setItem(STORAGE_KEYS.recoveryUid, value);
  }

  function unlockConfiguration(setupToken: string) {
    const trimmed = setupToken.trim();
    saveSetupToken(trimmed);
    setHasSetupToken(Boolean(trimmed));
    setSetupTokenRequired(false);
  }

  function applyLoadedFtpConfig(ftpConfig: LoadedFtpConfig) {
    setHost(ftpConfig.host);
    setPort(String(ftpConfig.port));
    setUsername(ftpConfig.username);
    setPassword(ftpConfig.password);
    setTlsMode(ftpConfig.tlsMode);
    setAllowInvalidCertificate(ftpConfig.allowInvalidCertificate);
    setRootPaths(ftpConfig.roots.join("\n"));
    setFtpMessage("Saved FTP settings loaded.");
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
      tlsMode,
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

  function updateLibraryLayout(nextLayout: LibraryLayout) {
    setLibraryLayout(nextLayout);
    void saveAddonBranding({ ...normalizedCustomization(), libraryLayout: nextLayout });
  }

  function updateStreamDeliveryMode(nextMode: StreamDeliveryMode) {
    setStreamDeliveryMode(nextMode);
    void saveAddonBranding({ ...normalizedCustomization(), streamDeliveryMode: nextMode });
  }

  function commitCatalogTmdbApiKey() {
    void saveAddonBranding({ ...normalizedCustomization(), catalogTmdbApiKey: catalogTmdbApiKey.trim() });
  }

  return (
    <main className="app-shell">
      <Topbar
        addonName={addonName}
        addonLogoUrl={addonLogoUrl}
        profileReady={profileReady}
        profileState={profileState}
        onEditLogo={() => setEditingLogo(true)}
      />
      <HeroPanel
        addonName={addonName}
        addonDescription={addonDescription}
        addonLogoUrl={addonLogoUrl}
        customizationMessage={customizationMessage}
        editingName={editingName}
        editingDescription={editingDescription}
        editingLogo={editingLogo}
        defaultCustomization={DEFAULT_CUSTOMIZATION}
        onAddonNameChange={setAddonName}
        onAddonDescriptionChange={setAddonDescription}
        onAddonLogoUrlChange={setAddonLogoUrl}
        onEditName={() => setEditingName(true)}
        onEditDescription={() => setEditingDescription(true)}
        onStopEditingName={() => setEditingName(false)}
        onStopEditingDescription={() => setEditingDescription(false)}
        onStopEditingLogo={() => setEditingLogo(false)}
        onCommitName={commitAddonName}
        onCommitDescription={commitAddonDescription}
        onCommitLogo={commitAddonLogo}
      />
      {showSetupTokenMessage ? <SetupTokenPanel onSubmit={unlockConfiguration} /> : null}
      {showSetupTokenMessage ? null : (
        <div className="portal-grid">
          <FtpSettingsPanel
            host={host}
            port={port}
            username={username}
            password={password}
            tlsMode={tlsMode}
            allowInvalidCertificate={allowInvalidCertificate}
            rootPaths={rootPaths}
            catalogTmdbApiKey={catalogTmdbApiKey}
            libraryLayout={libraryLayout}
            streamDeliveryMode={streamDeliveryMode}
            catalogContentTypes={catalogContentTypes}
            catalogEnabled={catalogEnabled}
            profileReady={profileReady}
            indexState={indexState}
            onHostChange={setHost}
            onPortChange={setPort}
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
            onTlsModeChange={setTlsMode}
            onAllowInvalidCertificateChange={setAllowInvalidCertificate}
            onRootPathsChange={setRootPaths}
            onCatalogTmdbApiKeyChange={setCatalogTmdbApiKey}
            onCommitCatalogTmdbApiKey={commitCatalogTmdbApiKey}
            onLibraryLayoutChange={updateLibraryLayout}
            onStreamDeliveryModeChange={updateStreamDeliveryMode}
            onCatalogContentTypeChange={updateCatalogContentType}
            onCatalogEnabledChange={updateCatalogEnabled}
            onTestConnection={() => void testConnection()}
            onSaveFtp={() => void saveFtp()}
          />
          <IndexStatusPanel
            indexState={indexState}
            lastScanAt={lastScanAt}
            scanSchedule={scanSchedule}
            mediaItems={mediaItems}
            connectionStatus={connectionStatus}
            host={host}
            scanStatus={scanStatus}
            ftpMessage={ftpMessage}
            profileReady={profileReady}
            onUpdateScanSchedule={(intervalMinutes) => void updateScanSchedule(intervalMinutes)}
            onRefreshIndex={() => void refreshIndex()}
          />
          <InstallPanel
            profileReady={profileReady}
            manifestUrl={manifestUrl}
            stremioInstallUrl={stremioInstallUrl}
            profileMessage={profileMessage}
            profileState={profileState}
            recoveryUid={recoveryUid}
            passphrase={passphrase}
            onRecoveryUidChange={updateRecoveryUid}
            onPassphraseChange={setPassphrase}
            onCreateProfile={() => void saveProfile()}
            onUnlockProfile={() => void unlockExistingProfile()}
          />
        </div>
      )}
      <Footer appVersion={APP_VERSION} currentYear={currentYear} githubUrl={GITHUB_URL} onOpenChangelog={() => setChangelogOpen(true)} />
      {changelogOpen ? <ChangelogDrawer appVersion={APP_VERSION} entries={changelogEntries} onClose={() => setChangelogOpen(false)} /> : null}
    </main>
  );
}
