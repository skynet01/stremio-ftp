/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App";
import {
  cancelScan,
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
} from "../src/web/api";

vi.mock("../src/web/api", () => ({
  cancelScan: vi.fn(),
  createProfile: vi.fn(),
  loadCustomization: vi.fn(),
  loadFtpSettings: vi.fn(),
  loadScanStatus: vi.fn(),
  loadSetupStatus: vi.fn(),
  rescanIndex: vi.fn(),
  saveCustomization: vi.fn(),
  saveFtpSettings: vi.fn(),
  saveScanSchedule: vi.fn(),
  saveSetupToken: vi.fn(),
  setupTokenAvailable: vi.fn(),
  testFtpSettings: vi.fn(),
  unlockProfile: vi.fn(),
}));

const cancelScanMock = vi.mocked(cancelScan);
const createProfileMock = vi.mocked(createProfile);
const loadCustomizationMock = vi.mocked(loadCustomization);
const loadFtpSettingsMock = vi.mocked(loadFtpSettings);
const loadScanStatusMock = vi.mocked(loadScanStatus);
const loadSetupStatusMock = vi.mocked(loadSetupStatus);
const rescanIndexMock = vi.mocked(rescanIndex);
const saveCustomizationMock = vi.mocked(saveCustomization);
const saveFtpSettingsMock = vi.mocked(saveFtpSettings);
const saveScanScheduleMock = vi.mocked(saveScanSchedule);
const saveSetupTokenMock = vi.mocked(saveSetupToken);
const setupTokenAvailableMock = vi.mocked(setupTokenAvailable);
const testFtpSettingsMock = vi.mocked(testFtpSettings);
const unlockProfileMock = vi.mocked(unlockProfile);
const defaultCatalogOptions = {
  catalogTmdbApiKey: "",
  catalogContentTypes: { movies: true, series: true, anime: false },
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
};
const manualScanSchedule = {
  intervalMinutes: 0,
  nextScheduledScanAt: null,
};

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    cancelScanMock.mockReset();
    createProfileMock.mockReset();
    loadCustomizationMock.mockReset();
    loadFtpSettingsMock.mockReset();
    loadScanStatusMock.mockReset();
    loadSetupStatusMock.mockReset();
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: true });
    rescanIndexMock.mockReset();
    saveCustomizationMock.mockReset();
    saveFtpSettingsMock.mockReset();
    saveScanScheduleMock.mockReset();
    saveSetupTokenMock.mockReset();
    setupTokenAvailableMock.mockReset();
    setupTokenAvailableMock.mockReturnValue(false);
    testFtpSettingsMock.mockReset();
    unlockProfileMock.mockReset();
  });

  it("renders the FTP configuration portal", () => {
    render(<App />);
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
    expect(screen.getByLabelText("TMDB API key")).toBeTruthy();
    expect(screen.getByLabelText("Library layout")).toBeTruthy();
    expect(screen.getByLabelText("Stream delivery")).toBeTruthy();
    const serverContent = screen.getByRole("group", { name: "Server content types" });
    expect(within(serverContent).getByText("Server content")).toBeTruthy();
    expect(within(serverContent).getByLabelText("Movies")).toBeTruthy();
    expect(within(serverContent).getByLabelText("Series")).toBeTruthy();
    expect(within(serverContent).getByLabelText("Anime")).toBeTruthy();
    expect(within(serverContent).getByLabelText("Show indexed FTP catalog in Stremio")).toBeTruthy();
    expect(screen.getByText(`Copyright ${new Date().getFullYear()} Stremio FTP Addon. v0.4.7`)).toBeTruthy();
    expect(screen.getByText("Not responsible for files, streams, or other content hosted on connected servers.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Changelog" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub repository" }).getAttribute("href")).toBe(
      "https://github.com/skynet01/stremio-ftp",
    );
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
    fireEvent.change(descriptionFormatter, {
      target: { value: "{stream.filename}{tools.newLine}{stream.size::bytes}" },
    });

    expect(screen.getByText("Stremio FTP Addon | Server 1 | 2160p")).toBeTruthy();
    expect(screen.getByText("The.Matrix.1999.2160p.DV.HDR10.HEVC.TrueHD.Atmos.7.1.mkv")).toBeTruthy();
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
          catalogTmdbApiKey: "",
          catalogContentTypes: { movies: true, series: true, anime: false },
          libraryLayout: "auto",
          streamDeliveryMode: "proxy",
          streamNameTemplate: "{addon.name} | {stream.serverName} | {stream.quality}",
          streamDescriptionTemplate: "{stream.filename}{tools.newLine}{stream.size::bytes}",
        },
      }),
    );
  });

  it("opens a footer changelog drawer with recent commits", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Changelog" }));

    expect(screen.getByRole("dialog", { name: "Latest changes" })).toBeTruthy();
    expect(screen.getAllByText("fix").length).toBeGreaterThan(0);
    expect(screen.getByText("save library settings with ftp settings")).toBeTruthy();
    expect(screen.queryByText("fix: save library settings with ftp settings")).toBeNull();
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
    window.history.pushState({}, "", "/configure");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Setup token required" })).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    await waitFor(() => expect(loadSetupStatusMock).toHaveBeenCalled());
  });

  it("accepts a setup token on /configure without keeping it in the URL", async () => {
    window.history.pushState({}, "", "/configure");
    render(<App />);

    fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "setup-secret-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock configuration" }));

    await waitFor(() => expect(saveSetupTokenMock).toHaveBeenCalledWith("setup-secret-123"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Setup token required" })).toBeNull());
    expect(screen.getByLabelText("Host")).toBeTruthy();
  });

  it("uses an existing setup token session on /configure", async () => {
    setupTokenAvailableMock.mockReturnValue(true);
    window.history.pushState({}, "", "/configure");
    render(<App />);

    expect(screen.queryByRole("heading", { name: "Setup token required" })).toBeNull();
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect(loadSetupStatusMock).not.toHaveBeenCalled();
  });

  it("allows /configure without a setup token when the server has no setup token configured", async () => {
    loadSetupStatusMock.mockResolvedValue({ setupTokenRequired: false });
    window.history.pushState({}, "", "/configure");
    render(<App />);

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Setup token required" })).toBeNull());
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create profile" })).toBeTruthy();
  });

  it("does not auto-load a saved profile on /configure without a setup token when setup is locked", async () => {
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

  it("keeps profile-dependent controls disabled before profile setup", () => {
    render(<App />);

    for (const name of ["Test connection", "Save FTP settings", "Rescan"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeDisabled();
    }
    const deleteButton = screen.getByRole("button", { name: "Delete server" });
    const testButton = screen.getByRole("button", { name: "Test connection" });
    const rescanButton = screen.getByRole("button", { name: "Rescan" });
    const saveButton = screen.getByRole("button", { name: "Save FTP settings" });
    expect(deleteButton).toHaveClass("icon-button");
    expect(Boolean(deleteButton.compareDocumentPosition(testButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(testButton.compareDocumentPosition(rescanButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(rescanButton.compareDocumentPosition(saveButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
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
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "ftp.example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("Root paths"), { target: { value: "/Movies" } });
    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    const recoveryUidValue = recoveryUid.value;
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    await screen.findByRole("link", { name: "Install in Stremio" });
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
    expect(screen.getByText("Uncategorized")).toBeTruthy();
    expect(screen.getByText("Last scan May 02, 2026, 3:45 PM")).toBeTruthy();
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

    fireEvent.click(screen.getByLabelText("Show indexed FTP catalog in Stremio"));

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
          catalogTmdbApiKey: "profile-tmdb-key",
          catalogContentTypes: { movies: true, series: true, anime: true },
          libraryLayout: "folders",
          streamDeliveryMode: "direct",
          streamNameTemplate: defaultCatalogOptions.streamNameTemplate,
          streamDescriptionTemplate: defaultCatalogOptions.streamDescriptionTemplate,
        },
      }),
    );
    expect(screen.getByText(/Direct FTP sends FTP URLs to Stremio clients/)).toBeTruthy();
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

    fireEvent.click(screen.getByLabelText("Show indexed FTP catalog in Stremio"));
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
    fireEvent.click(screen.getByLabelText("Show indexed FTP catalog in Stremio"));
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
          catalogTmdbApiKey: "profile-tmdb-key",
          catalogContentTypes: { movies: true, series: true, anime: false },
          libraryLayout: "auto",
          streamDeliveryMode: "direct",
          streamNameTemplate: defaultCatalogOptions.streamNameTemplate,
          streamDescriptionTemplate: defaultCatalogOptions.streamDescriptionTemplate,
        },
      }),
    );
  });

  it("creates the profile and saves filled FTP settings in one setup action", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveFtpSettingsMock.mockResolvedValue({ ok: true });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "ftp.example.test" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "2121" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("Root paths"), { target: { value: "/" } });

    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    await waitFor(() => {
      expect(saveFtpSettingsMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
        ftpConfig: {
          host: "ftp.example.test",
          port: 2121,
          username: "user",
          password: "secret",
          tlsMode: "explicit",
          allowInvalidCertificate: false,
          roots: ["/"],
        },
      });
    });
    expect(await screen.findByText("Profile created. FTP settings saved. Install link is ready.")).toBeTruthy();
  });
});
