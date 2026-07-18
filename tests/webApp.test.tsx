/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, globalScanProgressForServers } from "../src/web/App";
import {
  bulkAdminProfiles,
  cancelAdminSharedIndexScan,
  createAdminSharedIndexGroup,
  cancelScan,
  createProfile,
  deleteAdminSharedIndexGroup,
  deleteAdminProfile,
  issueAdminManifestToken,
  linkAdminSharedIndexServer,
  loadAdminSharedIndexGroups,
  loadAdminProfiles,
  loadAdminStreamStatus,
  loadCustomization,
  loadFtpSettings,
  loadServers,
  loadScanStatus,
  loadServers,
  loadSetupStatus,
  rescanIndex,
  rescanAdminSharedIndexGroup,
  rescanAdminProfile,
  rotateAdminSharedIndexKey,
  saveCustomization,
  saveFtpSettings,
  saveFtpServer,
  saveScanSchedule,
  saveSetupToken,
  setAdminProfileEnabled,
  setAdminSharedIndexMaster,
  unlinkAdminSharedIndexServer,
  updateAdminSharedIndexGroup,
  markSetupTokenValidated,
  setupTokenAvailable,
  setupTokenNeedsValidation,
  testFtpSettings,
  unlockProfile,
  validateSetupToken,
} from "../src/web/api";

vi.mock("../src/web/api", () => ({
  bulkAdminProfiles: vi.fn(),
  cancelAdminSharedIndexScan: vi.fn(),
  createAdminSharedIndexGroup: vi.fn(),
  cancelScan: vi.fn(),
  createProfile: vi.fn(),
  deleteAdminSharedIndexGroup: vi.fn(),
  deleteAdminProfile: vi.fn(),
  issueAdminManifestToken: vi.fn(),
  linkAdminSharedIndexServer: vi.fn(),
  loadAdminSharedIndexGroups: vi.fn(),
  loadAdminProfiles: vi.fn(),
  loadAdminStreamStatus: vi.fn(),
  loadCustomization: vi.fn(),
  loadFtpSettings: vi.fn(),
  loadServers: vi.fn(),
  loadScanStatus: vi.fn(),
  loadSetupStatus: vi.fn(),
  rescanIndex: vi.fn(),
  rescanAdminSharedIndexGroup: vi.fn(),
  rescanAdminProfile: vi.fn(),
  rotateAdminSharedIndexKey: vi.fn(),
  saveCustomization: vi.fn(),
  saveFtpSettings: vi.fn(),
  saveFtpServer: vi.fn(),
  saveScanSchedule: vi.fn(),
  saveSetupToken: vi.fn(),
  setAdminProfileEnabled: vi.fn(),
  setAdminSharedIndexMaster: vi.fn(),
  unlinkAdminSharedIndexServer: vi.fn(),
  updateAdminSharedIndexGroup: vi.fn(),
  markSetupTokenValidated: vi.fn(),
  setupTokenAvailable: vi.fn(),
  setupTokenNeedsValidation: vi.fn(),
  testFtpSettings: vi.fn(),
  unlockProfile: vi.fn(),
  validateSetupToken: vi.fn(),
}));

const bulkAdminProfilesMock = vi.mocked(bulkAdminProfiles);
const cancelAdminSharedIndexScanMock = vi.mocked(cancelAdminSharedIndexScan);
const createAdminSharedIndexGroupMock = vi.mocked(createAdminSharedIndexGroup);
const cancelScanMock = vi.mocked(cancelScan);
const createProfileMock = vi.mocked(createProfile);
const deleteAdminSharedIndexGroupMock = vi.mocked(deleteAdminSharedIndexGroup);
const deleteAdminProfileMock = vi.mocked(deleteAdminProfile);
const issueAdminManifestTokenMock = vi.mocked(issueAdminManifestToken);
const linkAdminSharedIndexServerMock = vi.mocked(linkAdminSharedIndexServer);
const loadAdminSharedIndexGroupsMock = vi.mocked(loadAdminSharedIndexGroups);
const loadAdminProfilesMock = vi.mocked(loadAdminProfiles);
const loadAdminStreamStatusMock = vi.mocked(loadAdminStreamStatus);
const loadCustomizationMock = vi.mocked(loadCustomization);
const loadFtpSettingsMock = vi.mocked(loadFtpSettings);
const loadServersMock = vi.mocked(loadServers);
const loadScanStatusMock = vi.mocked(loadScanStatus);
const loadSetupStatusMock = vi.mocked(loadSetupStatus);
const rescanIndexMock = vi.mocked(rescanIndex);
const rescanAdminSharedIndexGroupMock = vi.mocked(rescanAdminSharedIndexGroup);
const rescanAdminProfileMock = vi.mocked(rescanAdminProfile);
const rotateAdminSharedIndexKeyMock = vi.mocked(rotateAdminSharedIndexKey);
const saveCustomizationMock = vi.mocked(saveCustomization);
const saveFtpSettingsMock = vi.mocked(saveFtpSettings);
const saveFtpServerMock = vi.mocked(saveFtpServer);
const saveScanScheduleMock = vi.mocked(saveScanSchedule);
const saveSetupTokenMock = vi.mocked(saveSetupToken);
const setAdminProfileEnabledMock = vi.mocked(setAdminProfileEnabled);
const setAdminSharedIndexMasterMock = vi.mocked(setAdminSharedIndexMaster);
const unlinkAdminSharedIndexServerMock = vi.mocked(unlinkAdminSharedIndexServer);
const updateAdminSharedIndexGroupMock = vi.mocked(updateAdminSharedIndexGroup);
const markSetupTokenValidatedMock = vi.mocked(markSetupTokenValidated);
const setupTokenAvailableMock = vi.mocked(setupTokenAvailable);
const setupTokenNeedsValidationMock = vi.mocked(setupTokenNeedsValidation);
const testFtpSettingsMock = vi.mocked(testFtpSettings);
const unlockProfileMock = vi.mocked(unlockProfile);
const validateSetupTokenMock = vi.mocked(validateSetupToken);
const defaultCatalogOptions = {
  catalogSort: "alphabetical" as const,
  catalogTmdbApiKey: "",
  combineUncategorizedCatalogs: false,
  catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
  libraryLayout: "auto",
  streamDeliveryMode: "proxy",
  streamNameTemplate: "FTP {stream.serverPrefix}{stream.quality}",
  streamDescriptionTemplate: "{stream.serverName}{tools.newLine}{stream.filename}{tools.newLine}{stream.size::bytes}",
};
const idleScanStatus = {
  id: null,
  status: "idle" as const,
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
  mediaItemsAdded: 0,
  scanMode: null,
};
const manualScanSchedule = {
  intervalMinutes: 0,
  nextScheduledScanAt: null,
};

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn() },
    });
    bulkAdminProfilesMock.mockReset();
    cancelAdminSharedIndexScanMock.mockReset();
    createAdminSharedIndexGroupMock.mockReset();
    cancelScanMock.mockReset();
    createProfileMock.mockReset();
    deleteAdminSharedIndexGroupMock.mockReset();
    deleteAdminProfileMock.mockReset();
    issueAdminManifestTokenMock.mockReset();
    linkAdminSharedIndexServerMock.mockReset();
    loadAdminSharedIndexGroupsMock.mockReset();
    loadAdminSharedIndexGroupsMock.mockResolvedValue({ groups: [] });
    loadAdminProfilesMock.mockReset();
    loadAdminProfilesMock.mockResolvedValue({
      summary: {
        profiles: 0,
        configuredProfiles: 0,
        ftpServers: 0,
        configuredFtpServers: 0,
        indexedItems: 0,
        activeScans: 0,
        pendingScans: 0,
      },
      profiles: [],
    });
    loadAdminStreamStatusMock.mockReset();
    loadAdminStreamStatusMock.mockResolvedValue({ activeStreams: [], summary: { active: 0, profile: 0, shared: 0 } });
    loadCustomizationMock.mockReset();
    loadFtpSettingsMock.mockReset();
    loadServersMock.mockReset();
    loadScanStatusMock.mockReset();
    loadServersMock.mockReset();
    loadSetupStatusMock.mockReset();
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: true });
    rescanIndexMock.mockReset();
    rescanAdminSharedIndexGroupMock.mockReset();
    rescanAdminProfileMock.mockReset();
    rotateAdminSharedIndexKeyMock.mockReset();
    saveCustomizationMock.mockReset();
    saveFtpSettingsMock.mockReset();
    saveFtpServerMock.mockReset();
    saveScanScheduleMock.mockReset();
    saveSetupTokenMock.mockReset();
    setAdminProfileEnabledMock.mockReset();
    setAdminSharedIndexMasterMock.mockReset();
    unlinkAdminSharedIndexServerMock.mockReset();
    updateAdminSharedIndexGroupMock.mockReset();
    markSetupTokenValidatedMock.mockReset();
    setupTokenAvailableMock.mockReset();
    setupTokenAvailableMock.mockReturnValue(true);
    setupTokenNeedsValidationMock.mockReset();
    setupTokenNeedsValidationMock.mockReturnValue(false);
    testFtpSettingsMock.mockReset();
    unlockProfileMock.mockReset();
    validateSetupTokenMock.mockReset();
    validateSetupTokenMock.mockResolvedValue({ ok: true });
    loadFtpSettingsMock.mockResolvedValue({
      ftpConfig: {
        host: "ftp.example.test",
        port: 21,
        username: "user",
        password: "",
        passwordConfigured: true,
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/"],
      },
      indexStatus: { lastScanAt: null, mediaItems: 0 },
      connectionStatus: { lastTestedAt: null, ok: null },
      scanStatus: { ...idleScanStatus },
      scanSchedule: manualScanSchedule,
    });
    loadCustomizationMock.mockResolvedValue({
      customization: {
        addonName: "Stremio FTP Addon",
        addonLogoUrl: "",
        addonDescription:
          "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
        catalogEnabled: false,
      },
    });
  });

  it("renders the FTP configuration portal", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });
    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });
    expect(screen.getByRole("heading", { name: "Stremio FTP Addon" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit addon name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit addon description" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit addon avatar" })).toBeTruthy();
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect((screen.getByLabelText("Root paths") as HTMLTextAreaElement).value).toBe("/");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    expect(screen.getByText("Index status")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Library settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Server Settings" })).toBeTruthy();
    expect(
      Boolean(
        screen.getByRole("heading", { name: "Library settings" }).compareDocumentPosition(screen.getByRole("heading", { name: "Server Settings" })) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        screen.getByRole("heading", { name: "Server Settings" }).compareDocumentPosition(screen.getByText("Index status")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(screen.getByLabelText("TMDB API key")).toHaveAttribute("placeholder", "Add your own TMDB key for better matching");
    expect(screen.getByLabelText("Library layout")).toBeTruthy();
    expect(screen.getByLabelText("Stream delivery")).toBeTruthy();
    const catalogsGroup = screen.getByRole("group", { name: "Catalogs" });
    const contentCatalogsToggle = within(catalogsGroup).getByLabelText("Show content catalogs");
    const uncategorizedCatalogsToggle = within(catalogsGroup).getByLabelText("Show Uncategorized catalogs");
    expect(screen.getByRole("heading", { name: "Catalogs" }).closest(".library-settings-header")).toBeTruthy();
    expect(contentCatalogsToggle).toBeTruthy();
    expect(uncategorizedCatalogsToggle).toBeTruthy();
    expect(contentCatalogsToggle.closest("label")?.classList.contains("catalog-toggle")).toBe(false);
    expect(
      Boolean(
        contentCatalogsToggle.compareDocumentPosition(uncategorizedCatalogsToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    const serverContent = screen.getByRole("group", { name: "Server content types" });
    expect(within(serverContent).getByText("Server content")).toBeTruthy();
    const moviesToggle = within(serverContent).getByLabelText("Movies");
    const seriesToggle = within(serverContent).getByLabelText("Series");
    const animeToggle = within(serverContent).getByLabelText("Anime");
    expect(moviesToggle.closest("label")).toHaveAttribute("title", expect.stringContaining("movie files"));
    expect(seriesToggle.closest("label")).toHaveAttribute("title", expect.stringContaining("series episode files"));
    expect(animeToggle.closest("label")).toHaveAttribute("title", expect.stringContaining("/Anime Movies"));
    expect(screen.getByText(`Copyright ${new Date().getFullYear()} Stremio FTP Addon. v0.4.49`)).toBeTruthy();
    expect(screen.getByText("Not responsible for files, streams, or other content hosted on connected servers.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Changelog" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub repository" }).getAttribute("href")).toBe(
      "https://github.com/skynet01/stremio-ftp",
    );
  });

  it("keeps completed servers in the current global scan progress batch", () => {
    const progress = globalScanProgressForServers([
      {
        scanStatus: {
          ...idleScanStatus,
          id: 21,
          status: "succeeded",
          trigger: "manual",
          progressPercent: 100,
          queuedAt: "2026-05-09T00:00:00.000Z",
          startedAt: "2026-05-09T00:00:00.000Z",
          finishedAt: "2026-05-09T00:01:00.000Z",
        },
      },
      {
        scanStatus: {
          ...idleScanStatus,
          id: 22,
          status: "running",
          trigger: "manual",
          progressPercent: 10,
          queuedAt: "2026-05-09T00:00:00.001Z",
          startedAt: "2026-05-09T00:01:00.000Z",
        },
      },
    ]);

    expect(progress?.progressPercent).toBe(55);
  });

  it("edits stream formatter templates with a live preview", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });

    expect(screen.queryByLabelText("Stream name formatter")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stream formatter settings" }));
    expect(screen.getByText(/AIOStreams custom formatter syntax is supported/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Stream name formatter"), {
      target: { value: "{addon.name} | {stream.serverName} | {stream.quality}" },
    });
    fireEvent.change(screen.getByLabelText("Stream description formatter"), {
      target: { value: "{stream.filename}{tools.newLine}{stream.size::bytes}" },
    });
    const descriptionFormatter = screen.getByLabelText("Stream description formatter") as HTMLTextAreaElement;
    fireEvent.focus(descriptionFormatter);
    fireEvent.click(screen.getByRole("button", { name: "Video tags" }));
    expect(descriptionFormatter.value).toContain("{stream.videoTags}");
    fireEvent.focus(screen.getByLabelText("Stream name formatter"));
    fireEvent.click(screen.getByRole("button", { name: "3D type" }));
    expect((screen.getByLabelText("Stream name formatter") as HTMLTextAreaElement).value).toContain("{stream.3dtype}");
    fireEvent.change(descriptionFormatter, {
      target: { value: "{stream.filename}{tools.newLine}{stream.size::bytes}" },
    });
    fireEvent.change(screen.getByLabelText("Stream name formatter"), {
      target: { value: "3D - {stream.3dtype} - {stream.quality}" },
    });

    expect(screen.getByText("3D - Full SBS - 2160p")).toBeTruthy();
    expect(screen.getByText("Avatar.2009.2160p.Full-SBS.DV.HDR10.HEVC.TrueHD.Atmos.7.1.mkv")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save stream formatter" }));

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenLastCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Stremio FTP Addon",
          addonLogoUrl: "",
          addonDescription:
            "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
          catalogEnabled: false,
          catalogSort: "alphabetical",
          catalogTmdbApiKey: "",
          combineUncategorizedCatalogs: false,
          catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
          libraryLayout: "auto",
          streamDeliveryMode: "proxy",
          streamNameTemplate: "3D - {stream.3dtype} - {stream.quality}",
          streamDescriptionTemplate: "{stream.filename}{tools.newLine}{stream.size::bytes}",
        },
      }),
    );
  });

  it("opens a footer changelog drawer with recent commits", async () => {
    render(<App />);
    await waitFor(() => expect(loadSetupStatusMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Changelog" }));

    expect(screen.getByRole("dialog", { name: "Latest changes" })).toBeTruthy();
    expect(screen.getAllByText("May 23").length).toBeGreaterThan(0);
    expect(screen.getAllByText("feat").length).toBeGreaterThan(0);
    expect(screen.getAllByText("fix").length).toBeGreaterThan(0);
    expect(screen.getByText("Split Uncategorized catalogs by server with an optional combined view")).toBeTruthy();
    expect(screen.getByText("Tune FTP playback concurrency and shared index count display")).toBeTruthy();
    expect(screen.queryByText("fix: tune FTP playback concurrency and shared index count display")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Latest changes" })).toBeNull();
  });

  it("renders when crypto.randomUUID is unavailable", () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        ...originalCrypto,
        randomUUID: undefined,
      },
    });

    try {
      render(<App />);
      expect(screen.getByRole("heading", { name: "Stremio FTP Addon" })).toBeTruthy();
      expect(screen.getByLabelText("Recovery UID")).toBeTruthy();
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it("creates a profile and exposes the returned Stremio install link", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    await waitFor(() => {
      expect(createProfileMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
      });
    });

    const installLink = await screen.findByRole("link", { name: "Install in Stremio" });
    expect(installLink.getAttribute("href")).toBe("stremio://addon.example.test/u/token/manifest.json");
    expect(screen.getByText("https://addon.example.test/u/token/manifest.json")).toBeTruthy();
    expect(window.localStorage.getItem("stremio-ftp-manifest-url")).toBe("https://addon.example.test/u/token/manifest.json");
    expect(window.localStorage.getItem("stremio-ftp-passphrase")).toBe("passphrase");
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock profile" })).toBeNull();
    expect(unlockProfileMock).not.toHaveBeenCalled();
  });

  it("unlocks an existing profile and shows the issued install link", async () => {
    unlockProfileMock.mockResolvedValue({
      profileId: 1,
      manifestUrl: "https://addon.example.test/u/unlocked/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/unlocked/manifest.json",
    });
    loadFtpSettingsMock.mockResolvedValue({
      ftpConfig: {
        host: "ftp.example.test",
        port: 2121,
        username: "user",
        password: "",
        passwordConfigured: true,
        tlsMode: "explicit",
        allowInvalidCertificate: true,
        roots: ["/Movies", "/TV"],
      },
      indexStatus: {
        lastScanAt: "2026-05-02T22:45:00.000Z",
        mediaItems: 42,
      },
      connectionStatus: {
        lastTestedAt: "2026-05-02T22:40:00.000Z",
        ok: true,
      },
      scanStatus: { ...idleScanStatus, mediaItems: 42 },
      scanSchedule: manualScanSchedule,
    });
    loadCustomizationMock.mockResolvedValue({
      customization: {
        addonName: "Archive 3D",
        addonLogoUrl: "https://cdn.example.test/logo.png",
        addonDescription: "Stream the archive from my FTP server.",
        catalogEnabled: false,
      },
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock profile" }));

    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    await waitFor(() => {
      expect(unlockProfileMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
      });
    });

    await waitFor(() => expect(loadFtpSettingsMock).toHaveBeenCalledWith({ browserUid: recoveryUid.value, passphrase: "passphrase" }));
    await waitFor(() => expect(loadCustomizationMock).toHaveBeenCalledWith({ browserUid: recoveryUid.value, passphrase: "passphrase" }));
    expect(screen.getByRole("heading", { name: "Archive 3D" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit addon description" })).toHaveTextContent("Stream the archive from my FTP server.");
    expect(screen.getByRole("link", { name: "Install in Stremio" }).getAttribute("href")).toBe(
      "stremio://addon.example.test/u/unlocked/manifest.json",
    );
    expect(screen.getByText("https://addon.example.test/u/unlocked/manifest.json")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock profile" })).toBeNull();
    expect(screen.getByDisplayValue("ftp.example.test")).toBeTruthy();
    expect(screen.getByDisplayValue("ftp.example.test")).toHaveClass("filled-control");
    expect(screen.getByDisplayValue("2121")).toBeTruthy();
    expect(screen.queryByDisplayValue("secret")).toBeNull();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Root paths") as HTMLTextAreaElement).value).toBe("/Movies\n/TV");
    expect(screen.getByText("Profile unlocked. Saved FTP settings loaded.")).toBeTruthy();
    expect(screen.getByText("Profile unlocked. Saved FTP settings loaded.")).toHaveClass("notification");
    expect(screen.getByText("Profile unlocked. Saved FTP settings loaded.").parentElement).toHaveClass("install-action-row");
    expect(screen.getAllByText("42").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/May 02, 2026, 3:45 PM/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Passed May 02, 2026, 3:40 PM/)).toBeTruthy();
  });

  it("saves edited addon name and avatar after profile setup", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });

    fireEvent.click(screen.getByRole("button", { name: "Edit addon name" }));
    fireEvent.change(screen.getByLabelText("Addon name"), { target: { value: "Archive 3D" } });
    fireEvent.blur(screen.getByLabelText("Addon name"));

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Archive 3D",
          addonLogoUrl: "",
          addonDescription: "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
          catalogEnabled: false,
          ...defaultCatalogOptions,
        },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit addon description" }));
    fireEvent.change(screen.getByLabelText("Addon description"), { target: { value: "Stream the archive from my FTP server." } });
    fireEvent.blur(screen.getByLabelText("Addon description"));

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenLastCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Archive 3D",
          addonLogoUrl: "",
          addonDescription: "Stream the archive from my FTP server.",
          catalogEnabled: false,
          ...defaultCatalogOptions,
        },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit addon avatar" }));
    fireEvent.change(screen.getByLabelText("Addon avatar URL"), { target: { value: "https://cdn.example.test/logo.png" } });
    fireEvent.blur(screen.getByLabelText("Addon avatar URL"));

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenLastCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Archive 3D",
          addonLogoUrl: "https://cdn.example.test/logo.png",
          addonDescription: "Stream the archive from my FTP server.",
          catalogEnabled: false,
          ...defaultCatalogOptions,
        },
      }),
    );
  });

  it("persists addon branding chosen before profile creation", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Edit addon name" }));
    fireEvent.change(screen.getByLabelText("Addon name"), { target: { value: "Archive 3D" } });
    fireEvent.blur(screen.getByLabelText("Addon name"));
    fireEvent.click(screen.getByRole("button", { name: "Edit addon description" }));
    fireEvent.change(screen.getByLabelText("Addon description"), { target: { value: "Stream the archive from my FTP server." } });
    fireEvent.blur(screen.getByLabelText("Addon description"));
    fireEvent.click(screen.getByRole("button", { name: "Edit addon avatar" }));
    fireEvent.change(screen.getByLabelText("Addon avatar URL"), { target: { value: "https://cdn.example.test/logo.png" } });
    fireEvent.blur(screen.getByLabelText("Addon avatar URL"));

    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Archive 3D",
          addonLogoUrl: "https://cdn.example.test/logo.png",
          addonDescription: "Stream the archive from my FTP server.",
          catalogEnabled: false,
          ...defaultCatalogOptions,
        },
      }),
    );
  });

  it("automatically loads a remembered profile in the same browser", async () => {
    window.localStorage.setItem("stremio-ftp-recovery-uid", "remembered-browser");
    window.localStorage.setItem("stremio-ftp-passphrase", "passphrase");
    window.localStorage.setItem("stremio-ftp-manifest-url", "https://addon.example.test/u/remembered/manifest.json");
    window.localStorage.setItem("stremio-ftp-stremio-install-url", "stremio://addon.example.test/u/remembered/manifest.json");
    loadCustomizationMock.mockResolvedValue({
      customization: {
        addonName: "Stremio FTP Addon",
        addonLogoUrl: "",
        addonDescription: "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
        catalogEnabled: false,
      },
    });
    loadFtpSettingsMock.mockResolvedValue({
      ftpConfig: {
        host: "ftp.example.test",
        port: 13017,
        username: "user",
        password: "",
        passwordConfigured: true,
        tlsMode: "explicit",
        allowInvalidCertificate: true,
        roots: ["/"],
      },
      indexStatus: {
        lastScanAt: "2026-05-02T22:45:00.000Z",
        mediaItems: 7,
      },
      connectionStatus: {
        lastTestedAt: "2026-05-02T22:40:00.000Z",
        ok: true,
      },
      scanStatus: { ...idleScanStatus, mediaItems: 7 },
      scanSchedule: manualScanSchedule,
    });

    render(<App />);

    await waitFor(() => expect(loadFtpSettingsMock).toHaveBeenCalledWith({ browserUid: "remembered-browser", passphrase: "passphrase" }));
    expect(screen.getByRole("link", { name: "Install in Stremio" }).getAttribute("href")).toBe(
      "stremio://addon.example.test/u/remembered/manifest.json",
    );
    expect(screen.getByText("https://addon.example.test/u/remembered/manifest.json")).toBeTruthy();
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock profile" })).toBeNull();
    expect(screen.getByDisplayValue("ftp.example.test")).toBeTruthy();
    expect(screen.queryByDisplayValue("secret")).toBeNull();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/May 02, 2026, 3:45 PM/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Passed May 02, 2026, 3:40 PM/)).toBeTruthy();
  });

  it("shows only the setup token message on /configure without a token when setup is locked", async () => {
    setupTokenAvailableMock.mockReturnValue(false);
    window.history.pushState({}, "", "/configure");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Setup token required" })).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit addon name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    await waitFor(() => expect(loadSetupStatusMock).toHaveBeenCalled());
  });

  it("shows only the setup token message on / without a token when setup is locked", async () => {
    setupTokenAvailableMock.mockReturnValue(false);
    window.history.pushState({}, "", "/");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Setup token required" })).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit addon name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    await waitFor(() => expect(loadSetupStatusMock).toHaveBeenCalled());
  });

  it("accepts a setup token on /configure without keeping it in the URL", async () => {
    setupTokenAvailableMock.mockReturnValue(false);
    window.history.pushState({}, "", "/configure");
    render(<App />);

    fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "setup-secret-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock configuration" }));

    await waitFor(() => expect(saveSetupTokenMock).toHaveBeenCalledWith("setup-secret-123"));
    expect(markSetupTokenValidatedMock).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Setup token required" })).toBeNull());
    expect(screen.getByRole("button", { name: "Create profile" })).toBeTruthy();
  });

  it("keeps settings locked when an entered setup token is rejected", async () => {
    setupTokenAvailableMock.mockReturnValue(false);
    validateSetupTokenMock.mockRejectedValue(new Error("Invalid setup token"));
    window.history.pushState({}, "", "/configure");
    render(<App />);

    fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "wrong-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock configuration" }));

    await waitFor(() => expect(validateSetupTokenMock).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Setup token required" })).toBeTruthy();
    expect(screen.getByText("Invalid setup token")).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();
  });

  it("keeps settings locked when an existing setup token session is rejected", async () => {
    setupTokenAvailableMock.mockReturnValue(true);
    setupTokenNeedsValidationMock.mockReturnValue(true);
    validateSetupTokenMock.mockRejectedValue(new Error("Invalid setup token"));
    window.history.pushState({}, "", "/configure");
    render(<App />);

    await waitFor(() => expect(validateSetupTokenMock).toHaveBeenCalled());
    expect(saveSetupTokenMock).toHaveBeenCalledWith("");
    expect(screen.getByRole("heading", { name: "Setup token required" })).toBeTruthy();
    expect(screen.getByText("Invalid setup token")).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();
  });

  it("uses an existing setup token session on /configure", async () => {
    setupTokenAvailableMock.mockReturnValue(true);
    window.history.pushState({}, "", "/configure");
    render(<App />);

    expect(screen.queryByRole("heading", { name: "Setup token required" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create profile" })).toBeTruthy();
  });

  it("allows /configure without a setup token when the server has no setup token configured", async () => {
    setupTokenAvailableMock.mockReturnValue(false);
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false });
    window.history.pushState({}, "", "/configure");
    render(<App />);

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Setup token required" })).toBeNull());
    expect(screen.getByRole("button", { name: "Create profile" })).toBeTruthy();
  });

  it("does not auto-load a saved profile on /configure without a setup token when setup is locked", async () => {
    setupTokenAvailableMock.mockReturnValue(false);
    window.history.pushState({}, "", "/configure");
    window.localStorage.setItem("stremio-ftp-recovery-uid", "remembered-browser");
    window.localStorage.setItem("stremio-ftp-passphrase", "passphrase");

    render(<App />);

    await waitFor(() => expect(loadSetupStatusMock).toHaveBeenCalled());
    expect(loadFtpSettingsMock).not.toHaveBeenCalled();
    expect(unlockProfileMock).not.toHaveBeenCalled();
  });

  it("shows recovery uid before passphrase in first-time profile setup", () => {
    render(<App />);

    const fields = screen.getAllByLabelText(/Recovery UID|Passphrase/);
    expect(fields[0].id).toBe("recoveryUid");
    expect(fields[1].id).toBe("passphrase");
  });

  it("offers a copy control for the manifest URL after profile creation", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    expect(await screen.findByRole("button", { name: "Copy manifest URL" })).toBeTruthy();
  });

  it("hides profile-dependent sections before profile setup", () => {
    render(<App />);

    for (const name of ["Test connection", "Save FTP settings", "Rescan"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Delete server" })).toBeNull();
    expect(screen.queryByText("Index status")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Server Settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });

  it("shows error notices in yellow", async () => {
    createProfileMock.mockRejectedValue(new Error("Unable to save profile."));

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    expect(await screen.findByText("Unable to save profile.")).toHaveClass("notification-warning");
  });

  it("saves FTP settings and refreshes the index after profile creation", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveFtpSettingsMock.mockResolvedValue({ ok: true });
    testFtpSettingsMock.mockResolvedValue({
      ok: true,
      connectionStatus: {
        lastTestedAt: "2026-05-02T22:40:00.000Z",
        ok: true,
      },
    });
    rescanIndexMock.mockResolvedValue({
      scanStatus: {
        ...idleScanStatus,
        id: 12,
        status: "running",
        trigger: "manual",
        progressPercent: 25,
        entriesSeen: 500,
        filesSeen: 100,
        directoriesSeen: 12,
        currentPath: "/Movies",
        estimatedSecondsRemaining: 45,
        message: "Scanning FTP library.",
        queuedAt: "2026-05-02T22:44:00.000Z",
        startedAt: "2026-05-02T22:44:01.000Z",
      },
    });
    loadScanStatusMock.mockResolvedValue({
      indexStatus: {
        lastScanAt: "2026-05-02T22:45:00.000Z",
        mediaItems: 3,
      },
      scanStatus: {
        ...idleScanStatus,
        id: 12,
        status: "succeeded",
        trigger: "manual",
        progressPercent: 100,
        filesSeen: 3,
        mediaItems: 3,
        message: "Indexed 3 media files.",
        finishedAt: "2026-05-02T22:45:00.000Z",
      },
      scanSchedule: manualScanSchedule,
      globalStats: {
        totalItems: 3,
        movies: 2,
        series: 0,
        anime: 0,
        uncategorized: 1,
        servers: 1,
        activeScans: 0,
        pendingScans: 0,
        lastCompletedScanAt: "2026-05-02T22:45:00.000Z",
        status: "ready",
      },
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    const recoveryUidValue = recoveryUid.value;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("link", { name: "Install in Stremio" });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "ftp.example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("Root paths"), { target: { value: "/Movies" } });
    fireEvent.click(screen.getByRole("button", { name: "Save FTP settings" }));

    await waitFor(() => {
      expect(saveFtpSettingsMock).toHaveBeenCalledWith({
        browserUid: recoveryUidValue,
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "secret",
          tlsMode: "explicit",
          allowInvalidCertificate: false,
          roots: ["/Movies"],
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(testFtpSettingsMock).toHaveBeenCalledWith({
      browserUid: recoveryUidValue,
      passphrase: "passphrase",
      ftpConfig: {
        host: "ftp.example.test",
        port: 21,
        username: "user",
        password: "secret",
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/Movies"],
      },
    }));
    expect(screen.getByText(/Passed/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(rescanIndexMock).toHaveBeenCalledWith({ browserUid: recoveryUidValue, passphrase: "passphrase" }));
    expect(await screen.findByText("Scanning FTP library.")).toBeTruthy();
    expect(screen.getByText("1 server indexing")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Global indexing progress" })).toHaveAttribute("aria-valuenow", "25");
    await waitFor(() => expect(loadScanStatusMock).toHaveBeenCalledWith({ browserUid: recoveryUidValue, passphrase: "passphrase" }), {
      timeout: 2000,
    });
    expect(await screen.findByText("Indexed 3 media files.")).toBeTruthy();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Uncategorized").length).toBeGreaterThan(0);
    expect(screen.getByText("Last scan May 02, 2026, 3:45 PM")).toBeTruthy();
  });

  it("confirms before unlinking a shared index server when FTP identity changes", async () => {
    window.localStorage.setItem("stremio-ftp-recovery-uid", "browser-uid");
    window.localStorage.setItem("stremio-ftp-passphrase", "passphrase");
    window.localStorage.setItem("stremio-ftp-manifest-url", "https://addon.example.test/u/token/manifest.json");
    window.localStorage.setItem("stremio-ftp-stremio-install-url", "stremio://addon.example.test/u/token/manifest.json");
    const linkedServer = {
      id: 20,
      name: "Server 1",
      ftpConfig: {
        host: "sputnik.whatbox.ca",
        port: 21,
        username: "user",
        password: "",
        passwordConfigured: true,
        tlsMode: "explicit" as const,
        allowInvalidCertificate: false,
        roots: ["/Media"],
      },
      customization: {
        addonName: "Stremio FTP Addon",
        addonLogoUrl: "",
        addonDescription: "Stream movies and series episodes from your own FTP server.",
        catalogEnabled: false,
        ...defaultCatalogOptions,
      },
      indexStatus: { lastScanAt: "2026-05-02T22:45:00.000Z", mediaItems: 42 },
      scanStatus: { ...idleScanStatus, mediaItems: 42 },
      scanSchedule: manualScanSchedule,
      connectionStatus: { lastTestedAt: null, ok: null },
      pendingScanAfter: null,
      sharedIndex: {
        id: 5,
        name: "Sputnik Main",
        keyHint: "sputnik-main",
        linked: true,
        message: "Scanning handled by shared master index.",
      },
    };
    loadServersMock.mockResolvedValue({
      customization: linkedServer.customization,
      servers: [linkedServer],
      globalStats: {
        totalItems: 42,
        movies: 40,
        series: 2,
        anime: 0,
        uncategorized: 0,
        servers: 1,
        activeScans: 0,
        pendingScans: 0,
        lastCompletedScanAt: "2026-05-02T22:45:00.000Z",
        lastCompletedScanNewItems: null,
        status: "ready",
      },
    });
    saveFtpServerMock
      .mockRejectedValueOnce(new Error("Changing this server's FTP host, port, TLS, certificate, or root paths will unlink it from the shared index group."))
      .mockResolvedValueOnce({
        server: {
          ...linkedServer,
          ftpConfig: { ...linkedServer.ftpConfig, roots: ["/Private"] },
          sharedIndex: null,
        },
        globalStats: {
          totalItems: 42,
          movies: 40,
          series: 2,
          anime: 0,
          uncategorized: 0,
          servers: 1,
          activeScans: 0,
          pendingScans: 1,
          lastCompletedScanAt: "2026-05-02T22:45:00.000Z",
          lastCompletedScanNewItems: null,
          status: "working",
        },
      });
    rescanIndexMock.mockResolvedValue({
      scanStatus: { ...idleScanStatus, status: "queued", trigger: "manual", message: "Waiting for scan worker." },
    });
    render(<App />);

    await screen.findByText("Sputnik Main");
    fireEvent.change(screen.getByLabelText("Root paths"), { target: { value: "/Private" } });
    fireEvent.click(screen.getByRole("button", { name: "Save FTP settings" }));

    const unlinkDialog = await screen.findByRole("dialog", { name: "Unlink from Sputnik Main?" });
    expect(within(unlinkDialog).getByText(/Linked servers use one shared scan result/)).toBeTruthy();
    fireEvent.click(within(unlinkDialog).getByRole("button", { name: "Unlink and save" }));
    await waitFor(() => expect(saveFtpServerMock).toHaveBeenCalledTimes(2));
    expect(saveFtpServerMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        serverId: 20,
        ftpConfig: expect.objectContaining({ roots: ["/Private"] }),
      }),
    );
    expect(saveFtpServerMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ serverId: 20, unlinkSharedIndex: true }));
  });

  it("confirms and queues a force reindex from the Rescan All dropdown", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    rescanIndexMock.mockResolvedValue({
      scanStatus: { ...idleScanStatus, status: "queued", trigger: "manual", message: "Waiting for scan worker." },
      servers: [],
      globalStats: {
        totalItems: 0,
        movies: 0,
        series: 0,
        anime: 0,
        uncategorized: 0,
        servers: 1,
        activeScans: 0,
        pendingScans: 1,
        lastCompletedScanAt: null,
        status: "working",
      },
    });
    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUidValue = (screen.getByLabelText("Recovery UID") as HTMLInputElement).value;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("link", { name: "Install in Stremio" });
    fireEvent.click(screen.getByRole("button", { name: "Rescan all options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Force reindex all" }));

    const forceDialog = await screen.findByRole("dialog", { name: "Force reindex all servers?" });
    expect(within(forceDialog).getByText(/clear incremental scan snapshots/)).toBeTruthy();
    fireEvent.click(within(forceDialog).getByRole("button", { name: "Force reindex" }));
    await waitFor(() =>
      expect(rescanIndexMock).toHaveBeenCalledWith({
        browserUid: recoveryUidValue,
        passphrase: "passphrase",
        all: true,
        force: true,
      }),
    );
  });

  it("shows a halt button while a scan is active", async () => {
    window.localStorage.setItem("stremio-ftp-recovery-uid", "browser-uid");
    window.localStorage.setItem("stremio-ftp-passphrase", "passphrase");
    window.localStorage.setItem("stremio-ftp-manifest-url", "https://addon.example.test/u/token/manifest.json");
    window.localStorage.setItem("stremio-ftp-stremio-install-url", "stremio://addon.example.test/u/token/manifest.json");
    loadFtpSettingsMock.mockResolvedValue({
      ftpConfig: {
        host: "ftp.example.test",
        port: 21,
        username: "user",
        password: "",
        passwordConfigured: true,
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/Movies"],
      },
      indexStatus: {
        lastScanAt: null,
        mediaItems: 0,
      },
      scanStatus: {
        ...idleScanStatus,
        id: 12,
        status: "running",
        trigger: "manual",
        progressPercent: 25,
        entriesSeen: 500,
        filesSeen: 100,
        directoriesSeen: 12,
        currentPath: "/Movies",
        estimatedSecondsRemaining: 45,
        message: "Scanning FTP library.",
        queuedAt: "2026-05-02T22:44:00.000Z",
        startedAt: "2026-05-02T22:44:01.000Z",
      },
      scanSchedule: manualScanSchedule,
      connectionStatus: { lastTestedAt: null, ok: null },
    });
    loadCustomizationMock.mockResolvedValue({
      customization: {
        addonName: "Stremio FTP Addon",
        addonLogoUrl: "",
        addonDescription: "Stream movies and series episodes from your own FTP server.",
        catalogEnabled: false,
        ...defaultCatalogOptions,
      },
    });
    cancelScanMock.mockResolvedValue({
      scanStatus: {
        ...idleScanStatus,
        id: 12,
        status: "cancelled",
        trigger: "manual",
        progressPercent: 25,
        message: "Scan halted.",
        finishedAt: "2026-05-02T22:44:10.000Z",
      },
    });

    render(<App />);

    const haltButton = await screen.findByRole("button", { name: "Halt scan" });
    expect(screen.getAllByText("Scanning").length).toBeGreaterThan(0);
    expect(screen.queryByText("Needs attention")).toBeNull();
    fireEvent.click(haltButton);

    await waitFor(() => expect(cancelScanMock).toHaveBeenCalledWith({ browserUid: "browser-uid", passphrase: "passphrase" }));
    expect(await screen.findByText("Scan halted.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rescan" })).toBeEnabled();
  });

  it("saves scan frequency after profile setup", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveScanScheduleMock.mockResolvedValue({
      scanSchedule: {
        intervalMinutes: 720,
        nextScheduledScanAt: "2026-05-03T10:00:00.000Z",
      },
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });

    expect(screen.getByRole("option", { name: "Every 3 days" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Rescan frequency"), { target: { value: "720" } });

    await waitFor(() =>
      expect(saveScanScheduleMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        intervalMinutes: 720,
      }),
    );
  });

  it("saves the catalog toggle after profile setup", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });

    fireEvent.click(screen.getByLabelText("Show content catalogs"));

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Stremio FTP Addon",
          addonLogoUrl: "",
          addonDescription:
            "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
          catalogEnabled: true,
          ...defaultCatalogOptions,
        },
      }),
    );
  });

  it("saves catalog metadata and library parsing options after profile setup", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });

    fireEvent.change(screen.getByLabelText("TMDB API key"), { target: { value: "profile-tmdb-key" } });
    fireEvent.blur(screen.getByLabelText("TMDB API key"));
    fireEvent.click(screen.getByLabelText("Anime"));
    fireEvent.change(screen.getByLabelText("Library layout"), { target: { value: "folders" } });
    fireEvent.change(screen.getByLabelText("Stream delivery"), { target: { value: "direct" } });

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenLastCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Stremio FTP Addon",
          addonLogoUrl: "",
          addonDescription:
            "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
          catalogEnabled: false,
          catalogSort: "alphabetical",
          catalogTmdbApiKey: "profile-tmdb-key",
          combineUncategorizedCatalogs: false,
          catalogContentTypes: { movies: true, series: true, anime: true, uncategorized: true },
          libraryLayout: "folders",
          streamDeliveryMode: "direct",
          streamNameTemplate: defaultCatalogOptions.streamNameTemplate,
          streamDescriptionTemplate: defaultCatalogOptions.streamDescriptionTemplate,
        },
      }),
    );
    expect(screen.getByText(/Direct FTP sends FTP URLs to Stremio clients/)).toBeTruthy();
  });

  it("shows the combined Uncategorized catalog toggle only when multiple catalog servers are eligible", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });
    loadServersMock.mockResolvedValue({
      customization: {
        addonName: "Stremio FTP Addon",
        addonLogoUrl: "",
        addonDescription:
          "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
        catalogEnabled: true,
        catalogTmdbApiKey: "",
        combineUncategorizedCatalogs: false,
        catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
        libraryLayout: "auto",
        streamDeliveryMode: "proxy",
        streamNameTemplate: defaultCatalogOptions.streamNameTemplate,
        streamDescriptionTemplate: defaultCatalogOptions.streamDescriptionTemplate,
      },
      servers: [1, 2].map((id) => ({
        id,
        name: id === 1 ? "Alpha" : "Beta",
        ftpConfig: {
          host: `ftp${id}.example.test`,
          port: 21,
          username: "user",
          password: "",
          passwordConfigured: true,
          tlsMode: "explicit" as const,
          allowInvalidCertificate: false,
          roots: ["/"],
        },
        customization: {
          addonName: "Stremio FTP Addon",
          addonLogoUrl: "",
          addonDescription: "Stream movies and series episodes from your own FTP server.",
          catalogEnabled: true,
          catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
          libraryLayout: "auto" as const,
          streamDeliveryMode: "proxy" as const,
        },
        indexStatus: { lastScanAt: null, mediaItems: 0 },
        scanStatus: { ...idleScanStatus },
        scanSchedule: manualScanSchedule,
        connectionStatus: { lastTestedAt: null, ok: null },
        pendingScanAfter: null,
      })),
      globalStats: {
        totalItems: 0,
        movies: 0,
        series: 0,
        anime: 0,
        uncategorized: 0,
        servers: 2,
        activeScans: 0,
        pendingScans: 0,
        lastCompletedScanAt: null,
        lastCompletedScanNewItems: null,
        status: "idle",
      },
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    const toggle = await screen.findByLabelText("Combine all uncategorized media into single catalog");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenLastCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: expect.objectContaining({ combineUncategorizedCatalogs: true }),
      }),
    );
  });

  it("keeps the FTP catalog enabled when switching to direct stream delivery", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });

    fireEvent.click(screen.getByLabelText("Show content catalogs"));
    fireEvent.change(screen.getByLabelText("Stream delivery"), { target: { value: "direct" } });

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenLastCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Stremio FTP Addon",
          addonLogoUrl: "",
          addonDescription:
            "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
          catalogEnabled: true,
          ...defaultCatalogOptions,
          streamDeliveryMode: "direct",
        },
      }),
    );
  });

  it("saves library settings when the FTP settings save button is clicked", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveFtpSettingsMock.mockResolvedValue({ ok: true });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "ftp.example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByLabelText("Show content catalogs"));
    fireEvent.change(screen.getByLabelText("TMDB API key"), { target: { value: "profile-tmdb-key" } });
    fireEvent.change(screen.getByLabelText("Stream delivery"), { target: { value: "direct" } });
    await waitFor(() => expect(saveCustomizationMock).toHaveBeenCalled());
    saveCustomizationMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Save FTP settings" }));

    await waitFor(() =>
      expect(saveCustomizationMock).toHaveBeenLastCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        customization: {
          addonName: "Stremio FTP Addon",
          addonLogoUrl: "",
          addonDescription:
            "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
          catalogEnabled: true,
          catalogSort: "alphabetical",
          catalogTmdbApiKey: "profile-tmdb-key",
          combineUncategorizedCatalogs: false,
          catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
          libraryLayout: "auto",
          streamDeliveryMode: "direct",
          streamNameTemplate: defaultCatalogOptions.streamNameTemplate,
          streamDescriptionTemplate: defaultCatalogOptions.streamDescriptionTemplate,
        },
      }),
    );
  });

  it("adds a logout control once the profile is ready and resets to the unlock form on click", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("link", { name: "Install in Stremio" });

    const logoutButton = screen.getByRole("button", { name: "Log out" });
    fireEvent.click(logoutButton);

    expect(screen.getByRole("button", { name: "Create profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlock profile" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Install in Stremio" })).toBeNull();
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByText("Index status")).toBeNull();
    expect(window.localStorage.getItem("stremio-ftp-passphrase")).toBeNull();
    expect(window.localStorage.getItem("stremio-ftp-manifest-url")).toBeNull();
    expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("");
  });

  it("hides the manifest panel until at least one server is saved and shows a hint", async () => {
    loadFtpSettingsMock.mockResolvedValue({
      ftpConfig: {
        host: "",
        port: 21,
        username: "",
        password: "",
        passwordConfigured: false,
        tlsMode: "explicit",
        allowInvalidCertificate: false,
        roots: ["/"],
      },
      indexStatus: { lastScanAt: null, mediaItems: 0 },
      connectionStatus: { lastTestedAt: null, ok: null },
      scanStatus: { ...idleScanStatus },
      scanSchedule: manualScanSchedule,
    });
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("button", { name: "Log out" });
    expect(screen.queryByRole("link", { name: "Install in Stremio" })).toBeNull();
    expect(
      screen.getByText("Save at least one server's FTP settings to generate your manifest URL."),
    ).toBeTruthy();
  });

  it("hides the admin dashboard for non-admin profiles", async () => {
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: false, isSuperAdmin: false });
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("button", { name: "Log out" });

    expect(screen.queryByRole("heading", { name: "Admin dashboard" })).toBeNull();
    expect(loadAdminProfilesMock).not.toHaveBeenCalled();
  });

  it("hides the admin dashboard for admin profiles that are not super admins", async () => {
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: true, isSuperAdmin: false });
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "admin-uid",
      manifestUrl: "https://addon.example.test/u/admin/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/admin/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("button", { name: "Log out" });

    expect(screen.queryByRole("heading", { name: "Admin dashboard" })).toBeNull();
    expect(loadAdminProfilesMock).not.toHaveBeenCalled();
  });

  it("shows admin profile summaries for super admin profiles", async () => {
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: false, isSuperAdmin: true });
    loadAdminProfilesMock.mockResolvedValue({
      summary: {
        profiles: 4,
        configuredProfiles: 3,
        ftpServers: 6,
        configuredFtpServers: 5,
        indexedItems: 44,
        activeScans: 0,
        pendingScans: 1,
      },
      profiles: [
        {
          id: 2,
          browserUid: "bf1f80d7-4971-4919-8f4e-ab80aa2de852",
          createdAt: "2026-05-16T00:00:00.000Z",
          updatedAt: "2026-05-16T00:00:00.000Z",
          lastUnlockedAt: null,
          ftpServers: 2,
          configuredFtpServers: 1,
          ftpServerDetails: [
            {
              id: 9,
              name: "Sputnik",
              host: "sputnik.whatbox.ca",
              indexedItems: 1200,
              lastIndexedAt: null,
              sharedIndex: { id: 5, name: "Sputnik Main", keyHint: "sputnik-main", autoLinked: true, lastIndexedAt: "2026-05-16T00:00:00.000Z" },
            },
            {
              id: 10,
              name: "Tamarind",
              host: "tamarind.whatbox.ca",
              indexedItems: 10,
              catalogItemCounts: { movies: 4, anime: 2, series: 3, uncategorized: 1 },
              lastIndexedAt: null,
              sharedIndex: null,
            },
          ],
          indexedItems: 44,
          lastScanAt: null,
          lastManifestAccessedAt: "2026-05-17T01:00:00.000Z",
          activeScans: 0,
          pendingScans: 1,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "CA",
          adminEnabled: false,
          adminSource: null,
        },
        {
          id: 3,
          browserUid: "aa2f80d7-4971-4919-8f4e-ab80aa2de852",
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
          lastUnlockedAt: null,
          ftpServers: 1,
          configuredFtpServers: 1,
          ftpServerDetails: [
            {
              id: 12,
              name: "Whatbox",
              host: "whatbox.example.test",
              lastIndexedAt: "2026-05-16T00:00:00.000Z",
              sharedIndex: { id: 5, name: "Sputnik Main", keyHint: "sputnik-main", autoLinked: false, lastIndexedAt: "2026-05-16T00:00:00.000Z" },
            },
          ],
          indexedItems: 3,
          lastScanAt: "2026-05-16T00:00:00.000Z",
          lastManifestAccessedAt: "2026-05-16T02:00:00.000Z",
          activeScans: 0,
          pendingScans: 0,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "GB",
          adminEnabled: true,
          adminSource: "database",
        },
        {
          id: 4,
          browserUid: "auto80d7-4971-4919-8f4e-ab80aa2de852",
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
          lastUnlockedAt: null,
          ftpServers: 1,
          configuredFtpServers: 1,
          ftpServerDetails: [
            {
              id: 14,
              name: "Auto",
              host: "auto.example.test",
              lastIndexedAt: null,
              sharedIndex: { id: 5, name: "Sputnik Main", keyHint: "sputnik-main", autoLinked: true, lastIndexedAt: "2026-05-16T00:00:00.000Z" },
            },
          ],
          indexedItems: 5,
          lastScanAt: null,
          lastManifestAccessedAt: null,
          activeScans: 0,
          pendingScans: 0,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "US",
          adminEnabled: false,
          adminSource: null,
        },
        {
          id: 5,
          browserUid: "d54b36ac-626f-4e14-b084-ed1c5d33e688",
          createdAt: "2026-06-03T21:26:44.985Z",
          updatedAt: "2026-06-03T21:26:44.985Z",
          lastUnlockedAt: null,
          ftpServers: 2,
          configuredFtpServers: 2,
          ftpServerDetails: [
            {
              id: 16,
              name: "Sputnik",
              host: "sputnik.whatbox.ca",
              lastIndexedAt: null,
              sharedIndex: { id: 5, name: "Sputnik Main", keyHint: "sputnik-main", autoLinked: true, lastIndexedAt: "2026-05-16T00:00:00.000Z" },
            },
            {
              id: 17,
              name: "Tamarind",
              host: "tamarind.whatbox.ca",
              lastIndexedAt: null,
              sharedIndex: { id: 7, name: "Tamarind", keyHint: "tamarind", autoLinked: false, lastIndexedAt: "2026-05-16T00:00:00.000Z" },
            },
          ],
          indexedItems: 22,
          lastScanAt: null,
          lastManifestAccessedAt: null,
          activeScans: 0,
          pendingScans: 0,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "US",
          adminEnabled: false,
          adminSource: null,
        },
      ],
    });
    const sharedGroup = {
      id: 5,
      keyHint: "sputnik-main",
      name: "Sputnik Main",
      host: "sputnik.whatbox.ca",
      port: 21,
      tlsMode: "explicit" as const,
      allowInvalidCertificate: false,
      rootPaths: ["/media"],
      libraryLayout: "auto" as const,
      catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
      enabled: true,
      autoLinkImports: true,
      masterProfileFtpServerId: 9,
      indexedMediaCount: 1200,
      catalogItemCounts: { movies: 640, anime: 45, series: 390, uncategorized: 125 },
      lastIndexedAt: "2026-05-16T00:00:00.000Z",
      linkedServerCount: 12,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      linkedServers: [
        { profileId: 2, browserUid: "bf1f80d7-4971-4919-8f4e-ab80aa2de852", countryCode: "US", serverId: 9, serverName: "Server 1" },
        { profileId: 3, browserUid: "aa2f80d7-4971-4919-8f4e-ab80aa2de852", countryCode: "CA", serverId: 12, serverName: "Whatbox" },
      ],
      masterServer: { profileId: 2, browserUid: "bf1f80d7-4971-4919-8f4e-ab80aa2de852", countryCode: "US", serverId: 9, serverName: "Server 1" },
      scanSchedule: { intervalMinutes: 360, nextScheduledScanAt: "2026-05-16T06:00:00.000Z" },
      scanStatus: { ...idleScanStatus },
    };
    const disabledGroup = {
      ...sharedGroup,
      id: 6,
      keyHint: "disabled",
      name: "Disabled Index",
      enabled: false,
      linkedServerCount: 0,
      masterProfileFtpServerId: null,
      masterServer: null,
    };
    const tamarindGroup = {
      ...sharedGroup,
      id: 7,
      keyHint: "tamarind",
      name: "Tamarind",
      host: "tamarind.whatbox.ca",
      masterProfileFtpServerId: 10,
      linkedServerCount: 1,
      linkedServers: [],
      masterServer: { profileId: 2, browserUid: "bf1f80d7-4971-4919-8f4e-ab80aa2de852", countryCode: "US", serverId: 10, serverName: "Tamarind" },
    };
    loadAdminSharedIndexGroupsMock.mockResolvedValue({ groups: [sharedGroup, tamarindGroup, disabledGroup] });
    setAdminProfileEnabledMock.mockResolvedValue({ profileId: 2, adminEnabled: true, adminSource: "database" });
    rescanAdminProfileMock.mockResolvedValue({ profileId: 2, scanStatus: { ...idleScanStatus, status: "queued", trigger: "manual" } });
    rescanAdminSharedIndexGroupMock.mockResolvedValue({
      group: { ...sharedGroup, scanStatus: { ...idleScanStatus, status: "queued", trigger: "manual" } },
      scanStatus: { ...idleScanStatus, status: "queued", trigger: "manual" },
    });
    rotateAdminSharedIndexKeyMock.mockResolvedValue({ group: sharedGroup, sharedIndexKey: "new-shared-key" });
    linkAdminSharedIndexServerMock.mockResolvedValue({ group: { ...sharedGroup, linkedServerCount: 13 } });
    unlinkAdminSharedIndexServerMock.mockResolvedValue({ group: { ...sharedGroup, linkedServerCount: 11 } });
    issueAdminManifestTokenMock.mockResolvedValue({
      profileId: 2,
      manifestUrl: "https://addon.example.test/u/issued/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/issued/manifest.json",
    });
    deleteAdminSharedIndexGroupMock.mockResolvedValue({ ok: true });
    bulkAdminProfilesMock.mockResolvedValue({ action: "convert_to_proxy", profileIds: [2, 3], converted: 2 });
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "admin-uid",
      manifestUrl: "https://addon.example.test/u/admin/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/admin/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("heading", { name: "Admin dashboard" });
    await screen.findByRole("heading", { name: "Shared index groups" });
    expect(screen.getByText("Sputnik Main")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show linked servers for Sputnik Main" })).toHaveTextContent("12");
    expect(screen.getByLabelText("Sputnik Main catalog content types")).toHaveTextContent("Movie");
    expect(screen.getByLabelText("Sputnik Main catalog content types")).toHaveTextContent("640");
    expect(screen.getByLabelText("Sputnik Main catalog content types")).toHaveTextContent("Other");
    expect(screen.getByLabelText("Sputnik Main catalog content types")).toHaveTextContent("125");
    expect(screen.getAllByText("Master").length).toBeGreaterThan(0);
    expect(screen.getByText("bf1f80d7-4971-4 / Server 1")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Manifest" })).toBeNull();
    const partialRow = screen.getByRole("button", { name: "Copy recovery UID bf1f80d7-4971-4919-8f4e-ab80aa2de852" }).closest("tr")!;
    expect(within(partialRow).getByText("Pending")).toBeTruthy();
    expect(within(partialRow).getByText("Partial")).toBeTruthy();
    const linkedRow = screen.getByRole("button", { name: "Copy recovery UID aa2f80d7-4971-4919-8f4e-ab80aa2de852" }).closest("tr")!;
    expect(within(linkedRow).getByText("Linked")).toBeTruthy();
    const autoLinkedRow = screen.getByRole("button", { name: "Copy recovery UID auto80d7-4971-4919-8f4e-ab80aa2de852" }).closest("tr")!;
    expect(within(autoLinkedRow).getByText("Auto-L")).toBeTruthy();
    const allLinkedMixedRow = screen.getByRole("button", { name: "Copy recovery UID d54b36ac-626f-4e14-b084-ed1c5d33e688" }).closest("tr")!;
    expect(within(allLinkedMixedRow).getByText("Linked")).toBeTruthy();
    expect(within(allLinkedMixedRow).queryByText("Partial")).toBeNull();
    expect(screen.getByRole("columnheader", { name: /Last used/ })).toBeTruthy();
    expect(screen.getAllByText("May 16, 2026, 6:00 PM").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Profile ID for Sputnik Main")).toBeNull();
    expect(screen.queryByLabelText("Server ID for Sputnik Main")).toBeNull();
    expect(screen.queryByRole("button", { name: "Link server to Sputnik Main" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set master for Sputnik Main" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlink server from Sputnik Main" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show linked servers for Sputnik Main" }));
    const linkedServersDialog = await screen.findByRole("dialog", { name: "Sputnik Main" });
    expect(within(linkedServersDialog).getByText("Whatbox")).toBeTruthy();
    fireEvent.click(within(linkedServersDialog).getByRole("button", { name: "Close linked servers" }));
    fireEvent.click(screen.getByRole("button", { name: /1\/2 linked/ }));
    const serverDialog = await screen.findByRole("dialog", { name: "bf1f80d7-4971-4" });
    expect(within(serverDialog).getByText("Auto-L")).toBeTruthy();
    expect(within(serverDialog).getByText("Unlinked")).toBeTruthy();
    expect(within(serverDialog).getByText("May 15, 2026, 5:00 PM")).toBeTruthy();
    expect(within(serverDialog).getByText("1,210 total")).toBeTruthy();
    expect(within(serverDialog).getByRole("columnheader", { name: "Movie" })).toBeTruthy();
    expect(within(serverDialog).getByRole("columnheader", { name: "Series" })).toBeTruthy();
    expect(within(serverDialog).getByRole("columnheader", { name: "Anime" })).toBeTruthy();
    expect(within(serverDialog).getByRole("columnheader", { name: "Other" })).toBeTruthy();
    const sputnikServerRow = within(serverDialog).getByText("Sputnik").closest("tr")!;
    expect(within(sputnikServerRow).getByText("640")).toBeTruthy();
    expect(within(sputnikServerRow).getByText("390")).toBeTruthy();
    expect(within(sputnikServerRow).getByText("45")).toBeTruthy();
    expect(within(sputnikServerRow).getByText("125")).toBeTruthy();
    const tamarindServerRow = within(serverDialog).getAllByText("Tamarind").find((element) => element.tagName === "STRONG")!.closest("tr")!;
    expect(within(tamarindServerRow).getByText("4")).toBeTruthy();
    expect(within(tamarindServerRow).getByText("3")).toBeTruthy();
    expect(within(tamarindServerRow).getByText("2")).toBeTruthy();
    expect(within(tamarindServerRow).getByText("1")).toBeTruthy();
    expect(within(serverDialog).queryByRole("button", { name: "Create group" })).toBeNull();
    fireEvent.click(within(serverDialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() =>
      expect(unlinkAdminSharedIndexServerMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        groupId: 5,
        profileId: 2,
        serverId: 9,
      }),
    );
    const linkCallsBeforeSelection = linkAdminSharedIndexServerMock.mock.calls.length;
    fireEvent.click(within(serverDialog).getByRole("button", { name: "Link" }));
    expect(linkAdminSharedIndexServerMock).toHaveBeenCalledTimes(linkCallsBeforeSelection);
    expect(await screen.findByText("Choose a shared index group before linking this server.")).toBeTruthy();
    fireEvent.change(within(serverDialog).getByLabelText("Shared index group for Tamarind"), { target: { value: "5" } });
    fireEvent.click(within(serverDialog).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(linkAdminSharedIndexServerMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        groupId: 5,
        profileId: 2,
        serverId: 10,
      }),
    );
    fireEvent.click(within(serverDialog).getByRole("button", { name: "Close server list" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select bf1f80d7-4971-4919-8f4e-ab80aa2de852" }));
    fireEvent.click(screen.getByRole("button", { name: "Bulk link servers" }));
    const bulkLinkDialog = await screen.findByRole("dialog", { name: "Link selected servers" });
    expect(within(bulkLinkDialog).getByText("Sputnik")).toBeTruthy();
    expect(within(bulkLinkDialog).getAllByText("Tamarind").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Shared index group for Sputnik")).toHaveValue("5");
    linkAdminSharedIndexServerMock.mockRejectedValueOnce(new Error("FTP server does not match shared index group"));
    fireEvent.click(within(bulkLinkDialog).getByRole("button", { name: "Link server buckets" }));
    await waitFor(() =>
      expect(linkAdminSharedIndexServerMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        groupId: 5,
        profileId: 2,
        serverId: 9,
      }),
    );
    expect(await within(bulkLinkDialog).findByText("FTP server does not match shared index group")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rescan Sputnik Main" }));
    await waitFor(() =>
      expect(rescanAdminSharedIndexGroupMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        groupId: 5,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate key for Sputnik Main" }));
    const rotateDialog = await screen.findByRole("dialog", { name: "Rotate key for Sputnik Main?" });
    expect(rotateAdminSharedIndexKeyMock).not.toHaveBeenCalled();
    fireEvent.click(within(rotateDialog).getByRole("button", { name: "Cancel" }));
    expect(rotateAdminSharedIndexKeyMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rotate key for Sputnik Main" }));
    const confirmedRotateDialog = await screen.findByRole("dialog", { name: "Rotate key for Sputnik Main?" });
    fireEvent.click(within(confirmedRotateDialog).getByRole("button", { name: "Rotate key" }));
    await waitFor(() =>
      expect(rotateAdminSharedIndexKeyMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        groupId: 5,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete Disabled Index" }));
    const deleteDialog = await screen.findByRole("dialog", { name: "Delete Disabled Index?" });
    expect(deleteAdminSharedIndexGroupMock).not.toHaveBeenCalled();
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Cancel" }));
    expect(deleteAdminSharedIndexGroupMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Disabled Index" }));
    const confirmedDeleteDialog = await screen.findByRole("dialog", { name: "Delete Disabled Index?" });
    fireEvent.click(within(confirmedDeleteDialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() =>
      expect(deleteAdminSharedIndexGroupMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        groupId: 6,
      }),
    );
    const uidButton = await screen.findByRole("button", { name: "Copy recovery UID bf1f80d7-4971-4919-8f4e-ab80aa2de852" });
    expect(uidButton).toHaveTextContent("🇨🇦");
    expect(uidButton).toHaveTextContent("bf1f80d7-4971");
    expect(uidButton).not.toHaveTextContent("bf1f80d7-4971-4919-8f4e-ab80aa2de852");
    expect(uidButton).toHaveAttribute("title", "CA");
    fireEvent.click(uidButton);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("bf1f80d7-4971-4919-8f4e-ab80aa2de852");
    fireEvent.click(screen.getByRole("button", { name: "Issue manifest URL for bf1f80d7-4971-4919-8f4e-ab80aa2de852" }));
    await waitFor(() =>
      expect(issueAdminManifestTokenMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        profileId: 2,
      }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://addon.example.test/u/issued/manifest.json");
    expect(screen.queryByRole("columnheader", { name: "Country" })).toBeNull();
    expect(screen.getAllByText("44").length).toBeGreaterThan(0);
    expect(loadAdminProfilesMock).toHaveBeenCalledWith(expect.objectContaining({ passphrase: "passphrase" }));
    bulkAdminProfilesMock.mockResolvedValueOnce({ action: "rescan", profileIds: [2], scans: [], summary: { profiles: 1, servers: 1, queued: 1, skipped: 0 } });
    fireEvent.click(screen.getByRole("button", { name: "Rescan bf1f80d7-4971-4919-8f4e-ab80aa2de852" }));
    const profileRefreshDialog = await screen.findByRole("dialog", { name: "Refresh 1 unlinked server?" });
    fireEvent.click(within(profileRefreshDialog).getByRole("button", { name: "Refresh unlinked" }));
    await waitFor(() =>
      expect(bulkAdminProfilesMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        profileIds: [2],
        action: "rescan",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort by Indexed" }));
    let uidButtons = screen.getAllByRole("button", { name: /^Copy recovery UID / });
    expect(uidButtons[0]).toHaveAccessibleName("Copy recovery UID aa2f80d7-4971-4919-8f4e-ab80aa2de852");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Indexed" }));
    uidButtons = screen.getAllByRole("button", { name: /^Copy recovery UID / });
    expect(uidButtons[0]).toHaveAccessibleName("Copy recovery UID bf1f80d7-4971-4919-8f4e-ab80aa2de852");

    fireEvent.change(screen.getByLabelText("Search profiles"), { target: { value: "missing-uid" } });
    expect(screen.queryByRole("button", { name: "Copy recovery UID bf1f80d7-4971-4919-8f4e-ab80aa2de852" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search profiles"), { target: { value: "bf1f80d7" } });
    expect(screen.getByRole("button", { name: "Copy recovery UID bf1f80d7-4971-4919-8f4e-ab80aa2de852" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Promote bf1f80d7-4971-4919-8f4e-ab80aa2de852 to admin" }));
    await waitFor(() =>
      expect(setAdminProfileEnabledMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        profileId: 2,
        adminEnabled: true,
      }),
    );
    await waitFor(() => expect(screen.getAllByLabelText("Admin").length).toBeGreaterThan(0));
  });

  it("renames shared index groups from the title", async () => {
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: false, isSuperAdmin: true });
    const sharedGroup = {
      id: 5,
      keyHint: "sputnik-main",
      name: "Sputnik Main",
      host: "sputnik.whatbox.ca",
      port: 21,
      tlsMode: "explicit" as const,
      allowInvalidCertificate: false,
      rootPaths: ["/media"],
      libraryLayout: "auto" as const,
      catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
      enabled: true,
      autoLinkImports: true,
      masterProfileFtpServerId: 9,
      indexedMediaCount: 1200,
      catalogItemCounts: { movies: 640, anime: 45, series: 390, uncategorized: 125 },
      lastIndexedAt: "2026-05-16T00:00:00.000Z",
      linkedServerCount: 12,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      linkedServers: [],
      masterServer: { profileId: 2, browserUid: "bf1f80d7-4971-4919-8f4e-ab80aa2de852", countryCode: "US", serverId: 9, serverName: "Server 1" },
      scanSchedule: { intervalMinutes: 360, nextScheduledScanAt: "2026-05-16T06:00:00.000Z" },
      scanStatus: { ...idleScanStatus },
    };
    loadAdminSharedIndexGroupsMock.mockResolvedValue({ groups: [sharedGroup] });
    updateAdminSharedIndexGroupMock.mockResolvedValue({ group: { ...sharedGroup, name: "Renamed Pool" } });
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "admin-uid",
      manifestUrl: "https://addon.example.test/u/admin/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/admin/manifest.json",
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("heading", { name: "Admin dashboard" });
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Sputnik Main" }));
    const renameInput = await screen.findByLabelText("Rename Sputnik Main");
    fireEvent.change(renameInput, { target: { value: "Renamed Pool" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    await waitFor(() =>
      expect(updateAdminSharedIndexGroupMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        groupId: 5,
        name: "Renamed Pool",
        enabled: true,
        autoLinkImports: true,
      }),
    );
    expect(await screen.findByRole("button", { name: "Renamed Pool" })).toBeTruthy();
  });

  it("performs bulk admin actions for selected profiles", async () => {
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: false, isSuperAdmin: true });
    loadAdminProfilesMock.mockResolvedValue({
      summary: {
        profiles: 2,
        configuredProfiles: 2,
        ftpServers: 2,
        configuredFtpServers: 2,
        indexedItems: 47,
        activeScans: 0,
        pendingScans: 0,
      },
      profiles: [
        {
          id: 2,
          browserUid: "first-user-uid",
          createdAt: "2026-05-16T00:00:00.000Z",
          updatedAt: "2026-05-16T00:00:00.000Z",
          lastUnlockedAt: null,
          ftpServers: 1,
          configuredFtpServers: 1,
          indexedItems: 44,
          lastScanAt: null,
          lastManifestAccessedAt: null,
          activeScans: 0,
          pendingScans: 0,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "CA",
          adminEnabled: false,
          adminSource: null,
        },
        {
          id: 3,
          browserUid: "second-user-uid",
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
          lastUnlockedAt: null,
          ftpServers: 1,
          configuredFtpServers: 1,
          indexedItems: 3,
          lastScanAt: null,
          lastManifestAccessedAt: null,
          activeScans: 0,
          pendingScans: 0,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "GB",
          adminEnabled: false,
          adminSource: null,
        },
      ],
    });
    bulkAdminProfilesMock
      .mockResolvedValueOnce({
        action: "rescan",
        profileIds: [2, 3],
        scans: [
          { profileId: 2, serverId: 20, serverName: "Main", scanStatus: { ...idleScanStatus, status: "queued", trigger: "manual" } },
          { profileId: 3, serverId: 30, serverName: "Main", scanStatus: { ...idleScanStatus, status: "queued", trigger: "manual" } },
        ],
        summary: { profiles: 2, servers: 2, queued: 2, running: 0, halting: 0, cancelled: 0, skipped: 0, failed: 0 },
      })
      .mockResolvedValueOnce({
        action: "convert_to_proxy",
        profileIds: [2, 3],
        converted: 2,
        summary: { profiles: 2, servers: 2, converted: 2 },
      })
      .mockResolvedValueOnce({ action: "delete", profileIds: [2, 3], deleted: 2, summary: { profiles: 2, deleted: 2 } });
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "admin-uid",
      manifestUrl: "https://addon.example.test/u/admin/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/admin/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });
    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("heading", { name: "Admin dashboard" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select first-user-uid" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select second-user-uid" }));

    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rescan selected" }));
    await waitFor(() =>
      expect(bulkAdminProfilesMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        profileIds: [2, 3],
        action: "rescan",
      }),
    );
    expect(within(await screen.findByRole("dialog", { name: "Bulk action status" })).getByText("2 queued")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close bulk action status" }));

    fireEvent.click(screen.getByRole("button", { name: "Convert selected to proxy" }));
    await waitFor(() =>
      expect(bulkAdminProfilesMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        profileIds: [2, 3],
        action: "convert_to_proxy",
      }),
    );
    expect(within(await screen.findByRole("dialog", { name: "Bulk action status" })).getByText("2 converted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close bulk action status" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    const deleteSelectedDialog = await screen.findByRole("dialog", { name: "Delete 2 selected profiles?" });
    fireEvent.click(within(deleteSelectedDialog).getByRole("button", { name: "Delete selected" }));
    await waitFor(() =>
      expect(bulkAdminProfilesMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        profileIds: [2, 3],
        action: "delete",
      }),
    );
  });

  it("halts selected admin scans when selected profiles are already scanning", async () => {
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false, isAdmin: false, isSuperAdmin: true });
    loadAdminProfilesMock.mockResolvedValue({
      summary: {
        profiles: 1,
        configuredProfiles: 1,
        ftpServers: 2,
        configuredFtpServers: 2,
        indexedItems: 0,
        activeScans: 1,
        pendingScans: 1,
      },
      profiles: [
        {
          id: 2,
          browserUid: "first-user-uid",
          createdAt: "2026-05-16T00:00:00.000Z",
          updatedAt: "2026-05-16T00:00:00.000Z",
          lastUnlockedAt: null,
          ftpServers: 2,
          configuredFtpServers: 2,
          indexedItems: 0,
          lastScanAt: null,
          lastManifestAccessedAt: null,
          activeScans: 1,
          pendingScans: 1,
          manifestUrl: null,
          stremioInstallUrl: null,
          lastCountryCode: "CA",
          adminEnabled: false,
          adminSource: null,
        },
      ],
    });
    bulkAdminProfilesMock.mockResolvedValueOnce({
      action: "cancel_scan",
      profileIds: [2],
      scans: [
        { profileId: 2, serverId: 20, serverName: "Main", scanStatus: { ...idleScanStatus, status: "cancelled", trigger: "manual", message: "Scan halted." } },
        { profileId: 2, serverId: 21, serverName: "Mirror", scanStatus: { ...idleScanStatus, status: "cancelled", trigger: "manual", message: "Scan halted." } },
      ],
      summary: { profiles: 1, servers: 2, queued: 0, running: 0, halting: 0, cancelled: 2, skipped: 0, failed: 0 },
    });
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "admin-uid",
      manifestUrl: "https://addon.example.test/u/admin/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/admin/manifest.json",
    });
    saveCustomizationMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("heading", { name: "Admin dashboard" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select first-user-uid" }));
    fireEvent.click(screen.getByRole("button", { name: "Halt selected scans" }));

    await waitFor(() =>
      expect(bulkAdminProfilesMock).toHaveBeenCalledWith({
        browserUid: expect.any(String),
        passphrase: "passphrase",
        profileIds: [2],
        action: "cancel_scan",
      }),
    );
    expect(within(await screen.findByRole("dialog", { name: "Bulk action status" })).getByText("2 cancelled")).toBeTruthy();
  });
});
