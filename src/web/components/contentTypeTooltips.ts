export const CONTENT_TYPE_TOOLTIPS = {
  movies: "Indexes movie files. Anime movies are separated only when Anime is enabled and the path uses an anime folder such as /Anime Movies.",
  series: "Indexes series episode files. Anime series are separated when Anime is enabled and the path uses an anime folder such as /Anime Shows.",
  anime:
    "Separates anime movies and anime series when paths use folders such as /Anime Movies or /Anime Shows. In a single flat folder without anime in the path, anime movies stay in Movies.",
} as const;
