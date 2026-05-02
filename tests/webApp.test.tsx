/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App";
import { createProfile, unlockProfile } from "../src/web/api";

vi.mock("../src/web/api", () => ({
  createProfile: vi.fn(),
  unlockProfile: vi.fn(),
}));

const createProfileMock = vi.mocked(createProfile);
const unlockProfileMock = vi.mocked(unlockProfile);

describe("App", () => {
  beforeEach(() => {
    createProfileMock.mockReset();
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

  it("keeps backend-only FTP and index controls disabled until endpoints exist", () => {
    render(<App />);

    for (const name of ["Test connection", "Save FTP settings", "Rescan", "Pause", "Rotate", "Delete"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeDisabled();
      expect(control.getAttribute("title")).toBe("Backend endpoint not available yet");
    }
  });
});
