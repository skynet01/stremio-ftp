import { normalizeTitle } from "../media/normalizer.js";
import type { FtpConfig, StreamDeliveryMode } from "../profiles/profileService.js";

export type MediaMatch = {
  id: number;
  ftpPath: string;
  filename: string;
  quality: string | null;
  sizeBytes: number | null;
};

type RepoLike = {
  findEpisode(profileId: number, normalizedTitle: string, season: number, episode: number): MediaMatch[];
  findMovie(
    profileId: number,
    imdbId: string,
    normalizedTitle: string,
    year: number | null,
  ): MediaMatch[];
};

export async function resolveStreams(input: {
  baseUrl: string;
  installToken: string;
  profileId: number;
  type: "movie" | "series";
  id: string;
  metadata: { name: string; releaseInfo?: string } | null;
  mediaRepository: RepoLike;
  streamDeliveryMode?: StreamDeliveryMode;
  ftpConfig?: FtpConfig | null;
}) {
  if (!input.metadata) return [];

  const matches =
    input.type === "series"
      ? episodeMatches(input)
      : input.mediaRepository.findMovie(
          input.profileId,
          input.id,
          normalizeTitle(input.metadata.name),
          yearFrom(input.metadata.releaseInfo),
        );

  return matches.map((match) => streamForMatch({
    baseUrl: input.baseUrl,
    installToken: input.installToken,
    match,
    streamDeliveryMode: input.streamDeliveryMode,
    ftpConfig: input.ftpConfig,
  }));
}

export function streamForMatch(input: {
  baseUrl: string;
  installToken: string;
  match: MediaMatch;
  streamDeliveryMode?: StreamDeliveryMode;
  ftpConfig?: FtpConfig | null;
}) {
  const { match } = input;
  return {
    name: `FTP ${match.quality ?? "Source"}`,
    description: `${match.filename}${match.sizeBytes ? `\n${formatBytes(match.sizeBytes)}` : ""}`,
    url:
      input.streamDeliveryMode === "direct" && input.ftpConfig
        ? ftpUrl(input.ftpConfig, match.ftpPath)
        : proxyUrl(input.baseUrl, input.installToken, match.id),
    behaviorHints: {
      notWebReady: true,
      filename: match.filename,
      ...(match.sizeBytes ? { videoSize: match.sizeBytes } : {}),
    },
  };
}

function proxyUrl(baseUrl: string, installToken: string, mediaId: number): string {
  const root = baseUrl.replace(/\/+$/, "");
  return `${root}/proxy/${encodeURIComponent(installToken)}/${encodeURIComponent(String(mediaId))}`;
}

function ftpUrl(config: FtpConfig, ftpPath: string): string {
  const scheme = config.tlsMode === "implicit" ? "ftps" : "ftp";
  const user = encodeURIComponent(config.username);
  const password = encodeURIComponent(config.password);
  const host = config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  return `${scheme}://${user}:${password}@${host}:${config.port}${encodeFtpPath(ftpPath)}`;
}

function encodeFtpPath(ftpPath: string): string {
  const normalized = ftpPath.replace(/\\/g, "/");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withLeadingSlash
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
}

function episodeMatches(input: Parameters<typeof resolveStreams>[0]): MediaMatch[] {
  const parts = input.id.split(":");
  if (parts.length !== 3) return [];
  const [, seasonRaw, episodeRaw] = parts;
  if (!isPositiveDecimalInteger(seasonRaw) || !isPositiveDecimalInteger(episodeRaw)) return [];
  const season = Number(seasonRaw);
  const episode = Number(episodeRaw);
  return input.mediaRepository.findEpisode(
    input.profileId,
    normalizeTitle(input.metadata?.name ?? ""),
    season,
    episode,
  );
}

function isPositiveDecimalInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function yearFrom(releaseInfo?: string): number | null {
  const year = releaseInfo?.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  return year ? Number(year) : null;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
