/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App";
import {
  createProfile,
  loadCustomization,
  loadFtpSettings,
  rescanIndex,
  saveCustomization,
  saveFtpSettings,
  testFtpSettings,
  unlockProfile,
} from "../src/web/api";

vi.mock("../src/web/api", () => ({
  createProfile: vi.fn(),
  loadCustomization: vi.fn(),
  loadFtpSettings: vi.fn(),
  rescanIndex: vi.fn(),
  saveCustomization: vi.fn(),
  saveFtpSettings: vi.fn(),
  testFtpSettings: vi.fn(),
  unlockProfile: vi.fn(),
}));

const createProfileMock = vi.mocked(createProfile);
const loadCustomizationMock = vi.mocked(loadCustomization);
const loadFtpSettingsMock = vi.mocked(loadFtpSettings);
const rescanIndexMock = vi.mocked(rescanIndex);
const saveCustomizationMock = vi.mocked(saveCustomization);
const saveFtpSettingsMock = vi.mocked(saveFtpSettings);
const testFtpSettingsMock = vi.mocked(testFtpSettings);
const unlockProfileMock = vi.mocked(unlockProfile);

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    createProfileMock.mockReset();
    loadCustomizationMock.mockReset();
    loadFtpSettingsMock.mockReset();
    rescanIndexMock.mockReset();
    saveCustomizationMock.mockReset();
    saveFtpSettingsMock.mockReset();
    testFtpSettingsMock.mockReset();
    unlockProfileMock.mockReset();
  });

  it("renders the FTP configuration portal", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Stremio FTP Addon" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit addon name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit addon avatar" })).toBeTruthy();
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect((screen.getByLabelText("Root paths") as HTMLTextAreaElement).value).toBe("/");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    expect(screen.getByText("Index status")).toBeTruthy();
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
        password: "secret",
        passwordConfigured: true,
        tlsMode: "explicit",
        allowInvalidCertificate: true,
        roots: ["/Movies", "/TV"],
      },
    });
    loadCustomizationMock.mockResolvedValue({
      customization: {
        addonName: "Archive 3D",
        addonLogoUrl: "https://cdn.example.test/logo.png",
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
    expect(screen.getByRole("link", { name: "Install in Stremio" }).getAttribute("href")).toBe(
      "stremio://addon.example.test/u/unlocked/manifest.json",
    );
    expect(screen.getByText("https://addon.example.test/u/unlocked/manifest.json")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unlock profile" })).toBeNull();
    expect(screen.getByDisplayValue("ftp.example.test")).toBeTruthy();
    expect(screen.getByDisplayValue("2121")).toBeTruthy();
    expect(screen.getByDisplayValue("secret")).toBeTruthy();
    expect((screen.getByLabelText("Root paths") as HTMLTextAreaElement).value).toBe("/Movies\n/TV");
    expect(screen.getByText("Profile unlocked. Saved FTP settings loaded.")).toBeTruthy();
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
      },
    });
    loadFtpSettingsMock.mockResolvedValue({
      ftpConfig: {
        host: "ftp.example.test",
        port: 13017,
        username: "user",
        password: "secret",
        passwordConfigured: true,
        tlsMode: "explicit",
        allowInvalidCertificate: true,
        roots: ["/"],
      },
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
    expect(screen.getByDisplayValue("secret")).toBeTruthy();
  });

  it("shows only the setup token message on /configure without a token", () => {
    window.history.pushState({}, "", "/configure");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Setup token required" })).toBeTruthy();
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
  });

  it("does not auto-load a saved profile on /configure without a setup token", () => {
    window.history.pushState({}, "", "/configure");
    window.localStorage.setItem("stremio-ftp-recovery-uid", "remembered-browser");
    window.localStorage.setItem("stremio-ftp-passphrase", "passphrase");

    render(<App />);

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

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("saves FTP settings and refreshes the index after profile creation", async () => {
    createProfileMock.mockResolvedValue({
      profileId: 1,
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });
    saveFtpSettingsMock.mockResolvedValue({ ok: true });
    testFtpSettingsMock.mockResolvedValue({ ok: true });
    rescanIndexMock.mockResolvedValue({ filesSeen: 3 });

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

    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(rescanIndexMock).toHaveBeenCalledWith({ browserUid: recoveryUidValue, passphrase: "passphrase" }));
    expect(await screen.findByText("Indexed 3 media files.")).toBeTruthy();
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
