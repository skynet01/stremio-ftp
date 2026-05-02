export type CinemetaMeta = {
  id: string;
  name: string;
  releaseInfo?: string;
};

const IMDB_ID_PATTERN = /^tt\d{7,10}$/;

export async function fetchCinemetaMeta(
  type: "movie" | "series",
  imdbId: string,
  timeoutMs = 4500,
): Promise<CinemetaMeta | null> {
  if (!IMDB_ID_PATTERN.test(imdbId)) return null;
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
