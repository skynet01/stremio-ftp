import { basename, normalizeTitle } from "./normalizer.js";

const SUPPORTED_EXTENSIONS = new Set(["mkv", "mp4", "avi", "mov", "m4v", "ts", "webm"]);

export type ParsedMedia = {
  mediaKind: "movie" | "series";
  catalogKind: "movie" | "series" | "anime";
  ftpPath: string;
  filename: string;
  normalizedFilename: string;
  extension: string;
  parsedTitle: string;
  parsedYear: number | null;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  quality: string | null;
  confidence: number;
};

export type ParseMediaOptions = {
  contentTypes?: {
    movies?: boolean;
    series?: boolean;
    anime?: boolean;
  };
  libraryLayout?: "auto" | "folders" | "flat";
};

function qualityOf(value: string): string | null {
  return value.match(/\b(2160p|1080p|720p|480p|4k)\b/i)?.[1]?.toLowerCase() || null;
}

function stripKnownTokens(value: string): string {
  return value
    .replace(/[\._-]+/g, " ")
    .replace(/\bweb[\s._-]?dl\b/gi, " ")
    .replace(/\bvr[\s._-]?sbs\b/gi, " ")
    .replace(/\bhalf[\s._-]?sbs\b/gi, " ")
    .replace(/\bai[\s._-]?upscaled\b/gi, " ")
    .replace(/\bdts[\s._-]?hd\b/gi, " ")
    .replace(/\b(2160p|1080p|720p|480p|4k|bluray|webrip|hdtv|x264|x265|hevc|aac|dts|truehd|atmos|ma|rife|remastered|multiaudio\d*|dirtyhippie|fgt|3dff|fsbs|hsbs|sbs|3d|3840x)\b/gi, " ")
    .replace(/\b\d+(?:fps|v\d+)\b/gi, " ")
    .replace(/\btt\d{7,8}\b/gi, " ");
}

function folderTitleOf(ftpPath: string): string | null {
  const parts = ftpPath.split(/[\\/]/).filter(Boolean);
  const folders = parts.slice(0, -1);
  const title = folders.reverse().find((part) => !/^season\s*\d+$/i.test(part));
  return title ? normalizeTitle(title) : null;
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseMediaPath(ftpPath: string, options: ParseMediaOptions = {}): ParsedMedia | null {
  return parseMediaPathWithOptions(ftpPath, options);
}

export function parseMediaPathWithOptions(ftpPath: string, options: ParseMediaOptions = {}): ParsedMedia | null {
  const filename = basename(ftpPath);
  const extension = filename.split(".").pop()?.toLowerCase() || "";
  if (!SUPPORTED_EXTENSIONS.has(extension)) return null;

  const withoutExtension = filename.replace(new RegExp(`\\.${extension}$`, "i"), "");
  const normalizedFilename = normalizeTitle(filename);
  const imdbId = ftpPath.match(/\btt\d{7,8}\b/i)?.[0] || null;
  const quality = qualityOf(ftpPath);

  const sxe = withoutExtension.match(/^(?<title>.+?)[\s._-]+s(?<season>\d{1,2})e(?<episode>\d{1,3})\b/i);
  if (sxe?.groups) {
    const season = positiveInteger(sxe.groups.season);
    const episode = positiveInteger(sxe.groups.episode);
    if (!season || !episode) return null;
    return {
      mediaKind: "series",
      catalogKind: seriesCatalogKind(ftpPath, options),
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: normalizeTitle(sxe.groups.title),
      parsedYear: null,
      season,
      episode,
      imdbId,
      quality,
      confidence: 95,
    };
  }

  const bareSxe = withoutExtension.match(/^s(?<season>\d{1,2})e(?<episode>\d{1,3})\b/i);
  if (bareSxe?.groups) {
    const season = positiveInteger(bareSxe.groups.season);
    const episode = positiveInteger(bareSxe.groups.episode);
    if (!season || !episode) return null;
    return {
      mediaKind: "series",
      catalogKind: seriesCatalogKind(ftpPath, options),
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: folderTitleOf(ftpPath) || normalizedFilename,
      parsedYear: null,
      season,
      episode,
      imdbId,
      quality,
      confidence: 85,
    };
  }

  const xPattern = withoutExtension.match(/^(?<title>.+?)[\s._-]+(?<season>\d{1,2})x(?<episode>\d{1,3})\b/i);
  if (xPattern?.groups) {
    const season = positiveInteger(xPattern.groups.season);
    const episode = positiveInteger(xPattern.groups.episode);
    if (!season || !episode) return null;
    return {
      mediaKind: "series",
      catalogKind: seriesCatalogKind(ftpPath, options),
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: normalizeTitle(xPattern.groups.title),
      parsedYear: null,
      season,
      episode,
      imdbId,
      quality,
      confidence: 90,
    };
  }

  const bareXPattern = withoutExtension.match(/^(?<season>\d{1,2})x(?<episode>\d{1,3})\b/i);
  if (bareXPattern?.groups) {
    const season = positiveInteger(bareXPattern.groups.season);
    const episode = positiveInteger(bareXPattern.groups.episode);
    if (!season || !episode) return null;
    return {
      mediaKind: "series",
      catalogKind: seriesCatalogKind(ftpPath, options),
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: folderTitleOf(ftpPath) || normalizedFilename,
      parsedYear: null,
      season,
      episode,
      imdbId,
      quality,
      confidence: 80,
    };
  }

  const animeEpisode = shouldAttemptAnimeAbsolute(ftpPath, options)
    ? withoutExtension.match(/^(?<title>.+?)[\s._-]+(?:-|ep(?:isode)?[\s._-]*)?(?<episode>\d{1,3})(?:v\d+)?(?:[\s._-]+|$)/i)
    : null;
  if (animeEpisode?.groups) {
    const parsedTitle = normalizeTitle(stripKnownTokens(animeEpisode.groups.title));
    if (!shouldUseAnimeAbsolute(ftpPath, options, parsedTitle)) {
      return parseMoviePath(ftpPath, filename, normalizedFilename, extension, imdbId, quality, withoutExtension, options);
    }
    const episode = positiveInteger(animeEpisode.groups.episode);
    if (!episode) return null;
    return {
      mediaKind: "series",
      catalogKind: "anime",
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle,
      parsedYear: null,
      season: 1,
      episode,
      imdbId,
      quality,
      confidence: 82,
    };
  }

  return parseMoviePath(ftpPath, filename, normalizedFilename, extension, imdbId, quality, withoutExtension, options);
}

function animeEnabled(options: ParseMediaOptions) {
  return options.contentTypes?.anime === true;
}

function shouldAttemptAnimeAbsolute(ftpPath: string, options: ParseMediaOptions) {
  if (!animeEnabled(options)) return false;
  return options.contentTypes?.movies === false || /\banime\b/i.test(ftpPath) || options.libraryLayout === "folders";
}

function shouldUseAnimeAbsolute(ftpPath: string, options: ParseMediaOptions, parsedTitle: string) {
  if (options.contentTypes?.movies === false || /\banime\b/i.test(ftpPath)) return true;
  if (options.libraryLayout !== "folders") return false;
  const folderTitle = folderTitleOf(ftpPath);
  if (!folderTitle) return false;
  return titleAndYearFrom(folderTitle, null, null).title === parsedTitle;
}

function seriesCatalogKind(ftpPath: string, options: ParseMediaOptions): "series" | "anime" {
  if (animeEnabled(options) && (!options.contentTypes?.series || /\banime\b/i.test(ftpPath))) return "anime";
  return "series";
}

function movieTitleParts(ftpPath: string, withoutExtension: string, yearIndex: number | null, fallbackYear: number | null, options: ParseMediaOptions) {
  if (options.libraryLayout === "folders") {
    const folderTitle = folderTitleOf(ftpPath);
    if (folderTitle) return titleAndYearFrom(folderTitle, null, fallbackYear);
  }
  return titleAndYearFrom(withoutExtension, yearIndex, fallbackYear);
}

function parseMoviePath(
  ftpPath: string,
  filename: string,
  normalizedFilename: string,
  extension: string,
  imdbId: string | null,
  quality: string | null,
  withoutExtension: string,
  options: ParseMediaOptions,
): ParsedMedia {
  const yearMatch = Array.from(withoutExtension.matchAll(/\b(19\d{2}|20\d{2})\b/g)).at(-1);
  const year = yearMatch?.[1];
  const movieTitle = movieTitleParts(ftpPath, withoutExtension, yearMatch?.index ?? null, year ? Number(year) : null, options);

  return {
    mediaKind: "movie",
    catalogKind: "movie",
    ftpPath,
    filename,
    normalizedFilename,
    extension,
    parsedTitle: movieTitle.title,
    parsedYear: movieTitle.year,
    season: null,
    episode: null,
    imdbId,
    quality,
    confidence: imdbId ? 90 : year ? 70 : 45,
  };
}

function titleAndYearFrom(value: string, yearIndex: number | null, fallbackYear: number | null) {
  const match = yearIndex === null ? Array.from(value.matchAll(/\b(19\d{2}|20\d{2})\b/g)).at(-1) : null;
  const index = yearIndex ?? match?.index ?? null;
  const year = fallbackYear ?? (match?.[1] ? Number(match[1]) : null);
  const titleSource = index !== null ? value.slice(0, index) : value;
  return {
    title: normalizeTitle(stripKnownTokens(titleSource)),
    year,
  };
}
