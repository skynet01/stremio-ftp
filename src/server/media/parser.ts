import { filenameParse } from "@ctrl/video-filename-parser";
import { basename, collapseDottedAcronyms, normalizeTitle } from "./normalizer.js";

/**
 * Version of the parse output for a given path and options. Bump it whenever a
 * change alters what existing paths parse to: indexed rows stored with an older
 * version are re-parsed from their stored path without touching FTP.
 */
export const PARSER_VERSION = 1;

const SUPPORTED_EXTENSIONS = new Set(["mkv", "mp4", "avi", "mov", "m4v", "ts", "webm"]);
const YEAR_CANDIDATE_PATTERN = /(?:^|[^\d])(19\d{2}|20\d{2})(?=$|[^\d])/g;
// A release year can be at most one year ahead ("Tokyo 2040" and "2049" are title words).
const MAX_RELEASE_YEAR = new Date().getUTCFullYear() + 1;
// Resolution tokens: 1920x1080, 2048p, 1920p50, 1080i. Their digits must never be read as years.
const RESOLUTION_TOKEN_PATTERN = /(?<!\d)\d{3,4}\s?x\s?\d{3,4}(?!\d)|(?<!\d)\d{3,4}[pi](?:\d{2,3})?(?![a-z])/gi;
const STRONG_RELEASE_MARKER = /\b(?:\d{3,4}x\d{3,4}|\d{3,4}[pi](?:\d{2,3})?|[xh]26[45]|hevc|bluray|webrip|web\s+dl|fs3d|fsbs|hsbs|3dff)\b/i;
const GENERIC_MOVIE_FOLDERS = /^(?:movie|movies|film|films|other|uncategorized|misc|miscellaneous|video|videos|anime movies|blockbuster movies|superhero movies|vr videos)$/i;
const MOVIE_COLLECTION_CUE = /\b(?:movie|movies|film|films|blockbuster)\b/i;
const ANIME_COLLECTION_FOLDERS = /^(?:anime|anime movies|anime films|anime shows|anime series|anime tv)$/i;
// 2D-to-3D converter settings appended to filenames ("_35_8_RIGHT_ONLY_00_v1.8.6_halfSBS",
// "_45_8_BOTH_auto_subject_v1.8.6_LRF_Full_SBS"); the first number is not an episode.
const CONVERSION_TOOL_SUFFIX = /[\s._-]\d{1,3}_\d{1,2}_(?:right|left|both)(?:_.*)?$/i;
// Tokens that make a one-digit number after a title a release marker rather than an episode.
const THREE_D_RELEASE_MARKER =/^(?:fsbs|hsbs|sbs|hou|ou|fs3d|3d(?:ff)?|\d{3,4}[pi]|\d{1,2}k|full[\s._-]*sbs|half[\s._-]*sbs|side[\s._-]*by[\s._-]*side|over[\s._-]*under)(?:[\s._-]|$)/i;
const ACRONYM_SMALL_WORDS = new Set(["a", "an", "and", "of", "the", "in", "on", "to"]);

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
  /** A second title/year to search when the primary one finds nothing (folder vs filename). */
  alternateTitle: string | null;
  alternateYear: number | null;
};

export type ParseMediaOptions = {
  contentTypes?: {
    movies?: boolean;
    series?: boolean;
    anime?: boolean;
  };
  libraryLayout?: "auto" | "folders" | "flat";
};

type BaseFields = Pick<ParsedMedia, "ftpPath" | "filename" | "normalizedFilename" | "extension" | "imdbId" | "quality">;
type YearMatch = { year: number; index: number };
type TitleYear = { title: string; year: number | null };
type EpisodeMatch = {
  kind: "titled" | "bare";
  title: string;
  season: number | null;
  episode: number | null;
  confidence: number;
};

type EpisodePattern = {
  pattern: RegExp;
  kind: "titled" | "bare";
  confidence: number;
  season?: number;
  when?: (ftpPath: string, options: ParseMediaOptions) => boolean;
};

// Ordered from most to least explicit. Every pattern ends in a lookahead that rejects a
// following digit or letter, so "S1.01_3DFF" matches but "S01 1080p" does not.
const EPISODE_PATTERNS: EpisodePattern[] = [
  { pattern: /^(?<title>.+?)[\s._-]+s(?<season>\d{1,2})e(?<episode>\d{1,3})(?=$|[\s._-]|[a-z])/i, kind: "titled", confidence: 95 },
  { pattern: /^s(?<season>\d{1,2})e(?<episode>\d{1,3})(?!\d)/i, kind: "bare", confidence: 85 },
  { pattern: /^(?<title>.+?)[\s._-]+(?<season>\d{1,2})x(?<episode>\d{1,3})(?![\da-z])/i, kind: "titled", confidence: 90 },
  { pattern: /^(?<season>\d{1,2})x(?<episode>\d{1,3})(?![\da-z])/i, kind: "bare", confidence: 80 },
  { pattern: /^(?<title>.+?)[\s._-]+s(?<season>\d{1,2})[\s._-]+e?(?<episode>\d{1,3})(?:v\d)?(?![\da-z])/i, kind: "titled", confidence: 88 },
  // "AHS.01E04": season and episode without the leading S.
  { pattern: /^(?<title>.+?)[\s._-]+(?<season>\d{1,2})e(?<episode>\d{2,3})(?![\da-z])/i, kind: "titled", confidence: 86 },
  // "MandoS1E1", "JigokurakuS1.01": an upper-case S glued to a lower-case word.
  { pattern: /^(?<title>.+?[a-z])S(?<season>\d{1,2})(?:E(?<episode>\d{1,3})|\.(?<dotEpisode>\d{2,3}))(?![\dA-Za-z])/, kind: "titled", confidence: 85 },
  // "Utawarerumono - (Ep. 01) - Something Uninvited"
  { pattern: /^(?<title>.+?)[\s._-]*\(\s*ep(?:isode)?\.?\s*(?<episode>\d{1,3})\s*\)/i, kind: "titled", confidence: 84, season: 1 },
  {
    pattern: /^(?<title>.+?)[\s._-]+(?:e(?<shortEpisode>\d{2,3})|ep(?<longEpisode>\d{1,3}))(?![\da-z])/i,
    kind: "titled",
    confidence: 84,
    season: 1,
    when: shouldUseBareEpisodePattern,
  },
];

function qualityOf(value: string): string | null {
  return value.match(/\b(2160p|1080p|720p|480p|4k)\b/i)?.[1]?.toLowerCase() || null;
}

/** Drops everything from the first unambiguous release marker ("1080p", "BluRay", "WEB-DL", "x264") on. */
function cutAtReleaseMarker(value: string): string {
  const marker = value.match(STRONG_RELEASE_MARKER);
  if (!marker || marker.index === undefined) return value;
  const prefix = value.slice(0, marker.index).replace(/\b(?:vr|sbs|fsbs|hsbs|fs3d|3d)\b/gi, "");
  if (!/[a-z]{4,}/i.test(prefix)) return value;
  return value.slice(0, marker.index);
}

function stripKnownTokens(value: string): string {
  return cutAtReleaseMarker(collapseDottedAcronyms(value).replace(/\[[^\]]*\]|\{[^}]*\}/g, " ").replace(/[\._-]+/g, " "))
    .replace(/\bma(?=\s+[5-7]\s+1\b)/gi, " ")
    .replace(/\b\d{3,5}x\d{3,5}\b/gi, " ")
    .replace(/\b\d{3,4}[pi](?:\d{2,3})?\b/gi, " ")
    .replace(/\bweb[\s._-]?dl\b/gi, " ")
    .replace(/\bvr[\s._-]?sbs\b/gi, " ")
    .replace(/\bfull[\s._-]?sbs\b/gi, " ")
    .replace(/\bhalf[\s._-]?sbs\b/gi, " ")
    .replace(/\bhalf[\s._-]?ou\b/gi, " ")
    .replace(/\bai[\s._-]?upscaled\b/gi, " ")
    .replace(/\bdts[\s._-]?hd\b/gi, " ")
    .replace(/\b(?:ddp|eac3|ac3|aac|dts|truehd)\s*\d(?:\s+\d)?\b/gi, " ")
    .replace(/\b(?:h|x)\s*26[45]\b/gi, " ")
    .replace(/\b(?:de\s+en|en\s+de)\b/gi, " ")
    .replace(/\b(?:dc|wd)\s+s\b/gi, " ")
    .replace(/^\s*0\s+(?=[a-z])/i, " ")
    .replace(
      /\b(2160p|1080p|720p|480p|3840p|4k|5k|6k|8k|uhd|hdr|sdr|dv|dual|bluray|webrip|hdtv|remux|x264|x265|h264|h265|hevc|av1|aac|dts|truehd|atmos|rife|remastered|multiaudio\d*|dirtyhippie|fgt|3dff|3dom|fs3d|hs3d|fsbs|hsbs|sbs|hou|ou|3d|3840x|isorip|ldf|decker|bit|amzn|nf|dsnp|hulu|tving|iq|linetv|kocowa|viki|viu|hbo|atvp)\b/gi,
      " ",
    )
    .replace(/\b\d+(?:fps|v\d+)\b/gi, " ")
    .replace(/\b(?:2|5|6|7)\s+1\b/g, " ")
    .replace(/\btt\d{7,8}\b/gi, " ");
}

/** Plausible release years in a name, ignoring resolution tokens and far-future numbers. */
function releaseYears(value: string): YearMatch[] {
  const masked = value.replace(RESOLUTION_TOKEN_PATTERN, (token) => " ".repeat(token.length));
  return Array.from(masked.matchAll(YEAR_CANDIDATE_PATTERN))
    .map((match) => ({ year: Number(match[1]), index: (match.index ?? 0) + match[0].lastIndexOf(match[1]) }))
    .filter((match) => match.year <= MAX_RELEASE_YEAR);
}

function lastReleaseYear(value: string): YearMatch | null {
  return releaseYears(value).at(-1) ?? null;
}

function folderNameOf(ftpPath: string): string | null {
  const parts = ftpPath.split(/[\\/]/).filter(Boolean);
  const folders = parts.slice(0, -1);
  return folders.reverse().find((part) => !/^season\s*\d+$/i.test(part)) || null;
}

function folderTitleOf(ftpPath: string): string | null {
  const title = folderNameOf(ftpPath);
  return title ? normalizeTitle(title) : null;
}

function stripSeriesFolderTokens(value: string): string {
  return value.replace(/\bs\d{1,2}(?:\s*[-–]\s*\d{1,2})?\b.*$/i, " ");
}

function seriesFolderOf(ftpPath: string): TitleYear | null {
  const folderName = folderNameOf(ftpPath);
  if (!folderName) return null;
  return {
    title: titleAndYearFrom(stripSeriesFolderTokens(folderName), null, null).title,
    year: lastReleaseYear(folderName)?.year ?? null,
  };
}

export function seriesFolderYearOf(ftpPath: string, parsedTitle: string): number | null {
  const folder = seriesFolderOf(ftpPath);
  return folder?.title === parsedTitle ? folder.year : null;
}

function seriesFolderTitleOf(ftpPath: string): string | null {
  return seriesFolderOf(ftpPath)?.title || null;
}

/** Cleans series titles, retaining parenthesized title years and extracting dotted release years. */
function filenameSeriesTitle(rawTitle: string): TitleYear {
  const withoutSortIndex = rawTitle.replace(/^\s*e\d{2,4}[\s._]+(?=\S)/i, "");
  if (/\(\s*(?:19|20)\d{2}\s*\)\s*$/.test(withoutSortIndex)) {
    return { title: normalizeTitle(stripKnownTokens(withoutSortIndex)), year: null };
  }
  const trailingYear = withoutSortIndex.match(/^(?<title>.*?[^\s._-])[\s._-]*[([]?(?<year>(?:19|20)\d{2})[)\]]?[\s._-]*$/);
  const year = trailingYear?.groups ? Number(trailingYear.groups.year) : null;
  if (trailingYear?.groups && year !== null && year <= MAX_RELEASE_YEAR) {
    const title = normalizeTitle(stripKnownTokens(trailingYear.groups.title));
    if (title) return { title, year };
  }
  return { title: normalizeTitle(stripKnownTokens(withoutSortIndex)), year: null };
}

/**
 * Picks the series identity. Folder layouts name the series by folder; other layouts use the
 * filename unless it is an abbreviation of the folder ("AHS" in "American Horror Story (2011)").
 * A year is only kept when the filename itself carries one, so plain "Show.S01E01" files keep
 * their existing identity.
 */
function seriesIdentity(ftpPath: string, rawTitle: string, options: ParseMediaOptions) {
  const fromFile = filenameSeriesTitle(rawTitle);
  const folder = seriesFolderOf(ftpPath);
  if (options.libraryLayout === "folders" && folder?.title) {
    if (folder.year === null && fromFile.title.startsWith(`${folder.title} `) && /\b(?:19|20)\d{2}$/.test(fromFile.title)) {
      return { title: fromFile.title, year: null, alternateTitle: null };
    }
    const year = fromFile.year === null ? null : (folder.year ?? (folderTitleHasNumber(folder.title, fromFile.year) ? null : fromFile.year));
    return { title: folder.title, year, alternateTitle: alternateTitleFor(folder.title, fromFile.title) };
  }
  if (folder?.title && (!fromFile.title || isAbbreviationOf(fromFile.title, folder.title))) {
    return { title: folder.title, year: fromFile.year, alternateTitle: null };
  }
  return { title: fromFile.title, year: fromFile.year, alternateTitle: null };
}

function folderTitleHasNumber(folderTitle: string, year: number) {
  return folderTitle.split(" ").includes(String(year));
}

function isAbbreviationOf(abbreviation: string, title: string) {
  if (!/^[a-z]{2,6}$/.test(abbreviation)) return false;
  const words = title.split(" ").filter(Boolean);
  if (words.length < 2) return false;
  const initials = words.map((word) => word[0]).join("");
  const significantInitials = words.filter((word) => !ACRONYM_SMALL_WORDS.has(word)).map((word) => word[0]).join("");
  return abbreviation === initials || abbreviation === significantInitials;
}

/** The other title worth searching, unless it is empty, equal, or only a subset of the primary title's words. */
function alternateTitleFor(primary: string, candidate: string | null | undefined) {
  if (!candidate || candidate === primary) return null;
  const primaryWords = new Set(primary.split(" "));
  if (candidate.split(" ").every((word) => primaryWords.has(word))) return null;
  return candidate;
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

  const withoutExtension = filename.replace(new RegExp(`\\.${extension}$`, "i"), "").replace(CONVERSION_TOOL_SUFFIX, "");
  const base: BaseFields = {
    ftpPath,
    filename,
    normalizedFilename: normalizeTitle(filename),
    extension,
    imdbId: ftpPath.match(/\btt\d{7,8}\b/i)?.[0] || null,
    quality: qualityOf(ftpPath),
  };
  if (shouldPreferFolderMovie(ftpPath, withoutExtension, options)) {
    return parseMoviePath(base, withoutExtension, options);
  }

  const episodeMatch = matchEpisode(withoutExtension, ftpPath, options);
  if (episodeMatch) {
    if (!episodeMatch.season || !episodeMatch.episode) return null;
    const identity =
      episodeMatch.kind === "bare"
        ? { title: seriesFolderTitleOf(ftpPath) || base.normalizedFilename, year: null, alternateTitle: null }
        : seriesIdentity(ftpPath, episodeMatch.title, options);
    return {
      ...base,
      mediaKind: "series",
      catalogKind: seriesCatalogKind(ftpPath, options),
      parsedTitle: identity.title,
      parsedYear: identity.year,
      season: episodeMatch.season,
      episode: episodeMatch.episode,
      confidence: episodeMatch.confidence,
      alternateTitle: identity.alternateTitle,
      alternateYear: identity.alternateTitle ? identity.year : null,
    };
  }

  const animeEpisode = shouldAttemptAnimeAbsolute(ftpPath, options)
    ? withoutExtension.match(
        /^(?<title>.+?)[\s._-]+(?:-|ep(?:isode)?[\s._-]*)?(?<episode>\d{1,3})(?:v\d+)?(?<suffix>[\s._-]+.*|$)/i,
      )
    : null;
  if (animeEpisode?.groups) {
    if (isReleaseMarkerEpisode(animeEpisode)) {
      return parseMoviePath(base, withoutExtension, options);
    }
    const fromFile = filenameSeriesTitle(animeEpisode.groups.title);
    if (!shouldUseAnimeAbsolute(ftpPath, options, fromFile.title)) {
      return parseMoviePath(base, withoutExtension, options);
    }
    const episode = positiveInteger(animeEpisode.groups.episode);
    if (!episode) return null;
    const alternateTitle = options.libraryLayout === "folders" ? alternateTitleFor(fromFile.title, seriesFolderTitleOf(ftpPath)) : null;
    return {
      ...base,
      mediaKind: "series",
      catalogKind: "anime",
      parsedTitle: fromFile.title,
      parsedYear: fromFile.year,
      season: 1,
      episode,
      confidence: 82,
      alternateTitle,
      alternateYear: alternateTitle ? fromFile.year : null,
    };
  }

  return parseMoviePath(base, withoutExtension, options);
}

function matchEpisode(withoutExtension: string, ftpPath: string, options: ParseMediaOptions): EpisodeMatch | null {
  for (const candidate of EPISODE_PATTERNS) {
    if (candidate.when && !candidate.when(ftpPath, options)) continue;
    const groups = withoutExtension.match(candidate.pattern)?.groups;
    if (!groups) continue;
    return {
      kind: candidate.kind,
      title: groups.title ?? "",
      season: candidate.season ?? positiveInteger(groups.season),
      episode: positiveInteger(groups.episode ?? groups.dotEpisode ?? groups.shortEpisode ?? groups.longEpisode),
      confidence: candidate.confidence,
    };
  }
  return null;
}

function isReleaseMarkerEpisode(match: RegExpMatchArray) {
  const episode = match.groups?.episode;
  const suffix = match.groups?.suffix?.replace(/^[\s._()[\]{}-]+/, "") ?? "";
  return episode?.length === 1 && THREE_D_RELEASE_MARKER.test(suffix);
}

function animeEnabled(options: ParseMediaOptions) {
  return options.contentTypes?.anime === true;
}

function shouldAttemptAnimeAbsolute(ftpPath: string, options: ParseMediaOptions) {
  if (!animeEnabled(options)) return false;
  return options.contentTypes?.movies === false || hasAnimeFolderCue(ftpPath) || options.libraryLayout === "folders";
}

function shouldUseAnimeAbsolute(ftpPath: string, options: ParseMediaOptions, parsedTitle: string) {
  if (options.contentTypes?.movies === false || hasAnimeFolderCue(ftpPath)) return true;
  if (options.libraryLayout !== "folders") return false;
  const folderTitle = folderTitleOf(ftpPath);
  if (!folderTitle) return false;
  return titleAndYearFrom(folderTitle, null, null).title === parsedTitle;
}

function seriesCatalogKind(ftpPath: string, options: ParseMediaOptions): "series" | "anime" {
  if (animeEnabled(options) && (!options.contentTypes?.series || hasAnimeFolderCue(ftpPath))) return "anime";
  return "series";
}

function movieCatalogKind(ftpPath: string, options: ParseMediaOptions): "movie" | "anime" {
  return animeEnabled(options) && hasAnimeFolderCue(ftpPath) ? "anime" : "movie";
}

function hasAnimeFolderCue(ftpPath: string) {
  const parts = ftpPath.split(/[\\/]/).filter(Boolean).slice(0, -1);
  return parts.some((part) => ANIME_COLLECTION_FOLDERS.test(part.trim()));
}

function shouldUseBareEpisodePattern(ftpPath: string, options: ParseMediaOptions) {
  return /\b(?:anime|tv|show|series)\b/i.test(ftpPath) || options.libraryLayout === "folders";
}

function shouldPreferFolderMovie(ftpPath: string, withoutExtension: string, options: ParseMediaOptions) {
  if (!clearFolderMovieTitle(ftpPath, withoutExtension, options)) return false;
  return !hasMovieBlockingEpisodeMarker(withoutExtension, hasMovieCollectionCue(ftpPath));
}

function hasMovieCollectionCue(ftpPath: string) {
  return MOVIE_COLLECTION_CUE.test(ftpPath.split(/[\\/]/).slice(0, -1).join("/"));
}

function clearFolderMovieTitle(ftpPath: string, withoutExtension: string, options: ParseMediaOptions) {
  if (options.contentTypes?.movies === false) return null;
  if (options.libraryLayout !== "folders") return null;
  const folderTitle = folderNameOf(ftpPath);
  if (!folderTitle) return null;
  const folderYear = lastReleaseYear(folderTitle)?.year;
  if (!folderYear) return null;
  if (MOVIE_COLLECTION_CUE.test(ftpPath)) return folderTitle;
  return releaseYears(withoutExtension).some((match) => match.year === folderYear) ? folderTitle : null;
}

function hasMovieBlockingEpisodeMarker(value: string, inMovieCollection: boolean) {
  return (
    /(?:^|[\s._-])s\d{1,2}e\d{1,3}(?=$|[\s._-]|[A-Z])/i.test(value) ||
    /(?:^|[\s._-])s\d{1,2}[\s._-]+e?\d{1,3}(?![\da-z])/i.test(value) ||
    /(?:^|[\s._-])\d{1,2}x\d{2,3}(?![\da-z])/i.test(value) ||
    /(?:^|[\s._-])\d{1,2}e\d{2,3}(?![\da-z])/i.test(value) ||
    /[a-z]S\d{1,2}(?:E\d{1,3}|\.\d{2,3})(?![\dA-Za-z])/.test(value) ||
    /\(\s*ep(?:isode)?\.?\s*\d{1,3}\s*\)/i.test(value) ||
    // A lone "E01"/"Ep6" is a title word ("Star.Wars.Ep6-Return.of.the.Jedi") inside a movie collection.
    (!inMovieCollection && /(?:^|[\s._-])(?:e\d{2,3}|ep\d{1,3})(?![\da-z])/i.test(value)) ||
    /\bseason[\s._-]*\d{1,2}[\s._-]*(?:episode|ep)[\s._-]*\d{1,3}\b/i.test(value)
  );
}

type MovieTitleParts = TitleYear & { alternate: TitleYear | null };

/**
 * Folder layouts name the movie by folder. The filename year still wins over a conflicting
 * folder year: in production data it was right for Point Break (1991), Mulan (1998), Speed
 * (1994) and Reefer Madness (1936), and wrong for Hellboy II and Misery. The losing year (or a
 * differing filename title such as "Novocaine" for folder "Novacaine") becomes the alternate.
 */
function movieTitleParts(ftpPath: string, withoutExtension: string, yearMatch: YearMatch | null, options: ParseMediaOptions): MovieTitleParts {
  const fileYear = yearMatch?.year ?? null;
  if (options.libraryLayout === "folders") {
    const folderName = folderNameOf(ftpPath);
    if (folderName && !GENERIC_MOVIE_FOLDERS.test(folderName.trim())) {
      const folderParts = titleAndYearFrom(folderName, null, fileYear);
      if (folderParts.title && folderParts.year) {
        const folderYear = lastReleaseYear(folderName)?.year ?? null;
        if (folderYear && fileYear && folderYear !== fileYear) {
          return { ...folderParts, alternate: { title: folderParts.title, year: folderYear } };
        }
        const fileParts = filenameTitleAndYearFrom(withoutExtension, yearMatch);
        const alternateTitle = alternateTitleFor(folderParts.title, fileParts.title);
        return { ...folderParts, alternate: alternateTitle ? { title: alternateTitle, year: fileParts.year ?? folderParts.year } : null };
      }
    }
  }
  return { ...filenameTitleAndYearFrom(withoutExtension, yearMatch), alternate: null };
}

function parseMoviePath(base: BaseFields, withoutExtension: string, options: ParseMediaOptions): ParsedMedia {
  const movieTitle = movieTitleParts(base.ftpPath, withoutExtension, lastReleaseYear(withoutExtension), options);
  return {
    ...base,
    mediaKind: "movie",
    catalogKind: movieCatalogKind(base.ftpPath, options),
    parsedTitle: movieTitle.title,
    parsedYear: movieTitle.year,
    season: null,
    episode: null,
    confidence: base.imdbId ? 90 : movieTitle.year ? 70 : 45,
    alternateTitle: movieTitle.alternate?.title ?? null,
    alternateYear: movieTitle.alternate ? movieTitle.alternate.year : null,
  };
}

function titleAndYearFrom(value: string, yearMatch: YearMatch | null, fallbackYear: number | null): TitleYear {
  const match = yearMatch ?? lastReleaseYear(value);
  const year = fallbackYear ?? match?.year ?? null;
  const titleSource = match ? (match.index === 0 ? value.slice(match.index + 4) : value.slice(0, match.index)) : value;
  return {
    title: normalizeTitle(stripKnownTokens(titleSource)),
    year,
  };
}

function filenameTitleAndYearFrom(value: string, yearMatch: YearMatch | null): TitleYear {
  const native = titleAndYearFrom(value, yearMatch, null);
  const fallback = libraryMovieTitleAndYearFrom(value);
  if (!fallback) return native;
  if (!native.title || !native.year || fallback.year === native.year) return fallback;
  return native;
}

function libraryMovieTitleAndYearFrom(value: string): TitleYear | null {
  const parsed = filenameParse(value, false);
  const title = normalizeTitle(stripKnownTokens(parsed.title || ""));
  const parsedYear = typeof parsed.year === "string" ? Number(parsed.year) : null;
  if (!title) return null;
  const plausibleYears = new Set(releaseYears(value).map((match) => match.year));
  return {
    title,
    year: parsedYear !== null && plausibleYears.has(parsedYear) ? parsedYear : null,
  };
}
