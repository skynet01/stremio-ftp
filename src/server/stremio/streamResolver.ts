import { normalizeTitle } from "../media/normalizer.js";
import type { FtpConfig, StreamDeliveryMode } from "../profiles/profileService.js";
import {
  renderStreamTemplate,
  streamAudioChannels,
  streamAudioTagList,
  streamEncode,
  streamExtension,
  streamVideoTagList,
  type StreamFormatterContext,
} from "../../shared/streamFormatter.js";

export type MediaMatch = {
  id: number;
  ftpPath: string;
  filename: string;
  quality: string | null;
  sizeBytes: number | null;
  ftpServerId?: number | null;
  serverName?: string | null;
  streamDeliveryMode?: StreamDeliveryMode | null;
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
  ftpConfigForServer?: (serverId: number | null | undefined) => FtpConfig | null;
  addonName?: string;
  streamNameTemplate?: string | null;
  streamDescriptionTemplate?: string | null;
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
    ftpConfigForServer: input.ftpConfigForServer,
    addonName: input.addonName,
    streamNameTemplate: input.streamNameTemplate,
    streamDescriptionTemplate: input.streamDescriptionTemplate,
  }));
}

export function streamForMatch(input: {
  baseUrl: string;
  installToken: string;
  match: MediaMatch;
  streamDeliveryMode?: StreamDeliveryMode;
  ftpConfig?: FtpConfig | null;
  ftpConfigForServer?: (serverId: number | null | undefined) => FtpConfig | null;
  addonName?: string;
  streamNameTemplate?: string | null;
  streamDescriptionTemplate?: string | null;
}) {
  const { match } = input;
  const ftpConfig = input.ftpConfigForServer?.(match.ftpServerId) ?? input.ftpConfig;
  const deliveryMode = match.streamDeliveryMode ?? input.streamDeliveryMode;
  const formatterContext = streamFormatterContext({
    addonName: input.addonName,
    match,
    deliveryMode: deliveryMode ?? "proxy",
  });
  const name = renderStreamTemplate(input.streamNameTemplate, formatterContext, "name");
  const description = renderStreamTemplate(input.streamDescriptionTemplate, formatterContext, "description");
  return {
    name,
    title: name,
    description,
    url:
      deliveryMode === "direct" && ftpConfig
        ? ftpUrl(ftpConfig, match.ftpPath)
        : proxyUrl(input.baseUrl, input.installToken, match.id),
    behaviorHints: {
      notWebReady: true,
      filename: match.filename,
      ...(match.sizeBytes ? { videoSize: match.sizeBytes } : {}),
    },
  };
}

function streamFormatterContext({
  addonName,
  match,
  deliveryMode,
}: {
  addonName?: string;
  match: MediaMatch;
  deliveryMode: StreamDeliveryMode;
}): StreamFormatterContext {
  const serverName = match.serverName?.trim() ?? "";
  const quality = match.quality?.trim() || "Source";
  const release = releaseParts(match.filename);
  const visualTags = streamVideoTagList(match.filename);
  const audioTags = streamAudioTagList(match.filename);
  return {
    config: {
      addonName: addonName?.trim() || "Stremio FTP Addon",
    },
    addon: {
      name: addonName?.trim() || "Stremio FTP Addon",
    },
    service: {
      id: "ftp",
      shortName: "FTP",
      name: "FTP",
      cached: true,
    },
    metadata: {},
    debug: {},
    stream: {
      mediaId: match.id,
      serverId: match.ftpServerId ?? null,
      serverName,
      serverPrefix: serverName ? `${serverName} - ` : "",
      type: deliveryMode === "direct" ? "http" : "http",
      proxied: deliveryMode !== "direct",
      library: false,
      indexer: serverName,
      message: "",
      infoHash: "",
      filename: match.filename,
      folderName: "",
      path: match.ftpPath,
      extension: streamExtension(match.filename),
      container: streamExtension(match.filename).replace(/^\./, ""),
      quality,
      resolution: quality,
      size: match.sizeBytes,
      folderSize: match.sizeBytes,
      bitrate: null,
      duration: null,
      deliveryMode,
      videoTags: visualTags.map((tag) => (tag === "DV" ? "Dolby Vision" : tag)).join(" "),
      visualTags,
      encode: streamEncode(match.filename),
      audioTags,
      audioChannels: streamAudioChannels(match.filename),
      languages: [],
      languageEmojis: [],
      languageCodes: [],
      smallLanguageCodes: [],
      subtitles: [],
      title: release.title,
      year: release.year,
      date: "",
      releaseGroup: release.releaseGroup,
      editions: [],
      seasonPack: false,
      seasons: release.season ? [release.season] : [],
      episodes: release.episode ? [release.episode] : [],
      seasonEpisode: release.season && release.episode ? [`S${String(release.season).padStart(2, "0")}`, `E${String(release.episode).padStart(2, "0")}`] : [],
      seeders: 0,
      private: false,
      freeleech: false,
      age: "",
      ageHours: null,
      seadex: false,
      seadexBest: false,
      regexMatched: "",
      rankedRegexMatched: [],
      regexScore: null,
      nRegexScore: null,
      seScore: null,
      nSeScore: null,
      seMatched: "",
      rseMatched: [],
    },
  };
}

function releaseParts(filename: string) {
  const stem = filename.replace(/\.[^/.]+$/, "");
  const year = stem.match(/\b(19\d{2}|20\d{2})\b/)?.[1] ?? "";
  const seasonEpisode = stem.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  const stop = year ? stem.indexOf(year) : seasonEpisode?.index ?? stem.search(/\b(?:2160p|1080p|720p|480p)\b/i);
  const titleSource = stop && stop > 0 ? stem.slice(0, stop) : stem;
  const title = titleSource.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  const releaseGroup = stem.match(/-([A-Za-z0-9]+)$/)?.[1] ?? "";
  return {
    title,
    year,
    releaseGroup,
    season: seasonEpisode ? Number(seasonEpisode[1]) : null,
    episode: seasonEpisode ? Number(seasonEpisode[2]) : null,
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
