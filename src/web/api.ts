import type { ApiError } from "../shared/apiTypes.js";

export type CreateProfileRequest = {
  browserUid: string;
  passphrase: string;
};

export type CreateProfileResponse = {
  profileId: number;
  recoveryUid: string;
  manifestUrl: string;
  stremioInstallUrl: string;
};

export type UnlockProfileResponse = {
  profileId: number;
  manifestUrl: string;
  stremioInstallUrl: string;
};

export type AddonCustomization = {
  addonName: string;
  addonLogoUrl: string;
  addonDescription: string;
  catalogEnabled: boolean;
};

export type IndexStatus = {
  lastScanAt: string | null;
  mediaItems: number;
};

export type ConnectionStatus = {
  lastTestedAt: string | null;
  ok: boolean | null;
};

const setupToken = new URLSearchParams(window.location.search).get("setup") || "";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    ...(setupToken ? { "x-setup-token": setupToken } : {}),
  };
}

export type FtpConfigRequest = {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsMode: "none" | "explicit" | "implicit";
  allowInvalidCertificate: boolean;
  roots: string[];
};

export type LoadedFtpConfig = FtpConfigRequest & {
  passwordConfigured: boolean;
};

export type AuthenticatedFtpRequest = CreateProfileRequest & {
  ftpConfig: FtpConfigRequest;
};

export type AuthenticatedCustomizationRequest = CreateProfileRequest & {
  customization: AddonCustomization;
};

export type RescanResponse = {
  filesSeen: number;
  lastScanAt: string;
  mediaItems: number;
};

export type SetupStatusResponse = {
  setupTokenRequired: boolean;
};

async function readJson<T extends object>(response: Response): Promise<T> {
  const text = await response.text();
  let body: T | ApiError | undefined;

  if (text) {
    try {
      body = JSON.parse(text) as T | ApiError;
    } catch {
      throw new Error(response.ok ? "Expected a JSON response" : `Request failed with ${response.status}`);
    }
  }

  if (!response.ok) {
    const message = body && "error" in body ? body.error : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  if (!body) throw new Error("Expected a JSON response");
  return body as T;
}

export async function createProfile(request: CreateProfileRequest): Promise<CreateProfileResponse> {
  const response = await fetch("/api/profile", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<CreateProfileResponse>(response);
}

export async function unlockProfile(request: CreateProfileRequest): Promise<UnlockProfileResponse> {
  const response = await fetch("/api/profile/unlock", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<UnlockProfileResponse>(response);
}

export async function loadSetupStatus(): Promise<SetupStatusResponse> {
  const response = await fetch("/api/setup", { headers: authHeaders() });
  return readJson<SetupStatusResponse>(response);
}

export async function testFtpSettings(request: AuthenticatedFtpRequest): Promise<{ ok: true; connectionStatus: ConnectionStatus }> {
  const response = await fetch("/api/profile/ftp/test", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<{ ok: true; connectionStatus: ConnectionStatus }>(response);
}

export async function saveFtpSettings(request: AuthenticatedFtpRequest): Promise<{ ok: true }> {
  const response = await fetch("/api/profile/ftp", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<{ ok: true }>(response);
}

export async function loadFtpSettings(request: CreateProfileRequest): Promise<{ ftpConfig: LoadedFtpConfig; indexStatus: IndexStatus; connectionStatus: ConnectionStatus }> {
  const response = await fetch("/api/profile/ftp/load", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<{ ftpConfig: LoadedFtpConfig; indexStatus: IndexStatus; connectionStatus: ConnectionStatus }>(response);
}

export async function loadCustomization(request: CreateProfileRequest): Promise<{ customization: AddonCustomization }> {
  const response = await fetch("/api/profile/customization/load", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<{ customization: AddonCustomization }>(response);
}

export async function saveCustomization(request: AuthenticatedCustomizationRequest): Promise<{ ok: true }> {
  const response = await fetch("/api/profile/customization", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<{ ok: true }>(response);
}

export async function rescanIndex(request: CreateProfileRequest): Promise<RescanResponse> {
  const response = await fetch("/api/profile/index/rescan", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  return readJson<RescanResponse>(response);
}
