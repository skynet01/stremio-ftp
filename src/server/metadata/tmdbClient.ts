import type { CatalogItem } from "../media/mediaRepository.js";

export type TmdbCatalogKind = "movie" | "series" | "anime";

export type CatalogMeta = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
};

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
};

type TmdbTv = {
  id?: number;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string;
};

type TmdbExternalIds = {
  imdb_id?: string | null;
};

export async function tmdbCatalogMeta(item: CatalogItem, apiKey: string | null, catalogKind: TmdbCatalogKind = item.catalogKind): Promise<CatalogMeta | null> {
  if (!apiKey) return item.imdbId ? fallbackMeta(item, item.imdbId, catalogKind) : null;

  return item.imdbId ? metaFromImdbId(item, item.imdbId, apiKey, catalogKind) : metaFromSearch(item, apiKey, catalogKind);
}

async function metaFromImdbId(item: CatalogItem, imdbId: string, apiKey: string, catalogKind: TmdbCatalogKind): Promise<CatalogMeta | null> {
  const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("external_source", "imdb_id");
  const response = await fetch(url);
  if (!response.ok) return fallbackMeta(item, imdbId, catalogKind);
  const body = (await response.json()) as TmdbFindResponse;
  const result = catalogKind === "movie" ? body.movie_results?.[0] : body.tv_results?.[0];
  if (!result) return fallbackMeta(item, imdbId, catalogKind);

  return metaFromTmdbResult(item, imdbId, result, catalogKind);
}

async function metaFromSearch(item: CatalogItem, apiKey: string, catalogKind: TmdbCatalogKind): Promise<CatalogMeta | null> {
  const searchType = catalogKind === "movie" ? "movie" : "tv";
  const url = new URL(`https://api.themoviedb.org/3/search/${searchType}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", item.parsedTitle);
  if (item.parsedYear) {
    url.searchParams.set(catalogKind === "movie" ? "year" : "first_air_date_year", String(item.parsedYear));
  }

  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as TmdbSearchResponse<TmdbMovie | TmdbTv>;
  const result = body.results?.[0];
  if (!result?.id) return null;

  const externalIds = await fetchExternalIds(searchType, result.id, apiKey);
  if (!externalIds?.imdb_id) return null;

  return metaFromTmdbResult(item, externalIds.imdb_id, result, catalogKind);
}

async function fetchExternalIds(type: "movie" | "tv", tmdbId: number, apiKey: string): Promise<TmdbExternalIds | null> {
  const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids`);
  url.searchParams.set("api_key", apiKey);
  const response = await fetch(url);
  if (!response.ok) return null;
  return (await response.json()) as TmdbExternalIds;
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
