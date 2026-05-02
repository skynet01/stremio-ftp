/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App";
import { createProfile, rescanIndex, saveFtpSettings, testFtpSettings, unlockProfile } from "../src/web/api";

vi.mock("../src/web/api", () => ({
  createProfile: vi.fn(),
  rescanIndex: vi.fn(),
  saveFtpSettings: vi.fn(),
  testFtpSettings: vi.fn(),
  unlockProfile: vi.fn(),
}));

const createProfileMock = vi.mocked(createProfile);
const rescanIndexMock = vi.mocked(rescanIndex);
const saveFtpSettingsMock = vi.mocked(saveFtpSettings);
const testFtpSettingsMock = vi.mocked(testFtpSettings);
const unlockProfileMock = vi.mocked(unlockProfile);

describe("App", () => {
  beforeEach(() => {
    createProfileMock.mockReset();
    rescanIndexMock.mockReset();
    saveFtpSettingsMock.mockReset();
    testFtpSettingsMock.mockReset();
    unlockProfileMock.mockReset();
  });

  it("renders the FTP configuration portal", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "FTP Streams" })).toBeTruthy();
    expect(screen.getByLabelText("Host")).toBeTruthy();
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
      expect(screen.getByRole("heading", { name: "FTP Streams" })).toBeTruthy();
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
      profileId: "profile-1",
      recoveryUid: "browser-uid",
      manifestUrl: "https://addon.example.test/u/token/manifest.json",
      stremioInstallUrl: "stremio://addon.example.test/u/token/manifest.json",
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

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
    expect(unlockProfileMock).not.toHaveBeenCalled();
  });

  it("unlocks an existing profile without inventing an install link", async () => {
    createProfileMock.mockRejectedValue(new Error("Profile already exists"));
    unlockProfileMock.mockResolvedValue({ profileId: "profile-1" });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    await waitFor(() => {
      expect(unlockProfileMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
        passphrase: "passphrase",
      });
    });

    expect(screen.queryByRole("link", { name: "Install in Stremio" })).toBeNull();
    expect(screen.getByRole("button", { name: "Install in Stremio" })).toBeDisabled();
    expect(screen.getByText("Profile unlocked. Create in this browser session to get an install link.")).toBeTruthy();
  });

  it("keeps profile-dependent controls disabled before profile setup", () => {
    render(<App />);

    for (const name of ["Test connection", "Save FTP settings", "Rescan"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeDisabled();
    }

    for (const name of ["Pause", "Rotate", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("saves FTP settings and refreshes the index after profile creation", async () => {
    createProfileMock.mockResolvedValue({
      profileId: "profile-1",
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
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await screen.findByRole("link", { name: "Install in Stremio" });
    fireEvent.click(screen.getByRole("button", { name: "Save FTP settings" }));

    const recoveryUid = screen.getByLabelText("Recovery UID") as HTMLInputElement;
    await waitFor(() => {
      expect(saveFtpSettingsMock).toHaveBeenCalledWith({
        browserUid: recoveryUid.value,
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
    await waitFor(() => expect(rescanIndexMock).toHaveBeenCalledWith({ browserUid: recoveryUid.value, passphrase: "passphrase" }));
    expect(await screen.findByText("Indexed 3 media files.")).toBeTruthy();
  });
});
