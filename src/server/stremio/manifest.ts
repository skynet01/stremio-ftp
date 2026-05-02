import { DEFAULT_ADDON_CUSTOMIZATION, type AddonCustomization } from "../profiles/profileService.js";

export function publicManifest(customization: Partial<AddonCustomization> = {}) {
  const addonName = customization.addonName?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonName;
  const addonLogoUrl = customization.addonLogoUrl?.trim() || "";
  const addonDescription = customization.addonDescription?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonDescription;
  return {
    id: "community.stremio-ftp",
    version: "0.1.0",
    name: addonName,
    description: addonDescription,
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
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
