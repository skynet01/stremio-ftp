import { TtlCache } from "./ttlCache.js";

export type CinemetaMeta = {
  id: string;
  name: string;
  releaseInfo?: string;
};

const IMDB_ID_PATTERN = /^tt\d{7,10}$/;
const CINEMETA_CACHE_MAX_ENTRIES = 500;
const CINEMETA_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const CINEMETA_FAILURE_TTL_MS = 2 * 60 * 1000;
const cinemetaCache = new TtlCache<Promise<CinemetaMeta | null>>(CINEMETA_CACHE_MAX_ENTRIES);

export async function fetchCinemetaMeta(
  type: "movie" | "series",
  imdbId: string,
  timeoutMs = 4500,
): Promise<CinemetaMeta | null> {
  if (!IMDB_ID_PATTERN.test(imdbId)) return null;
  const cacheKey = `${type}:${imdbId}`;
  const cached = cinemetaCache.get(cacheKey);
  if (cached) return cached;

  const value: Promise<CinemetaMeta | null> = requestCinemetaMeta(type, imdbId, timeoutMs).then((meta) => {
    if (!meta && cinemetaCache.get(cacheKey) === value) cinemetaCache.set(cacheKey, value, CINEMETA_FAILURE_TTL_MS);
    return meta;
  });
  cinemetaCache.set(cacheKey, value, CINEMETA_SUCCESS_TTL_MS);
  return value;
}

export function clearCinemetaCache() {
  cinemetaCache.clear();
}

async function requestCinemetaMeta(type: "movie" | "series", imdbId: string, timeoutMs: number): Promise<CinemetaMeta | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { meta?: unknown };
    return isCinemetaMeta(body.meta) ? body.meta : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isCinemetaMeta(value: unknown): value is CinemetaMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    typeof meta.name === "string" &&
    (meta.releaseInfo === undefined || typeof meta.releaseInfo === "string")
  );
}
