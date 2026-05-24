import type { CatalogItem } from "../media/mediaRepository.js";
import { normalizeTitle } from "../media/normalizer.js";

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
const TMDB_TIMEOUT_MS = 10000;
const catalogMetaCache = new Map<string, { expiresAt: number; value: Promise<CatalogMeta | null> }>();
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
  ].join("|");
  const cached = catalogMetaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = (item.imdbId ? metaFromImdbId(item, item.imdbId, apiKey, catalogKind) : metaFromSearch(item, apiKey, catalogKind)).catch(
    () => null,
  );
  catalogMetaCache.set(cacheKey, { expiresAt: Date.now() + TMDB_CACHE_TTL_MS, value });
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
    if (catalogKind !== "movie") {
      const movieMeta = item.imdbId ? await metaFromImdbId(item, item.imdbId, apiKey, "movie") : await metaFromSearch(item, apiKey, "movie");
      if (movieMeta) return { status: "matched", meta: movieMeta };
    }
    return { status: "unmatched" };
  } catch (error) {
    return { status: "retry", error: error instanceof Error ? error.message : "TMDB enrichment failed" };
  }
}

export function clearTmdbCatalogCache() {
  catalogMetaCache.clear();
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
  const queries = searchQueries(item.parsedTitle);
  for (const query of queries) {
    const meta = await metaFromSearchQuery(item, apiKey, catalogKind, query, true);
    if (meta) return meta;
  }
  if (!item.parsedYear) return null;
  for (const query of queries) {
    const metaWithoutYear = await metaFromSearchQuery(item, apiKey, catalogKind, query, false);
    if (metaWithoutYear) return metaWithoutYear;
  }
  return null;
}

async function metaFromSearchQuery(
  item: CatalogItem,
  apiKey: string,
  catalogKind: TmdbCatalogKind,
  query: string,
  includeYear: boolean,
): Promise<CatalogMeta | null> {
  const searchType = catalogKind === "movie" ? "movie" : "tv";
  const url = new URL(`https://api.themoviedb.org/3/search/${searchType}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", query);
  if (includeYear && item.parsedYear) {
    url.searchParams.set(catalogKind === "movie" ? "year" : "first_air_date_year", String(item.parsedYear));
  }

  const body = await fetchJson<TmdbSearchResponse<TmdbMovie | TmdbTv>>(url);
  if (!body) return null;
  const result = await resultWithImdbId(item, catalogKind, searchType, body.results ?? [], apiKey);
  if (!result) return null;

  return metaFromTmdbResult(item, result.imdbId, result.result, catalogKind);
}

async function resultWithImdbId(
  item: CatalogItem,
  catalogKind: TmdbCatalogKind,
  searchType: "movie" | "tv",
  results: Array<TmdbMovie | TmdbTv>,
  apiKey: string,
) {
  const ranked = results
    .filter((result): result is (TmdbMovie | TmdbTv) & { id: number } => Boolean(result.id))
    .map((result, index) => ({ result, index, score: resultScore(item, catalogKind, result) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const candidate of ranked) {
    const externalIds = await fetchExternalIds(searchType, candidate.result.id, apiKey);
    if (externalIds?.imdb_id) return { result: candidate.result, imdbId: externalIds.imdb_id };
  }
  return null;
}

function resultScore(item: CatalogItem, catalogKind: TmdbCatalogKind, result: TmdbMovie | TmdbTv) {
  const normalizedResultTitle = normalizeTitle(resultTitle(result, catalogKind));
  const titleScore =
    normalizedResultTitle === item.parsedTitle
      ? 100
      : normalizedResultTitle.includes(item.parsedTitle) || item.parsedTitle.includes(normalizedResultTitle)
        ? 25
        : 0;
  const resultYear = resultReleaseYear(result, catalogKind);
  const yearScore =
    item.parsedYear && resultYear
      ? item.parsedYear === resultYear
        ? 50
        : Math.abs(item.parsedYear - resultYear) <= 1
          ? 10
          : -50
      : 0;
  return titleScore + yearScore;
}

function resultTitle(result: TmdbMovie | TmdbTv, catalogKind: TmdbCatalogKind) {
  return catalogKind === "movie" ? (result as TmdbMovie).title || "" : (result as TmdbTv).name || "";
}

function resultReleaseYear(result: TmdbMovie | TmdbTv, catalogKind: TmdbCatalogKind) {
  const date = catalogKind === "movie" ? (result as TmdbMovie).release_date : (result as TmdbTv).first_air_date;
  const year = date?.slice(0, 4);
  return year && /^\d{4}$/.test(year) ? Number(year) : null;
}

function searchQueries(parsedTitle: string) {
  const queries = [parsedTitle];
  const editionless = titleWithoutEditionSuffix(parsedTitle);
  if (editionless && editionless !== parsedTitle) queries.push(editionless);
  const roman = romanNumeralSequelTitle(parsedTitle);
  if (roman && roman !== parsedTitle) queries.push(roman);
  return queries;
}

function titleWithoutEditionSuffix(parsedTitle: string) {
  return parsedTitle
    .replace(
      /\b(?:director(?:s)?|extended|final|special|theatrical|ultimate|ulysses|unrated|restored|remastered|collector(?:s)?)\s+(?:cut|edition|version)\b$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
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
    if (response.status === 429 || response.status >= 500) throw new Error(`TMDB request failed with ${response.status}`);
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
