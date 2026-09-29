import { normalizeTitle } from "../media/normalizer.js";
import { isImdbId } from "../metadata/cinemetaClient.js";
import type { FtpConfig, StreamDeliveryMode } from "../profiles/profileService.js";
import {
  renderStreamTemplate,
  stream3DType,
  streamAudioChannels,
  streamAudioTagList,
  streamEncode,
  streamExtension,
  streamVideoTagList,
  type StreamFormatterContext,
} from "../../shared/streamFormatter.js";

export type MediaMatch = {
  id: number;
  source?: "profile" | "shared";
  ftpPath: string;
  filename: string;
  quality: string | null;
  sizeBytes: number | null;
  ftpServerId?: number | null;
  serverName?: string | null;
  streamDeliveryMode?: StreamDeliveryMode | null;
};

const YEAR_PATTERN = /\b(19\d{2}|20\d{2})\b/;
// Stored titles are normalizeTitle() output, which never contains "#", so this
// matches no title and findMovie falls back to IMDb id and enrichment meta_id.
const IMDB_ID_ONLY_TITLE = "#imdb-id-only";

type FtpConfigForServer = (serverId: number | null | undefined) => FtpConfig | null;

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
  ftpConfigForServer?: FtpConfigForServer;
  addonName?: string;
  streamNameTemplate?: string | null;
  streamDescriptionTemplate?: string | null;
  onProxyMatch?: (match: MediaMatch) => void;
}) {
  const matches = input.type === "series" ? episodeMatches(input) : movieMatches(input);
  const ftpConfigForServer = input.ftpConfigForServer && memoizeFtpConfigForServer(input.ftpConfigForServer);

  return matches.map((match) => streamForMatch({
    baseUrl: input.baseUrl,
    installToken: input.installToken,
    match,
    streamDeliveryMode: input.streamDeliveryMode,
    ftpConfigForServer,
    addonName: input.addonName,
    streamNameTemplate: input.streamNameTemplate,
    streamDescriptionTemplate: input.streamDescriptionTemplate,
    onProxyMatch: input.onProxyMatch,
  }));
}

export function streamForMatch(input: {
  baseUrl: string;
  installToken: string;
  match: MediaMatch;
  streamDeliveryMode?: StreamDeliveryMode;
  ftpConfigForServer?: FtpConfigForServer;
  addonName?: string;
  streamNameTemplate?: string | null;
  streamDescriptionTemplate?: string | null;
  // Called for each match served through the proxy rather than as a direct FTP URL.
  onProxyMatch?: (match: MediaMatch) => void;
}) {
  const { match } = input;
  const deliveryMode = match.streamDeliveryMode ?? input.streamDeliveryMode;
  const ftpConfig = deliveryMode === "direct" ? input.ftpConfigForServer?.(match.ftpServerId) : null;
  if (!(deliveryMode === "direct" && ftpConfig)) input.onProxyMatch?.(match);
  const formatterContext = streamFormatterContext({
    addonName: input.addonName,
    match,
    deliveryMode: deliveryMode ?? "proxy",
  });
  const name = renderStreamTemplate(input.streamNameTemplate, formatterContext, "name");
  const description = renderStreamTemplate(input.streamDescriptionTemplate, formatterContext, "description");
  return {
    name,
    description,
    url:
      deliveryMode === "direct" && ftpConfig
        ? ftpUrl(ftpConfig, match.ftpPath)
        : match.source === "shared" && match.ftpServerId
          ? sharedProxyUrl(input.baseUrl, input.installToken, match.ftpServerId, match.id)
          : proxyUrl(input.baseUrl, input.installToken, match.id),
    behaviorHints: {
      notWebReady: true,
      filename: match.filename,
      ...(match.sizeBytes ? { videoSize: match.sizeBytes } : {}),
    },
  };
}

export function memoizeFtpConfigForServer(resolve: FtpConfigForServer): FtpConfigForServer {
  const configs = new Map<number | null, FtpConfig | null>();
  return (serverId) => {
    const key = serverId ?? null;
    if (!configs.has(key)) configs.set(key, resolve(serverId));
    return configs.get(key) ?? null;
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
  const threeDType = stream3DType(match.filename);
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
      type: "http",
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
      "3dtype": threeDType,
      threeDType,
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
  const year = stem.match(YEAR_PATTERN)?.[1] ?? "";
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

function sharedProxyUrl(baseUrl: string, installToken: string, serverId: number, mediaId: number): string {
  const root = baseUrl.replace(/\/+$/, "");
  return `${root}/proxy/${encodeURIComponent(installToken)}/shared/${encodeURIComponent(String(serverId))}/${encodeURIComponent(String(mediaId))}`;
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

function movieMatches(input: Parameters<typeof resolveStreams>[0]): MediaMatch[] {
  if (!isImdbId(input.id)) return [];
  const title = normalizeTitle(input.metadata?.name ?? "");
  return input.mediaRepository.findMovie(input.profileId, input.id, title || IMDB_ID_ONLY_TITLE, yearFrom(input.metadata?.releaseInfo));
}

function episodeMatches(input: Parameters<typeof resolveStreams>[0]): MediaMatch[] {
  const title = normalizeTitle(input.metadata?.name ?? "");
  if (!title) return [];
  const parts = input.id.split(":");
  if (parts.length !== 3) return [];
  const [, seasonRaw, episodeRaw] = parts;
  if (!isPositiveDecimalInteger(seasonRaw) || !isPositiveDecimalInteger(episodeRaw)) return [];
  const season = Number(seasonRaw);
  const episode = Number(episodeRaw);
  return input.mediaRepository.findEpisode(input.profileId, title, season, episode);
}

function isPositiveDecimalInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function yearFrom(releaseInfo?: string): number | null {
  const year = releaseInfo?.match(YEAR_PATTERN)?.[1];
  return year ? Number(year) : null;
}
