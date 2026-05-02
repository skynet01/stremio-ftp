import type { ApiError } from "../shared/apiTypes.js";

export type CreateProfileRequest = {
  browserUid: string;
  passphrase: string;
};

export type CreateProfileResponse = {
  profileId: string;
  recoveryUid: string;
  manifestUrl: string;
  stremioInstallUrl: string;
};

export type UnlockProfileResponse = {
  profileId: string;
};

export type FtpConfigRequest = {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsMode: "none" | "explicit" | "implicit";
  allowInvalidCertificate: boolean;
  roots: string[];
};

export type AuthenticatedFtpRequest = CreateProfileRequest & {
  ftpConfig: FtpConfigRequest;
};

export type RescanResponse = {
  filesSeen: number;
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return readJson<CreateProfileResponse>(response);
}

export async function unlockProfile(request: CreateProfileRequest): Promise<UnlockProfileResponse> {
  const response = await fetch("/api/profile/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return readJson<UnlockProfileResponse>(response);
}

export async function testFtpSettings(request: AuthenticatedFtpRequest): Promise<{ ok: true }> {
  const response = await fetch("/api/profile/ftp/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return readJson<{ ok: true }>(response);
}

export async function saveFtpSettings(request: AuthenticatedFtpRequest): Promise<{ ok: true }> {
  const response = await fetch("/api/profile/ftp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return readJson<{ ok: true }>(response);
}

export async function rescanIndex(request: CreateProfileRequest): Promise<RescanResponse> {
  const response = await fetch("/api/profile/index/rescan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return readJson<RescanResponse>(response);
}
