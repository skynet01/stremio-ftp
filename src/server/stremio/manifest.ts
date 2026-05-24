import { createHash } from "node:crypto";
import { DEFAULT_ADDON_CUSTOMIZATION, type AddonCustomization } from "../profiles/profileService.js";

const ADDON_VERSION = "0.4.45";
const ADDON_ID = "community.stremio-ftp";
const SEARCHABLE_CATALOG_EXTRAS = [{ name: "skip" }, { name: "search" }];
const GENRE_CATALOG_EXTRAS = [
  ...SEARCHABLE_CATALOG_EXTRAS,
  {
    name: "genre",
    options: [
      "Action",
      "Action & Adventure",
      "Adventure",
      "Animation",
      "Comedy",
      "Crime",
      "Documentary",
      "Drama",
      "Family",
      "Fantasy",
      "History",
      "Horror",
      "Kids",
      "Music",
      "Mystery",
      "News",
      "Reality",
      "Romance",
      "Science Fiction",
      "Sci-Fi & Fantasy",
      "Soap",
      "Talk",
      "TV Movie",
      "Thriller",
      "War",
      "War & Politics",
      "Western",
    ],
  },
];

type ManifestCustomization = Partial<AddonCustomization> & {
  otherCatalogs?: Array<{ id: string; name: string }>;
};

export function publicManifest(customization: ManifestCustomization = {}) {
  const addonName = customization.addonName?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonName;
  const addonLogoUrl = customization.addonLogoUrl?.trim() || "";
  const addonDescription = customization.addonDescription?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonDescription;
  const catalogEnabled = customization.catalogEnabled === true;
  const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
  const catalogs = [
    ...(contentTypes.movies ? [{ type: "movie", id: "ftp-movies", name: `${addonName} Movies`, extra: GENRE_CATALOG_EXTRAS }] : []),
    ...(contentTypes.series ? [{ type: "series", id: "ftp-series", name: `${addonName} Series`, extra: GENRE_CATALOG_EXTRAS }] : []),
    ...(contentTypes.anime ? [{ type: "series", id: "ftp-anime", name: `${addonName} Anime`, extra: GENRE_CATALOG_EXTRAS }] : []),
    ...(contentTypes.uncategorized !== false
      ? otherCatalogEntries(addonName, customization.otherCatalogs)
      : []),
  ];
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: addonName,
    description: addonDescription,
    resources: catalogEnabled ? ["stream", "catalog", "meta"] : ["stream"],
    types: ["movie", "series"],
    idPrefixes: catalogEnabled ? ["tt", "ftp"] : ["tt"],
    catalogs: catalogEnabled ? catalogs : [],
    ...(addonLogoUrl ? { logo: addonLogoUrl } : {}),
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}

export function tokenManifest(customization: ManifestCustomization = {}, installToken = "") {
  return {
    ...publicManifest(customization),
    id: tokenAddonId(installToken),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

function otherCatalogEntries(addonName: string, otherCatalogs: ManifestCustomization["otherCatalogs"]) {
  if (!otherCatalogs?.length) return [{ type: "movie", id: "ftp-other", name: `${addonName} Other`, extra: SEARCHABLE_CATALOG_EXTRAS }];
  return otherCatalogs.map((catalog) => ({
    type: "movie",
    id: catalog.id,
    name: catalog.name,
    extra: SEARCHABLE_CATALOG_EXTRAS,
  }));
}

function tokenAddonId(installToken: string) {
  const suffix = installToken ? createHash("sha256").update(installToken).digest("hex").slice(0, 12) : "";
  return suffix ? `${ADDON_ID}.${suffix}` : ADDON_ID;
}
