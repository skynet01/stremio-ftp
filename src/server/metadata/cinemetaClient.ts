export type CinemetaMeta = {
  id: string;
  name: string;
  releaseInfo?: string;
};

export async function fetchCinemetaMeta(
  type: "movie" | "series",
  imdbId: string,
): Promise<CinemetaMeta | null> {
  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
    if (!response.ok) return null;
    const body = (await response.json()) as { meta?: unknown };
    return isCinemetaMeta(body.meta) ? body.meta : null;
  } catch {
    return null;
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
