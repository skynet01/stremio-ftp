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
