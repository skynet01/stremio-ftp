import type { CatalogItem, PersistedCatalogMeta } from "../media/mediaRepository.js";
import { normalizeTitle } from "../media/normalizer.js";
import { TtlCache } from "./ttlCache.js";

export type TmdbCatalogKind = "movie" | "series" | "anime";

export type CatalogMeta = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
};

export type TmdbEnrichmentResult =
  | { status: "matched"; meta: CatalogMeta }
  | { status: "unmatched" }
  | { status: "retry"; error: string };

type TmdbFindResponse = {
  movie_results?: TmdbMovie[];
  tv_results?: TmdbTv[];
};

type TmdbSearchResponse<T> = {
  results?: T[];
};

type TmdbMovie = {
  id?: number;
  title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  genre_ids?: number[];
};

type TmdbTv = {
  id?: number;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string;
  genre_ids?: number[];
};

type TmdbExternalIds = {
  imdb_id?: string | null;
};

const TMDB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TMDB_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const TMDB_CACHE_MAX_ENTRIES = 1000;
const TMDB_TIMEOUT_MS = 10000;
const catalogMetaCache = new TtlCache<Promise<CatalogMeta | null>>(TMDB_CACHE_MAX_ENTRIES);
const TITLE_RELATIONSHIP_STOP_WORDS = new Set(["a", "an", "and", "in", "of", "or", "the", "to"]);
const TITLE_REGION_TOKENS = new Set(["au", "ca", "nz", "uk", "us"]);
const TITLE_NUMBER_TOKENS = new Map([
  ["one", "1"],
  ["i", "1"],
  ["two", "2"],
  ["ii", "2"],
  ["three", "3"],
  ["iii", "3"],
  ["four", "4"],
  ["iv", "4"],
  ["five", "5"],
  ["v", "5"],
  ["six", "6"],
  ["vi", "6"],
  ["seven", "7"],
  ["vii", "7"],
  ["eight", "8"],
  ["viii", "8"],
  ["nine", "9"],
  ["ix", "9"],
  ["ten", "10"],
  ["x", "10"],
  ["eleven", "11"],
  ["twelve", "12"],
  ["thirteen", "13"],
  ["fourteen", "14"],
  ["fifteen", "15"],
  ["sixteen", "16"],
  ["seventeen", "17"],
  ["eighteen", "18"],
  ["nineteen", "19"],
  ["twenty", "20"],
]);
const MOVIE_GENRES = new Map([
  [28, "Action"],
  [12, "Adventure"],
  [16, "Animation"],
  [35, "Comedy"],
  [80, "Crime"],
  [99, "Documentary"],
  [18, "Drama"],
  [10751, "Family"],
  [14, "Fantasy"],
  [36, "History"],
  [27, "Horror"],
  [10402, "Music"],
  [9648, "Mystery"],
  [10749, "Romance"],
  [878, "Science Fiction"],
  [10770, "TV Movie"],
  [53, "Thriller"],
  [10752, "War"],
  [37, "Western"],
]);
const TV_GENRES = new Map([
  [10759, "Action & Adventure"],
  [16, "Animation"],
  [35, "Comedy"],
  [80, "Crime"],
  [99, "Documentary"],
  [18, "Drama"],
  [10751, "Family"],
  [10762, "Kids"],
  [9648, "Mystery"],
  [10763, "News"],
  [10764, "Reality"],
  [10765, "Sci-Fi & Fantasy"],
  [10766, "Soap"],
  [10767, "Talk"],
  [10768, "War & Politics"],
  [37, "Western"],
]);

export async function tmdbCatalogMeta(item: CatalogItem, apiKey: string | null, catalogKind: TmdbCatalogKind = item.catalogKind): Promise<CatalogMeta | null> {
  if (!apiKey) return item.imdbId ? fallbackMeta(item, item.imdbId, catalogKind) : null;

  const cacheKey = [
    apiKey,
    catalogKind,
    item.imdbId ?? "",
    item.parsedTitle.toLowerCase(),
    item.parsedYear ?? "",
    item.alternateYear ?? "",
  ].join("|");
  const cached = catalogMetaCache.get(cacheKey);
  if (cached) return cached;

  const lookup = item.imdbId ? metaFromImdbId(item, item.imdbId, apiKey, catalogKind) : metaFromSearch(item, apiKey, catalogKind);
  const value: Promise<CatalogMeta | null> = lookup.catch(() => {
    if (catalogMetaCache.get(cacheKey) === value) catalogMetaCache.set(cacheKey, value, TMDB_FAILURE_CACHE_TTL_MS);
    return null;
  });
  catalogMetaCache.set(cacheKey, value, TMDB_CACHE_TTL_MS);
  return value;
}

export async function tmdbCatalogEnrichment(
  item: CatalogItem,
  apiKey: string | null,
  catalogKind: TmdbCatalogKind = item.catalogKind,
): Promise<TmdbEnrichmentResult> {
  try {
    const meta = item.imdbId ? await metaFromImdbId(item, item.imdbId, apiKey, catalogKind) : await metaFromSearch(item, apiKey, catalogKind);
    if (meta) return { status: "matched", meta };
    return { status: "unmatched" };
  } catch (error) {
    return { status: "retry", error: error instanceof Error ? error.message : "TMDB enrichment failed" };
  }
}

export function clearTmdbCatalogCache() {
  catalogMetaCache.clear();
}

export function catalogMetaMatchesItem(item: CatalogItem, meta: PersistedCatalogMeta, catalogKind: TmdbCatalogKind): boolean {
  if (meta.type !== (catalogKind === "movie" ? "movie" : "series")) return false;
  const year = searchYear(item);
  const alternateYear = item.alternateTitle ? item.alternateYear : null;
  const metaYear = Number(meta.releaseInfo?.slice(0, 4));
  if (year && metaYear && Math.abs(year - metaYear) > 1 && !(alternateYear && Math.abs(alternateYear - metaYear) <= 1)) return false;
  const exactYear = Boolean(metaYear && (year === metaYear || alternateYear === metaYear));
  return storedTitleFits(titleWithoutEditionSuffix(item.parsedTitle), meta.name, exactYear) ||
    Boolean(item.alternateTitle && storedTitleFits(titleWithoutEditionSuffix(item.alternateTitle), meta.name, exactYear));
}

// A stored match may have come from a TMDB alternate title or drop a franchise prefix ("Rambo First Blood" ->
// "First Blood"), so a recheck keeps it on looser title evidence than a fresh search accepts.
function storedTitleFits(expectedTitle: string, storedTitle: string, exactYear: boolean) {
  if (titleRelationshipScore(expectedTitle, storedTitle) > 0) return true;
  const expectedTokens = relationshipTokens(normalizeRelationshipTitle(expectedTitle));
  const storedTokens = relationshipTokens(normalizeRelationshipTitle(storedTitle));
  if (!expectedTokens.length || !storedTokens.length) return false;
  const expectedSet = new Set(expectedTokens);
  const storedSet = new Set(storedTokens);
  if (storedTokens.every((token) => expectedSet.has(token))) return true;
  // "Misery" -> "Misery Harbour" in the same year; "Fall" -> "Heavens Fall" is not kept.
  if (expectedSet.size === 1) return exactYear && storedTokens[0] === expectedTokens[0];
  const commonTokens = Array.from(expectedSet).filter((token) => storedSet.has(token)).length;
  return commonTokens >= 2 && (commonTokens / expectedSet.size >= 0.5 || commonTokens / storedSet.size >= 0.5);
}

// Decides what a recheck keeps: a still-valid stored match wins unless the fresh match's title is a closer fit.
export function catalogRecheckChoice(
  item: CatalogItem,
  existing: PersistedCatalogMeta | null | undefined,
  fresh: PersistedCatalogMeta | null,
  catalogKind: TmdbCatalogKind,
): "existing" | "fresh" | "none" {
  const existingValid = Boolean(existing && catalogMetaMatchesItem(item, existing, catalogKind));
  if (!fresh) return existingValid ? "existing" : "none";
  if (!existingValid || item.imdbId) return "fresh";
  return metaTitleScore(item, fresh) > metaTitleScore(item, existing!) ? "fresh" : "existing";
}

function metaTitleScore(item: CatalogItem, meta: PersistedCatalogMeta) {
  return Math.max(
    titleRelationshipScore(titleWithoutEditionSuffix(item.parsedTitle), meta.name),
    item.alternateTitle ? titleRelationshipScore(titleWithoutEditionSuffix(item.alternateTitle), meta.name) : 0,
  );
}

function searchYear(item: CatalogItem): number | null {
  return item.parsedYear ?? item.alternateYear ?? null;
}

async function metaFromImdbId(item: CatalogItem, imdbId: string, apiKey: string | null, catalogKind: TmdbCatalogKind): Promise<CatalogMeta | null> {
  if (!apiKey) return fallbackMeta(item, imdbId, catalogKind);
  const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("external_source", "imdb_id");
  const body = await fetchJson<TmdbFindResponse>(url);
  if (!body) return fallbackMeta(item, imdbId, catalogKind);
  const result = catalogKind === "movie" ? body.movie_results?.[0] : body.tv_results?.[0];
  if (!result) return fallbackMeta(item, imdbId, catalogKind);

  return metaFromTmdbResult(item, imdbId, result, catalogKind);
}

async function metaFromSearch(item: CatalogItem, apiKey: string | null, catalogKind: TmdbCatalogKind): Promise<CatalogMeta | null> {
  if (!apiKey) return null;
  const query = titleWithoutEditionSuffix(item.parsedTitle);
  let hadResults = false;
  const first = await metaFromSearchQuery(item, apiKey, catalogKind, query, true, (value) => { hadResults = value; });
  if (first) return first;
  const alternate = item.alternateTitle ? titleWithoutEditionSuffix(item.alternateTitle) : null;
  if (alternate && alternate !== query) {
    const alternateItem = { ...item, parsedTitle: item.alternateTitle!, parsedYear: item.alternateYear ?? item.parsedYear };
    return metaFromSearchQuery(alternateItem, apiKey, catalogKind, alternate, true);
  }
  const variant = hadResults ? wordNumberSequelTitle(query) ?? romanNumeralSequelTitle(query) : romanNumeralSequelTitle(query) ?? wordNumberSequelTitle(query);
  if (variant && variant !== query) return metaFromSearchQuery(item, apiKey, catalogKind, variant, true);
  return searchYear(item) ? metaFromSearchQuery(item, apiKey, catalogKind, query, false) : null;
}

async function metaFromSearchQuery(
  item: CatalogItem,
  apiKey: string,
  catalogKind: TmdbCatalogKind,
  query: string,
  includeYear: boolean,
  onResults?: (hadResults: boolean) => void,
): Promise<CatalogMeta | null> {
  const searchType = catalogKind === "movie" ? "movie" : "tv";
  const url = new URL(`https://api.themoviedb.org/3/search/${searchType}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", query);
  const year = searchYear(item);
  if (includeYear && year) {
    url.searchParams.set(catalogKind === "movie" ? "year" : "first_air_date_year", String(year));
  }

  const body = await fetchJson<TmdbSearchResponse<TmdbMovie | TmdbTv>>(url);
  if (!body) return null;
  onResults?.(Boolean(body.results?.length));
  const result = await resultWithImdbId(item, catalogKind, searchType, body.results ?? [], apiKey, query);
  if (!result) return null;

  return metaFromTmdbResult(item, result.imdbId, result.result, catalogKind);
}

async function resultWithImdbId(
  item: CatalogItem,
  catalogKind: TmdbCatalogKind,
  searchType: "movie" | "tv",
  results: Array<TmdbMovie | TmdbTv>,
  apiKey: string,
  query: string,
) {
  const normalizedQuery = normalizeRelationshipTitle(query);
  const ranked = results
    .filter((result): result is (TmdbMovie | TmdbTv) & { id: number } => Boolean(result.id))
    .filter((result) => resultHasPlausibleYear(item, catalogKind, result))
    .map((result, index) => ({
      result,
      index,
      score: resultScore(item, catalogKind, result),
      titleScore: titleRelationshipScore(query, resultTitle(result, catalogKind)),
      exactTitle: normalizeRelationshipTitle(resultTitle(result, catalogKind)) === normalizedQuery,
    }))
    .filter((candidate) => candidate.titleScore > 0)
    .sort((a, b) => Number(b.exactTitle) - Number(a.exactTitle) || b.score - a.score || a.index - b.index);

  for (const candidate of ranked) {
    const externalIds = await fetchExternalIds(searchType, candidate.result.id, apiKey);
    if (externalIds?.imdb_id) return { result: candidate.result, imdbId: externalIds.imdb_id };
  }
  return null;
}

function resultScore(item: CatalogItem, catalogKind: TmdbCatalogKind, result: TmdbMovie | TmdbTv) {
  const titleScore = titleRelationshipScore(item.parsedTitle, resultTitle(result, catalogKind));
  const resultYear = resultReleaseYear(result, catalogKind);
  const year = searchYear(item);
  const yearScore =
    year && resultYear
      ? year === resultYear
        ? 50
        : Math.abs(year - resultYear) <= 1
          ? 10
          : -50
      : 0;
  return titleScore + yearScore;
}

function resultHasPlausibleYear(item: CatalogItem, catalogKind: TmdbCatalogKind, result: TmdbMovie | TmdbTv) {
  const resultYear = resultReleaseYear(result, catalogKind);
  const year = searchYear(item);
  return !year || !resultYear || Math.abs(year - resultYear) <= 1;
}

function titleRelationshipScore(expectedTitle: string, resultTitleValue: string) {
  const normalizedExpectedTitle = normalizeRelationshipTitle(expectedTitle);
  const normalizedResultTitle = normalizeRelationshipTitle(resultTitleValue);
  if (!normalizedExpectedTitle || !normalizedResultTitle) return 0;
  if (normalizedResultTitle === normalizedExpectedTitle) return 100;
  const expectedTokens = relationshipTokens(normalizedExpectedTitle);
  const resultTokens = relationshipTokens(normalizedResultTitle);
  if (!expectedTokens.length || !resultTokens.length) return 0;
  // Spacing and punctuation differ between releases and TMDB: "Dandadan" / "Dan Da Dan", "Titan A E" / "Titan A.E.".
  if (expectedTokens.join(" ") === resultTokens.join(" ") || expectedTokens.join("") === resultTokens.join("") ||
    normalizedExpectedTitle.replace(/ /g, "") === normalizedResultTitle.replace(/ /g, "")) return 50;
  // "The Office US" -> "The Office"; "Borat" -> "Borat: Cultural Learnings of America..."
  if (TITLE_REGION_TOKENS.has(expectedTokens.at(-1)!) && !resultTokens.includes(expectedTokens.at(-1)!) &&
    expectedTokens.slice(0, -1).join(" ") === resultTokens.join(" ")) return 25;
  const resultMainTitle = resultTitleValue.split(/\s*[:–—]\s*|\s+-\s+/)[0];
  if (resultMainTitle !== resultTitleValue && relationshipTokens(normalizeRelationshipTitle(resultMainTitle)).join(" ") === expectedTokens.join(" ")) return 25;
  const expectedSet = new Set(expectedTokens);
  const resultSet = new Set(resultTokens);
  if (expectedSet.size === 1) return 0;
  if (Array.from(expectedSet).every((token) => resultSet.has(token))) return 25;
  const commonTokens = Array.from(expectedSet).filter((token) => resultSet.has(token)).length;
  // Regional variants such as "Sorcerer's Stone" / "Philosopher's Stone" differ by one word in a long title.
  if (commonTokens >= 3 && commonTokens / expectedSet.size >= 0.75 && commonTokens / resultSet.size >= 0.75) return 25;
  return expectedTokens.some((token) => /^(?:[2-9]|1\d|20)$/.test(token)) && commonTokens >= 2 ? 25 : 0;
}

function normalizeRelationshipTitle(value: string) {
  return normalizeTitle(value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/æ/gi, "ae").replace(/œ/gi, "oe"));
}

// "3D" in a TMDB title ("Saw 3D", "Amityville 3-D") marks the format, not the film; plurals fold ("Beast"/"Beasts").
function relationshipTokens(value: string) {
  return value
    .replace(/\b3 d\b/g, "3d")
    .split(" ")
    .filter((token) => token !== "3d" && !TITLE_RELATIONSHIP_STOP_WORDS.has(token))
    .map((token) => TITLE_NUMBER_TOKENS.get(token) ?? token)
    .map((token) => (/^[a-z]{4,}s$/.test(token) && !token.endsWith("ss") ? token.slice(0, -1) : token))
    .filter((token) => token.length >= 2 || /^\d+$/.test(token));
}

function resultTitle(result: TmdbMovie | TmdbTv, catalogKind: TmdbCatalogKind) {
  return catalogKind === "movie" ? (result as TmdbMovie).title || "" : (result as TmdbTv).name || "";
}

function resultReleaseYear(result: TmdbMovie | TmdbTv, catalogKind: TmdbCatalogKind) {
  const date = catalogKind === "movie" ? (result as TmdbMovie).release_date : (result as TmdbTv).first_air_date;
  const year = date?.slice(0, 4);
  return year && /^\d{4}$/.test(year) ? Number(year) : null;
}

function titleWithoutEditionSuffix(parsedTitle: string) {
  return parsedTitle
    .replace(/\b(?:(?:killer|legacy|ultimate|director(?:s)?|ulysses|final|special|theatrical|restored|collector(?:s)?)\s+(?:cut|edition|version)|(?:uncut|extended|unrated|remastered|3d)(?:\s+edition)?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || parsedTitle;
}

function romanNumeralSequelTitle(parsedTitle: string) {
  const romanByNumber: Record<string, string> = {
    "2": "ii",
    "3": "iii",
    "4": "iv",
    "5": "v",
    "6": "vi",
    "7": "vii",
    "8": "viii",
    "9": "ix",
    "10": "x",
  };
  const match = parsedTitle.match(/\b(2|3|4|5|6|7|8|9|10)$/);
  if (!match) return null;
  return parsedTitle.replace(/\b(2|3|4|5|6|7|8|9|10)$/, romanByNumber[match[1]]);
}

function wordNumberSequelTitle(parsedTitle: string) {
  const wordByNumber: Record<string, string> = {
    "2": "two",
    "3": "three",
    "4": "four",
    "5": "five",
    "6": "six",
    "7": "seven",
    "8": "eight",
    "9": "nine",
    "10": "ten",
  };
  const match = parsedTitle.match(/\b(2|3|4|5|6|7|8|9|10)$/);
  if (!match) return null;
  return parsedTitle.replace(/\b(2|3|4|5|6|7|8|9|10)$/, wordByNumber[match[1]]);
}

async function fetchExternalIds(type: "movie" | "tv", tmdbId: number, apiKey: string): Promise<TmdbExternalIds | null> {
  const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids`);
  url.searchParams.set("api_key", apiKey);
  return fetchJson<TmdbExternalIds>(url);
}

async function fetchJson<T>(url: URL): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new Error(`TMDB request failed with ${response.status}`);
    }
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || /TMDB request failed/.test(error.message))) throw error;
    throw new Error("TMDB request failed");
  } finally {
    clearTimeout(timeout);
  }
}

function metaFromTmdbResult(item: CatalogItem, imdbId: string, result: TmdbMovie | TmdbTv, catalogKind: TmdbCatalogKind): CatalogMeta {
  const movieResult = catalogKind === "movie" ? (result as TmdbMovie) : null;
  const tvResult = catalogKind !== "movie" ? (result as TmdbTv) : null;
  const title = movieResult ? movieResult.title : tvResult?.name;
  const date = movieResult ? movieResult.release_date : tvResult?.first_air_date;
  return {
    id: imdbId,
    type: catalogKind === "movie" ? "movie" : "series",
    name: title?.trim() || titleCase(item.parsedTitle),
    poster: imageUrl(result.poster_path),
    background: imageUrl(result.backdrop_path),
    description: result.overview || undefined,
    releaseInfo: date?.slice(0, 4) || (item.parsedYear ? String(item.parsedYear) : undefined),
    genres: genreNames(result.genre_ids, catalogKind),
  };
}

function fallbackMeta(item: CatalogItem, imdbId: string, catalogKind: TmdbCatalogKind): CatalogMeta {
  return {
    id: imdbId,
    type: catalogKind === "movie" ? "movie" : "series",
    name: titleCase(item.parsedTitle),
    releaseInfo: item.parsedYear ? String(item.parsedYear) : undefined,
  };
}

function genreNames(genreIds: number[] | undefined, catalogKind: TmdbCatalogKind) {
  const genreMap = catalogKind === "movie" ? MOVIE_GENRES : TV_GENRES;
  const genres = Array.from(new Set((genreIds ?? []).map((id) => genreMap.get(id)).filter((genre): genre is string => Boolean(genre))));
  return genres.length ? genres : undefined;
}

function imageUrl(path: string | null | undefined) {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
