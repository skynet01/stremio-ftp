import { DEFAULT_ADDON_CUSTOMIZATION, type AddonCustomization } from "../profiles/profileService.js";

export function publicManifest(customization: Partial<AddonCustomization> = {}) {
  const addonName = customization.addonName?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonName;
  const addonLogoUrl = customization.addonLogoUrl?.trim() || "";
  const addonDescription = customization.addonDescription?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonDescription;
  const catalogEnabled = customization.catalogEnabled === true;
  return {
    id: "community.stremio-ftp",
    version: "0.1.0",
    name: addonName,
    description: addonDescription,
    resources: catalogEnabled ? ["stream", "catalog", "meta"] : ["stream"],
    types: ["movie", "series"],
    idPrefixes: catalogEnabled ? ["tt", "ftp"] : ["tt"],
    catalogs: catalogEnabled
      ? [
          { type: "movie", id: "ftp-movies", name: `${addonName} Movies`, extra: [{ name: "skip" }] },
          { type: "series", id: "ftp-series", name: `${addonName} Series`, extra: [{ name: "skip" }] },
          { type: "movie", id: "ftp-other", name: `${addonName} Other`, extra: [{ name: "skip" }] },
        ]
      : [],
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
