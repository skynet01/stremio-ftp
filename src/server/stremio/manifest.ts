import { DEFAULT_ADDON_CUSTOMIZATION, type AddonCustomization } from "../profiles/profileService.js";

const ADDON_VERSION = "0.4.9";

export function publicManifest(customization: Partial<AddonCustomization> = {}) {
  const addonName = customization.addonName?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonName;
  const addonLogoUrl = customization.addonLogoUrl?.trim() || "";
  const addonDescription = customization.addonDescription?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonDescription;
  const catalogEnabled = customization.catalogEnabled === true;
  const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
  const catalogs = [
    ...(contentTypes.movies ? [{ type: "movie", id: "ftp-movies", name: `${addonName} Movies`, extra: [{ name: "skip" }] }] : []),
    ...(contentTypes.series ? [{ type: "series", id: "ftp-series", name: `${addonName} Series`, extra: [{ name: "skip" }] }] : []),
    ...(contentTypes.anime ? [{ type: "series", id: "ftp-anime", name: `${addonName} Anime`, extra: [{ name: "skip" }] }] : []),
    { type: "movie", id: "ftp-other", name: `${addonName} Other`, extra: [{ name: "skip" }] },
  ];
  return {
    id: "community.stremio-ftp",
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

export function tokenManifest(customization: Partial<AddonCustomization> = {}) {
  return {
    ...publicManifest(customization),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
