import { basename, normalizeTitle } from "./normalizer.js";

const SUPPORTED_EXTENSIONS = new Set(["mkv", "mp4", "avi", "mov", "m4v", "ts", "webm"]);

export type ParsedMedia = {
  mediaKind: "movie" | "series";
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

function qualityOf(value: string): string | null {
  return value.match(/\b(2160p|1080p|720p|480p|4k)\b/i)?.[1]?.toLowerCase() || null;
}

function stripKnownTokens(value: string): string {
  return value
    .replace(/[\._-]+/g, " ")
    .replace(/\bweb[\s._-]?dl\b/gi, " ")
    .replace(/\bhalf[\s._-]?sbs\b/gi, " ")
    .replace(/\b(2160p|1080p|720p|480p|4k|bluray|webrip|hdtv|x264|x265|hevc|aac|dts|3dff|fsbs|hsbs|sbs)\b/gi, " ")
    .replace(/\btt\d{7,8}\b/gi, " ");
}

function folderTitleOf(ftpPath: string): string | null {
  const parts = ftpPath.split(/[\\/]/).filter(Boolean);
  const folders = parts.slice(0, -1);
  const title = folders.reverse().find((part) => !/^season\s*\d+$/i.test(part));
  return title ? normalizeTitle(title) : null;
}

export function parseMediaPath(ftpPath: string): ParsedMedia | null {
  const filename = basename(ftpPath);
  const extension = filename.split(".").pop()?.toLowerCase() || "";
  if (!SUPPORTED_EXTENSIONS.has(extension)) return null;

  const withoutExtension = filename.replace(new RegExp(`\\.${extension}$`, "i"), "");
  const normalizedFilename = normalizeTitle(filename);
  const imdbId = ftpPath.match(/\btt\d{7,8}\b/i)?.[0] || null;
  const quality = qualityOf(ftpPath);

  const sxe = withoutExtension.match(/^(?<title>.+?)[\s._-]+s(?<season>\d{1,2})e(?<episode>\d{1,3})\b/i);
  if (sxe?.groups) {
    return {
      mediaKind: "series",
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: normalizeTitle(sxe.groups.title),
      parsedYear: null,
      season: Number(sxe.groups.season),
      episode: Number(sxe.groups.episode),
      imdbId,
      quality,
      confidence: 95,
    };
  }

  const bareSxe = withoutExtension.match(/^s(?<season>\d{1,2})e(?<episode>\d{1,3})\b/i);
  if (bareSxe?.groups) {
    return {
      mediaKind: "series",
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: folderTitleOf(ftpPath) || normalizedFilename,
      parsedYear: null,
      season: Number(bareSxe.groups.season),
      episode: Number(bareSxe.groups.episode),
      imdbId,
      quality,
      confidence: 85,
    };
  }

  const xPattern = withoutExtension.match(/^(?<title>.+?)[\s._-]+(?<season>\d{1,2})x(?<episode>\d{1,3})\b/i);
  if (xPattern?.groups) {
    return {
      mediaKind: "series",
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: normalizeTitle(xPattern.groups.title),
      parsedYear: null,
      season: Number(xPattern.groups.season),
      episode: Number(xPattern.groups.episode),
      imdbId,
      quality,
      confidence: 90,
    };
  }

  const bareXPattern = withoutExtension.match(/^(?<season>\d{1,2})x(?<episode>\d{1,3})\b/i);
  if (bareXPattern?.groups) {
    return {
      mediaKind: "series",
      ftpPath,
      filename,
      normalizedFilename,
      extension,
      parsedTitle: folderTitleOf(ftpPath) || normalizedFilename,
      parsedYear: null,
      season: Number(bareXPattern.groups.season),
      episode: Number(bareXPattern.groups.episode),
      imdbId,
      quality,
      confidence: 80,
    };
  }

  const yearMatch = Array.from(withoutExtension.matchAll(/\b(19\d{2}|20\d{2})\b/g)).at(-1);
  const year = yearMatch?.[1];
  const titleBeforeYear = yearMatch ? withoutExtension.slice(0, yearMatch.index ?? 0) : stripKnownTokens(withoutExtension);

  return {
    mediaKind: "movie",
    ftpPath,
    filename,
    normalizedFilename,
    extension,
    parsedTitle: normalizeTitle(stripKnownTokens(titleBeforeYear)),
    parsedYear: year ? Number(year) : null,
    season: null,
    episode: null,
    imdbId,
    quality,
    confidence: imdbId ? 90 : year ? 70 : 45,
  };
}
