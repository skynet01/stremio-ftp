import { useEffect, useMemo, useState } from "react";
import {
  cancelScan,
  createFtpServer,
  createProfile,
  deleteFtpServer,
  loadCustomization,
  loadFtpSettings,
  loadScanStatus,
  loadServers,
  loadSetupStatus,
  rescanIndex,
  saveCustomization,
  saveFtpSettings,
  saveFtpServer,
  saveScanSchedule,
  saveSetupToken,
  setupTokenAvailable,
  testFtpSettings,
  testFtpServer,
  unlockProfile,
} from "./api.js";
import { APP_CHANGELOG } from "./changelog.js";
import { ChangelogDrawer } from "./components/ChangelogDrawer.js";
import { Footer } from "./components/Footer.js";
import { GlobalStatusPanel, type GlobalScanProgress } from "./components/GlobalStatusPanel.js";
import { HeroPanel } from "./components/HeroPanel.js";
import { InstallPanel } from "./components/InstallPanel.js";
import { ServerAccordion, type ServerForm } from "./components/ServerAccordion.js";
import { SetupTokenPanel } from "./components/SetupTokenPanel.js";
import { StreamFormatterPanel } from "./components/StreamFormatterPanel.js";
import { Topbar } from "./components/Topbar.js";
import { DEFAULT_STREAM_DESCRIPTION_TEMPLATE, DEFAULT_STREAM_NAME_TEMPLATE } from "../shared/streamFormatter.js";
import { filledClass, scanIsActive } from "./components/ui.js";
import type { AddonCustomization, FtpConfigRequest, FtpServerSettings, GlobalStats, ScanStatus } from "./api.js";
import type { ChangelogEntry } from "./types.js";

type ProfileState = "new" | "creating" | "created" | "unlocked" | "error";

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
  catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
  libraryLayout: "auto",
  streamDeliveryMode: "proxy",
  streamNameTemplate: DEFAULT_STREAM_NAME_TEMPLATE,
  streamDescriptionTemplate: DEFAULT_STREAM_DESCRIPTION_TEMPLATE,
};

const EMPTY_GLOBAL_STATS: GlobalStats = {
  totalItems: 0,
  movies: 0,
  series: 0,
  anime: 0,
  uncategorized: 0,
  servers: 1,
  activeScans: 0,
  pendingScans: 0,
  lastCompletedScanAt: null,
  status: "idle",
};

const GITHUB_URL = "https://github.com/skynet01/stremio-ftp";
const APP_VERSION = __APP_VERSION__;
const GITHUB_COMMITS_API = "https://api.github.com/repos/skynet01/stremio-ftp/commits?per_page=15";
const SERVER_LIBRARY_SETTING_KEYS = new Set<keyof ServerForm>([
  "catalogEnabled",
  "catalogContentTypes",
  "libraryLayout",
  "streamDeliveryMode",
]);

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

function emptyServerForm(id = 0): ServerForm {
  return {
    id,
    name: "Server 1",
    host: "",
    port: "21",
    username: "",
    password: "",
    passwordConfigured: false,
    tlsMode: "explicit",
    allowInvalidCertificate: false,
    rootPaths: "/",
    catalogEnabled: false,
    catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
    libraryLayout: "auto",
    streamDeliveryMode: "proxy",
    indexStatus: { lastScanAt: null, mediaItems: 0 },
    scanStatus: {
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
    },
    scanSchedule: { intervalMinutes: 0, nextScheduledScanAt: null },
    connectionStatus: { lastTestedAt: null, ok: null },
    pendingScanAfter: null,
    message: "Save FTP settings, then refresh the index.",
  };
}

function serverFormFromPayload(server: FtpServerSettings): ServerForm {
  return {
    ...emptyServerForm(server.id),
    id: server.id,
    name: server.name,
    host: server.ftpConfig?.host ?? "",
    port: String(server.ftpConfig?.port ?? 21),
    username: server.ftpConfig?.username ?? "",
    password: "",
    passwordConfigured: Boolean(server.ftpConfig?.passwordConfigured),
    tlsMode: server.ftpConfig?.tlsMode ?? "explicit",
    allowInvalidCertificate: Boolean(server.ftpConfig?.allowInvalidCertificate),
    rootPaths: server.ftpConfig?.roots.join("\n") ?? "/",
    catalogEnabled: server.customization.catalogEnabled,
    catalogContentTypes: server.customization.catalogContentTypes ?? { movies: true, series: true, anime: false, uncategorized: true },
    libraryLayout: server.customization.libraryLayout ?? "auto",
    streamDeliveryMode: server.customization.streamDeliveryMode ?? "proxy",
    indexStatus: server.indexStatus,
    scanStatus: server.scanStatus,
    scanSchedule: server.scanSchedule,
    connectionStatus: server.connectionStatus,
    pendingScanAfter: server.pendingScanAfter,
    message: serverMessage(server.pendingScanAfter, server.scanStatus, "Server ready."),
  };
}

function serverFormFromLegacyPayload(
  server: ReturnType<typeof emptyServerForm>,
  loaded: Awaited<ReturnType<typeof loadFtpSettings>>,
  customization: AddonCustomization,
): ServerForm {
  return {
    ...server,
    host: loaded.ftpConfig?.host ?? "",
    port: String(loaded.ftpConfig?.port ?? 21),
    username: loaded.ftpConfig?.username ?? "",
    password: "",
    passwordConfigured: Boolean(loaded.ftpConfig?.passwordConfigured),
    tlsMode: loaded.ftpConfig?.tlsMode ?? "explicit",
    allowInvalidCertificate: Boolean(loaded.ftpConfig?.allowInvalidCertificate),
    rootPaths: loaded.ftpConfig?.roots.join("\n") ?? "/",
    catalogEnabled: customization.catalogEnabled,
    catalogContentTypes: customization.catalogContentTypes ?? { movies: true, series: true, anime: false, uncategorized: true },
    libraryLayout: customization.libraryLayout ?? "auto",
    streamDeliveryMode: customization.streamDeliveryMode ?? "proxy",
    indexStatus: loaded.indexStatus,
    scanStatus: loaded.scanStatus,
    scanSchedule: loaded.scanSchedule,
    connectionStatus: loaded.connectionStatus,
    message: serverMessage(null, loaded.scanStatus, "Server ready."),
  };
}

function ftpConfigFromServer(server: ServerForm): FtpConfigRequest {
  return {
    host: server.host.trim(),
    port: Number(server.port),
    username: server.username,
    password: server.password,
    tlsMode: server.tlsMode,
    allowInvalidCertificate: server.allowInvalidCertificate,
    roots: server.rootPaths
      .split(/\r?\n|,/)
      .map((root) => root.trim())
      .filter(Boolean),
  };
}

function hasCompleteFtpConfig(server: ServerForm) {
  const ftpConfig = ftpConfigFromServer(server);
  return Boolean(ftpConfig.host && ftpConfig.username && ftpConfig.password && Number.isFinite(ftpConfig.port) && ftpConfig.roots.length > 0);
}

export function App() {
  const [hasSetupToken, setHasSetupToken] = useState(() => setupTokenAvailable());
  const needsSetupProbe = !hasSetupToken;
  const [setupTokenRequired, setSetupTokenRequired] = useState<boolean | null>(() => (needsSetupProbe ? null : false));
  const showSetupTokenMessage = !hasSetupToken && setupTokenRequired !== false;
  const settingsUnlocked = !showSetupTokenMessage;
  const [recoveryUid, setRecoveryUid] = useState(() => {
    const stored = window.localStorage.getItem(STORAGE_KEYS.recoveryUid);
    if (stored) return stored;
    const generated = browserUid();
    window.localStorage.setItem(STORAGE_KEYS.recoveryUid, generated);
    return generated;
  });
  const [passphrase, setPassphrase] = useState("");
  const [profileState, setProfileState] = useState<ProfileState>("new");
  const [profileMessage, setProfileMessage] = useState("Create or unlock this browser profile to install the addon.");
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const [stremioInstallUrl, setStremioInstallUrl] = useState<string | null>(null);
  const [addonName, setAddonName] = useState(DEFAULT_CUSTOMIZATION.addonName);
  const [addonLogoUrl, setAddonLogoUrl] = useState(DEFAULT_CUSTOMIZATION.addonLogoUrl);
  const [addonDescription, setAddonDescription] = useState(DEFAULT_CUSTOMIZATION.addonDescription);
  const [catalogTmdbApiKey, setCatalogTmdbApiKey] = useState(DEFAULT_CUSTOMIZATION.catalogTmdbApiKey ?? "");
  const [streamNameTemplate, setStreamNameTemplate] = useState(DEFAULT_STREAM_NAME_TEMPLATE);
  const [streamDescriptionTemplate, setStreamDescriptionTemplate] = useState(DEFAULT_STREAM_DESCRIPTION_TEMPLATE);
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingLogo, setEditingLogo] = useState(false);
  const [customizationMessage, setCustomizationMessage] = useState("Click the title, subtitle, or avatar to customize the Stremio addon.");
  const [servers, setServers] = useState<ServerForm[]>([emptyServerForm()]);
  const [expandedServerId, setExpandedServerId] = useState<number | null>(0);
  const [globalStats, setGlobalStats] = useState<GlobalStats>(EMPTY_GLOBAL_STATS);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelogEntries, setChangelogEntries] = useState<ChangelogEntry[]>(APP_CHANGELOG);
  const profileReady = profileState === "created" || profileState === "unlocked";
  const currentYear = new Date().getFullYear();
  const anyScanActive = useMemo(() => servers.some((server) => scanIsActive(server.scanStatus)), [servers]);
  const globalScanProgress = useMemo<GlobalScanProgress | null>(() => {
    const activeServers = servers.filter((server) => scanIsActive(server.scanStatus));
    if (!activeServers.length) return null;
    const queuedOnly = activeServers.every((server) => server.scanStatus.status === "queued");
    const progressPercent = Math.round(
      activeServers.reduce((sum, server) => sum + Math.max(0, Math.min(100, server.scanStatus.progressPercent)), 0) / activeServers.length,
    );
    const currentPath = activeServers.find((server) => server.scanStatus.currentPath)?.scanStatus.currentPath ?? null;
    const activeMessage = activeServers.find((server) => server.scanStatus.message?.startsWith("Enriching TMDB metadata"))?.scanStatus.message;
    return {
      progressPercent,
      label: activeMessage || `${activeServers.length} ${activeServers.length === 1 ? "server" : "servers"} ${queuedOnly ? "queued" : "indexing"}`,
      currentPath,
    };
  }, [servers]);

  useEffect(() => {
    if (!needsSetupProbe) return;
    void loadSetupStatus()
      .then((status) => setSetupTokenRequired(status.setupTokenRequired))
      .catch(() => setSetupTokenRequired(true));
  }, []);

  useEffect(() => {
    if (showSetupTokenMessage || setupTokenRequired === null) return;
    const rememberedPassphrase = window.localStorage.getItem(STORAGE_KEYS.passphrase);
    if (rememberedPassphrase) void restoreRememberedProfile(rememberedPassphrase);
  }, [setupTokenRequired]);

  useEffect(() => {
    if (!profileReady || !anyScanActive) return;
    const timer = window.setInterval(() => {
      void refreshScanStatus();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [profileReady, anyScanActive]);

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
            const date = typeof item?.commit?.committer?.date === "string" ? item.commit.committer.date : undefined;
            return sha && message ? { date, hash: sha, subject: message } : null;
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

  function applyCustomization(customization: AddonCustomization) {
    setAddonName(customization.addonName || DEFAULT_CUSTOMIZATION.addonName);
    setAddonLogoUrl(customization.addonLogoUrl || "");
    setAddonDescription(customization.addonDescription || DEFAULT_CUSTOMIZATION.addonDescription);
    setCatalogTmdbApiKey(customization.catalogTmdbApiKey || "");
    setStreamNameTemplate(customization.streamNameTemplate || DEFAULT_STREAM_NAME_TEMPLATE);
    setStreamDescriptionTemplate(customization.streamDescriptionTemplate || DEFAULT_STREAM_DESCRIPTION_TEMPLATE);
  }

  function normalizedCustomization(server: ServerForm | undefined = servers[0], overrides: Partial<AddonCustomization> = {}): AddonCustomization {
    return {
      ...DEFAULT_CUSTOMIZATION,
      addonName: addonName.trim() || DEFAULT_CUSTOMIZATION.addonName,
      addonLogoUrl: addonLogoUrl.trim(),
      addonDescription: addonDescription.trim() || DEFAULT_CUSTOMIZATION.addonDescription,
      catalogEnabled: server?.catalogEnabled ?? DEFAULT_CUSTOMIZATION.catalogEnabled,
      catalogTmdbApiKey: catalogTmdbApiKey.trim(),
      catalogContentTypes: server?.catalogContentTypes ?? DEFAULT_CUSTOMIZATION.catalogContentTypes,
      libraryLayout: server?.libraryLayout ?? DEFAULT_CUSTOMIZATION.libraryLayout,
      streamDeliveryMode: server?.streamDeliveryMode ?? DEFAULT_CUSTOMIZATION.streamDeliveryMode,
      streamNameTemplate: streamNameTemplate.trim() || DEFAULT_STREAM_NAME_TEMPLATE,
      streamDescriptionTemplate: streamDescriptionTemplate.trim() || DEFAULT_STREAM_DESCRIPTION_TEMPLATE,
      ...overrides,
    };
  }

  async function loadServerState(nextPassphrase = passphrase) {
    try {
      const loaded = await loadServers({ browserUid: recoveryUid, passphrase: nextPassphrase });
      applyCustomization(loaded.customization);
      const forms = loaded.servers.map(serverFormFromPayload);
      setServers(forms);
      setGlobalStats(loaded.globalStats);
      setExpandedServerId((current) => current && forms.some((server) => server.id === current) ? current : forms[0]?.id ?? null);
      return forms.length > 0;
    } catch (error) {
      const [legacyFtp, legacyCustomization] = await Promise.all([
        loadFtpSettings({ browserUid: recoveryUid, passphrase: nextPassphrase }),
        loadCustomization({ browserUid: recoveryUid, passphrase: nextPassphrase }),
      ]);
      applyCustomization({ ...DEFAULT_CUSTOMIZATION, ...legacyCustomization.customization });
      const form = serverFormFromLegacyPayload(emptyServerForm(), legacyFtp, {
        ...DEFAULT_CUSTOMIZATION,
        ...legacyCustomization.customization,
      });
      setServers([form]);
      setGlobalStats({
        ...EMPTY_GLOBAL_STATS,
        totalItems: legacyFtp.indexStatus.mediaItems,
        activeScans: scanIsActive(legacyFtp.scanStatus) ? 1 : 0,
        status: legacyFtp.scanStatus.status === "failed" ? "error" : legacyFtp.indexStatus.lastScanAt ? "ready" : "idle",
        lastCompletedScanAt: legacyFtp.indexStatus.lastScanAt,
      });
      setExpandedServerId(0);
      return true;
    }
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
        await loadServerState(rememberedPassphrase);
        setProfileMessage("Profile loaded. Saved FTP settings loaded.");
        return;
      }
      const unlocked = await unlockProfile({ browserUid: recoveryUid, passphrase: rememberedPassphrase });
      rememberSession(rememberedPassphrase, unlocked.manifestUrl, unlocked.stremioInstallUrl);
      setProfileState("unlocked");
      await loadServerState(rememberedPassphrase);
      setProfileMessage("Profile loaded. Saved FTP settings loaded.");
    } catch {
      window.localStorage.removeItem(STORAGE_KEYS.passphrase);
      setProfileState("new");
      setProfileMessage("Enter your passphrase to unlock this browser profile.");
    }
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

  function updateServer(serverId: number, patch: Partial<ServerForm>) {
    setServers((current) => current.map((server) => (server.id === serverId ? { ...server, ...patch } : server)));
    if (serverId !== 0 || !profileReady) return;
    if (!Object.keys(patch).some((key) => SERVER_LIBRARY_SETTING_KEYS.has(key as keyof ServerForm))) return;
    const currentServer = servers.find((server) => server.id === serverId);
    if (!currentServer) return;
    const nextServer = { ...currentServer, ...patch };
    void saveCustomization({ browserUid: recoveryUid, passphrase, customization: normalizedCustomization(nextServer) }).catch(() => undefined);
  }

  function serverById(serverId: number) {
    const server = servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new Error("Server not found");
    return server;
  }

  async function saveProfile() {
    setProfileState("creating");
    setProfileMessage("Creating profile...");
    try {
      const created = await createProfile({ browserUid: recoveryUid, passphrase });
      rememberSession(passphrase, created.manifestUrl, created.stremioInstallUrl);
      setProfileState("created");
      await saveCustomization({ browserUid: recoveryUid, passphrase, customization: normalizedCustomization() });
      const firstServer = servers[0];
      if (firstServer && hasCompleteFtpConfig(firstServer)) {
        await saveFtpSettings({ browserUid: recoveryUid, passphrase, ftpConfig: ftpConfigFromServer(firstServer) }).catch(() => undefined);
      }
      await loadServerState(passphrase).catch(() => undefined);
      setProfileMessage(
        firstServer && hasCompleteFtpConfig(firstServer)
          ? "Profile created. FTP settings saved. Install link is ready."
          : "Profile created. Install link is ready.",
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Profile already exists") {
        await unlockExistingProfile();
        return;
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
      await loadServerState();
      setProfileMessage("Profile unlocked. Saved FTP settings loaded.");
    } catch (error) {
      setProfileState("error");
      setProfileMessage(error instanceof Error ? error.message : "Unable to unlock profile.");
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

  async function saveStreamFormatter() {
    if (!profileReady) {
      setCustomizationMessage("Create or unlock your profile to save stream formatting.");
      return;
    }
    try {
      await saveCustomization({ browserUid: recoveryUid, passphrase, customization: normalizedCustomization() });
      setCustomizationMessage("Stream formatter saved. Refresh the addon in Stremio to see updated stream labels.");
    } catch (error) {
      setCustomizationMessage(error instanceof Error ? error.message : "Unable to save stream formatter.");
    }
  }

  async function saveGlobalTmdbApiKey(nextKey: string) {
    const trimmed = nextKey.trim();
    setCatalogTmdbApiKey(trimmed);
    if (!profileReady) {
      setCustomizationMessage("Create or unlock your profile to save the TMDB API key.");
      return;
    }
    try {
      await saveCustomization({ browserUid: recoveryUid, passphrase, customization: normalizedCustomization(servers[0], { catalogTmdbApiKey: trimmed }) });
      setCustomizationMessage("TMDB API key saved. Refresh the addon in Stremio to update catalog matches.");
    } catch (error) {
      setCustomizationMessage(error instanceof Error ? error.message : "Unable to save TMDB API key.");
    }
  }

  async function addServer() {
    const result = await createFtpServer({ browserUid: recoveryUid, passphrase });
    const form = serverFormFromPayload(result.server);
    setServers((current) => [...current, form]);
    setGlobalStats(result.globalStats);
    setExpandedServerId(form.id);
  }

  async function saveServer(serverId: number) {
    const server = serverById(serverId);
    updateServer(serverId, { message: "Saving server settings..." });
    try {
      if (serverId === 0) {
        await saveFtpSettings({ browserUid: recoveryUid, passphrase, ftpConfig: ftpConfigFromServer(server) });
        await saveCustomization({ browserUid: recoveryUid, passphrase, customization: normalizedCustomization(server) });
        updateServer(serverId, { message: "FTP and library settings saved. Refresh the index to find files." });
        return;
      }
      const result = await saveFtpServer({
        browserUid: recoveryUid,
        passphrase,
        serverId,
        name: server.name,
        ftpConfig: ftpConfigFromServer(server),
        customization: {
          catalogEnabled: server.catalogEnabled,
          catalogContentTypes: server.catalogContentTypes,
          libraryLayout: server.libraryLayout,
          streamDeliveryMode: server.streamDeliveryMode,
        },
      });
      setServers((current) =>
        current.map((candidate) =>
          candidate.id === serverId
            ? { ...serverFormFromPayload(result.server), message: "Settings saved. Auto-scan will start in about 5 minutes." }
            : candidate,
        ),
      );
      setGlobalStats(result.globalStats);
    } catch (error) {
      updateServer(serverId, { message: error instanceof Error ? error.message : "Unable to save server settings." });
    }
  }

  async function testServer(serverId: number) {
    const server = serverById(serverId);
    updateServer(serverId, { message: "Testing FTP connection..." });
    try {
      if (serverId === 0) {
        const result = await testFtpSettings({ browserUid: recoveryUid, passphrase, ftpConfig: ftpConfigFromServer(server) });
        updateServer(serverId, { connectionStatus: result.connectionStatus, message: "FTP connection succeeded." });
        return;
      }
      const result = await testFtpServer({ browserUid: recoveryUid, passphrase, serverId, ftpConfig: ftpConfigFromServer(server) });
      updateServer(serverId, { connectionStatus: result.connectionStatus, message: "FTP connection succeeded." });
    } catch (error) {
      updateServer(serverId, { message: error instanceof Error ? error.message : "Unable to test FTP connection." });
    }
  }

  async function refreshServer(serverId: number) {
    updateServer(serverId, { message: "Queueing FTP index refresh..." });
    try {
      const result = await rescanIndex({ browserUid: recoveryUid, passphrase, ...(serverId === 0 ? {} : { serverId }) });
      updateServer(serverId, { scanStatus: result.scanStatus, message: result.scanStatus.message || "Scanning FTP library." });
    } catch (error) {
      updateServer(serverId, { message: error instanceof Error ? error.message : "Unable to refresh index." });
    }
  }

  async function refreshAllServers(force = false) {
    if (force) {
      const confirmed = window.confirm(
        "Force reindex will clear incremental scan snapshots and reparse every configured FTP server. Continue?",
      );
      if (!confirmed) return;
    }
    try {
      const result = await rescanIndex({ browserUid: recoveryUid, passphrase, all: true, ...(force ? { force: true } : {}) });
      if (result.servers) setServers(result.servers.map(serverFormFromPayload));
      if (result.globalStats) setGlobalStats(result.globalStats);
      if (!result.servers) await refreshScanStatus();
    } catch (error) {
      setCustomizationMessage(error instanceof Error ? error.message : "Unable to refresh all indexes.");
    }
  }

  async function haltServer(serverId: number) {
    updateServer(serverId, { message: "Halting scan..." });
    try {
      const result = await cancelScan({ browserUid: recoveryUid, passphrase, ...(serverId === 0 ? {} : { serverId }) });
      updateServer(serverId, { scanStatus: result.scanStatus, message: result.scanStatus.message || "Scan halted." });
    } catch (error) {
      updateServer(serverId, { message: error instanceof Error ? error.message : "Unable to halt scan." });
    }
  }

  async function removeServer(serverId: number) {
    try {
      const result = await deleteFtpServer({ browserUid: recoveryUid, passphrase, serverId });
      const forms = result.servers.map(serverFormFromPayload);
      setServers(forms);
      setGlobalStats(result.globalStats);
      setExpandedServerId(forms[0]?.id ?? null);
    } catch (error) {
      updateServer(serverId, { message: error instanceof Error ? error.message : "Unable to delete server." });
    }
  }

  async function refreshScanStatus() {
    const result = await loadScanStatus({ browserUid: recoveryUid, passphrase });
    if (result.servers) setServers(result.servers.map(serverFormFromPayload));
    if (!result.servers) {
      setServers((current) =>
        current.map((server) =>
          server.id === 0
            ? {
                ...server,
                indexStatus: result.indexStatus,
                scanStatus: result.scanStatus,
                scanSchedule: result.scanSchedule,
                message: scanStatusMessage(result.scanStatus) ?? server.message,
              }
            : server,
        ),
      );
    }
    if (result.globalStats) setGlobalStats(result.globalStats);
  }

  async function updateScanSchedule(serverId: number, intervalMinutes: number) {
    updateServer(serverId, {
      scanSchedule: {
        ...serverById(serverId).scanSchedule,
        intervalMinutes,
      },
    });
    try {
      const result = await saveScanSchedule({ browserUid: recoveryUid, passphrase, ...(serverId === 0 ? {} : { serverId }), intervalMinutes });
      updateServer(serverId, {
        scanSchedule: result.scanSchedule,
        message: intervalMinutes > 0 ? "Automatic scan schedule saved." : "Automatic scans disabled.",
      });
    } catch (error) {
      updateServer(serverId, { message: error instanceof Error ? error.message : "Unable to save scan schedule." });
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

  const installPanel = showSetupTokenMessage ? null : (
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
  );

  return (
    <main className="app-shell">
      <Topbar
        addonName={addonName}
        addonLogoUrl={addonLogoUrl}
        editable={settingsUnlocked}
        profileReady={profileReady}
        profileState={profileState}
        onEditLogo={() => setEditingLogo(true)}
      />
      <HeroPanel
        addonName={addonName}
        addonDescription={addonDescription}
        addonLogoUrl={addonLogoUrl}
        customizationMessage={customizationMessage}
        editable={settingsUnlocked}
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
        <div className="portal-stack">
          {!profileReady ? installPanel : null}
          <GlobalStatusPanel
            stats={globalStats}
            scanProgress={globalScanProgress}
            profileReady={profileReady}
            scanActive={anyScanActive}
            onRescanAll={() => void refreshAllServers()}
            onForceReindexAll={() => void refreshAllServers(true)}
          >
            <div className="global-settings-row">
              <div className="field-stack global-tmdb-field">
                <label htmlFor="globalCatalogTmdbApiKey">TMDB API key</label>
                <input
                  id="globalCatalogTmdbApiKey"
                  className={filledClass(catalogTmdbApiKey)}
                  value={catalogTmdbApiKey}
                  placeholder="Use server default"
                  onChange={(event) => setCatalogTmdbApiKey(event.currentTarget.value)}
                  onBlur={(event) => void saveGlobalTmdbApiKey(event.currentTarget.value)}
                />
              </div>
            </div>
            <StreamFormatterPanel
              addonName={addonName}
              streamNameTemplate={streamNameTemplate}
              streamDescriptionTemplate={streamDescriptionTemplate}
              profileReady={profileReady}
              message={customizationMessage}
              onStreamNameTemplateChange={setStreamNameTemplate}
              onStreamDescriptionTemplateChange={setStreamDescriptionTemplate}
              onSave={() => void saveStreamFormatter()}
            />
          </GlobalStatusPanel>
          <ServerAccordion
            servers={servers}
            expandedServerId={expandedServerId}
            profileReady={profileReady}
            onToggle={(serverId) => setExpandedServerId(expandedServerId === serverId ? null : serverId)}
            onAddServer={() => void addServer()}
            onDeleteServer={(serverId) => void removeServer(serverId)}
            onServerChange={updateServer}
            onSaveServer={(serverId) => void saveServer(serverId)}
            onTestServer={(serverId) => void testServer(serverId)}
            onRefreshServer={(serverId) => void refreshServer(serverId)}
            onCancelServer={(serverId) => void haltServer(serverId)}
            onUpdateScanSchedule={(serverId, intervalMinutes) => void updateScanSchedule(serverId, intervalMinutes)}
          />
          {profileReady ? installPanel : null}
        </div>
      )}
      <Footer appVersion={APP_VERSION} currentYear={currentYear} githubUrl={GITHUB_URL} onOpenChangelog={() => setChangelogOpen(true)} />
      {changelogOpen ? <ChangelogDrawer appVersion={APP_VERSION} entries={changelogEntries} onClose={() => setChangelogOpen(false)} /> : null}
    </main>
  );
}

function scanStatusMessage(scanStatus: ScanStatus) {
  const message = scanStatus.status === "failed" && scanStatus.error ? scanStatus.message || `Scan failed: ${scanStatus.error}` : scanStatus.message;
  return humanizeCooldownMessage(message);
}

function serverMessage(pendingScanAfter: string | null, scanStatus: ScanStatus, fallback: string) {
  if (pendingScanAfter && scanStatus.status === "failed") {
    const retryAt = new Date(pendingScanAfter);
    const retryText = Number.isNaN(retryAt.getTime()) ? "Retry is pending." : `Retry scheduled for ${retryAt.toLocaleString()}.`;
    return `${scanStatusMessage(scanStatus) ?? "Scan failed."} ${retryText}`;
  }
  if (pendingScanAfter) return "Settings saved. Auto-scan is pending.";
  return scanStatusMessage(scanStatus) ?? fallback;
}

function humanizeCooldownMessage(message: string | null) {
  if (!message) return message;
  const match = message.match(/^Manual scan cooldown active\. Try again after ([^.]+)\.$/);
  if (!match) return message;
  const timestamp = Date.parse(match[1]);
  if (Number.isNaN(timestamp)) return message;
  const totalMinutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000));
  if (totalMinutes <= 0) return "Manual scan cooldown active. Try again now.";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const duration = hours && minutes ? `${hours}h ${minutes}m` : hours ? `${hours}h` : `${minutes}m`;
  return `Manual scan cooldown active. Try again in ${duration}.`;
}
