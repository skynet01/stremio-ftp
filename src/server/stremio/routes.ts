import { Router } from "express";
import type { AppConfig } from "../config.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import { fetchCinemetaMeta } from "../metadata/cinemetaClient.js";
import { tmdbCatalogMeta, type TmdbCatalogKind } from "../metadata/tmdbClient.js";
import { DEFAULT_ADDON_CUSTOMIZATION, type AddonCustomization, type ProfileService } from "../profiles/profileService.js";
import { redactSecrets } from "../logging/redact.js";
import { publicManifest, tokenManifest } from "./manifest.js";
import { resolveStreams, streamForMatch } from "./streamResolver.js";

type StremioType = "movie" | "series";

export function stremioRoutes(config: AppConfig, profiles: ProfileService, mediaRepository: MediaRepository) {
  const router = Router();

  router.get("/manifest.json", (_req, res) => {
    res.json(publicManifest());
  });

  router.get("/u/:installToken/manifest.json", (req, res) => {
    const installToken = stringParam(req.params.installToken);
    const profileId = profiles.profileIdForInstallToken(installToken);
    res.setHeader("Cache-Control", "no-store");
    res.json(profileId ? tokenManifest(manifestCustomization(profiles, profileId), installToken) : publicManifest());
  });

  router.get("/u/:installToken/stream/:type/:id.json", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const type = stremioType(stringParam(req.params.type));
    const installToken = stringParam(req.params.installToken);
    const id = stringParam(req.params.id);
    const profileId = installToken ? profiles.profileIdForInstallToken(installToken) : null;
    if (!type || !profileId) return res.json({ streams: [] });

    const customization = manifestCustomization(profiles, profileId);
    const ftpConfigForServer = (serverId: number | null | undefined) =>
      serverId ? profiles.getFtpServerConfig(profileId, serverId) : profiles.getFtpConfig(profileId);
    const folderId = internalFolderId(id);
    if (folderId) {
      const files = mediaRepository.otherCatalogStreams(profileId, folderId, catalogServerScope(profiles, profileId));
      return res.json({
        streams: files.map((file) =>
          streamForMatch({
            baseUrl: config.baseUrl,
            installToken,
            match: file,
            streamDeliveryMode: customization.streamDeliveryMode,
            ftpConfigForServer,
            addonName: customization.addonName,
            streamNameTemplate: customization.streamNameTemplate,
            streamDescriptionTemplate: customization.streamDescriptionTemplate,
          }),
        ),
      });
    }

    const fileId = internalFileId(id);
    if (fileId) {
      const files = mediaRepository.otherCatalogStreams(profileId, fileId, catalogServerScope(profiles, profileId));
      return res.json({
        streams: files.map((file) =>
          streamForMatch({
            baseUrl: config.baseUrl,
            installToken,
            match: file,
            streamDeliveryMode: customization.streamDeliveryMode,
            ftpConfigForServer,
            addonName: customization.addonName,
            streamNameTemplate: customization.streamNameTemplate,
            streamDescriptionTemplate: customization.streamDescriptionTemplate,
          }),
        ),
      });
    }

    try {
      const metadata = await fetchCinemetaMeta(type, cinemetaId(type, id), config.maxOnDemandSearchMs);
      if (!metadata) return res.json({ streams: [] });

      const streams = await resolveStreams({
        baseUrl: config.baseUrl,
        installToken,
        profileId,
        type,
        id,
        metadata,
        mediaRepository,
        streamDeliveryMode: customization.streamDeliveryMode,
        ftpConfigForServer,
        addonName: customization.addonName,
        streamNameTemplate: customization.streamNameTemplate,
        streamDescriptionTemplate: customization.streamDescriptionTemplate,
      });
      res.json({ streams });
    } catch (error) {
      console.error("Stream resolution error:", loggableError(error));
      res.json({ streams: [] });
    }
  });

  router.get(["/u/:installToken/catalog/:type/:catalogId.json", "/u/:installToken/catalog/:type/:catalogId/:extra.json"], async (req, res) => {
    const type = stremioType(stringParam(req.params.type));
    const installToken = stringParam(req.params.installToken);
    const catalogId = stringParam(req.params.catalogId);
    const profileId = installToken ? profiles.profileIdForInstallToken(installToken) : null;
    const customization = profileId ? manifestCustomization(profiles, profileId) : null;
    if (!type || !profileId || !customization?.catalogEnabled || !isCatalogId(type, catalogId)) return res.json({ metas: [] });

    const extra = catalogExtraFrom(stringParam(req.params.extra));
    if (catalogId === "ftp-other") {
      const scope = catalogServerScope(profiles, profileId);
      const items = mediaRepository.otherCatalogItems(profileId, 100, extra.skip, { ...scope, search: extra.search });
      return res.json({ metas: items.map((item) => otherCatalogMeta(item, config.baseUrl)) });
    }

    const catalogKind = catalogKindForId(catalogId);
    if (!catalogKind || !catalogKindEnabled(catalogKind, customization)) return res.json({ metas: [] });
    const metas = mediaRepository.catalogMetas(profileId, catalogKind, 100, extra.skip, {
      ...catalogServerScope(profiles, profileId, catalogKind),
      search: extra.search,
    });
    res.json({ metas });
  });

  router.get("/u/:installToken/meta/:type/:id.json", async (req, res) => {
    const type = stremioType(stringParam(req.params.type));
    const id = stringParam(req.params.id);
    const profileId = profiles.profileIdForInstallToken(stringParam(req.params.installToken));
    const customization = profileId ? manifestCustomization(profiles, profileId) : null;
    if (!type || !profileId || !customization?.catalogEnabled) return res.json({ meta: null });

    const folderId = internalFolderId(id) ?? internalFileId(id);
    if (folderId) {
      const item = mediaRepository.otherCatalogItem(profileId, folderId, catalogServerScope(profiles, profileId));
      return res.json({ meta: item ? otherCatalogMeta(item, config.baseUrl) : null });
    }

    if (!/^tt\d{7,8}$/i.test(id)) return res.json({ meta: null });

    const meta = await tmdbCatalogMeta(
      { mediaKind: type, catalogKind: type, parsedTitle: id, parsedYear: null, imdbId: id },
      effectiveTmdbApiKey(customization, config),
      type,
    );
    res.json({ meta });
  });

  return router;
}

function stremioType(type: string): StremioType | null {
  return type === "movie" || type === "series" ? type : null;
}

function cinemetaId(type: StremioType, id: string): string {
  return type === "series" ? id.split(":")[0] : id;
}

function isCatalogId(type: StremioType, catalogId: string) {
  return (
    (type === "movie" && catalogId === "ftp-movies") ||
    (type === "series" && catalogId === "ftp-series") ||
    (type === "series" && catalogId === "ftp-anime") ||
    (type === "movie" && catalogId === "ftp-other")
  );
}

function catalogKindForId(catalogId: string): TmdbCatalogKind | null {
  if (catalogId === "ftp-movies") return "movie";
  if (catalogId === "ftp-series") return "series";
  if (catalogId === "ftp-anime") return "anime";
  return null;
}

function effectiveTmdbApiKey(customization: AddonCustomization, config: AppConfig) {
  return customization.catalogTmdbApiKey?.trim() || config.tmdbApiKey;
}

function manifestCustomization(profiles: ProfileService, profileId: number): AddonCustomization {
  const base = profiles.getAddonCustomization(profileId);
  const servers = profiles.listFtpServerCatalogSettings(profileId);
  const contentTypes = servers.reduce(
    (acc, server) => ({
      movies: acc.movies || Boolean(server.customization.catalogEnabled && server.customization.catalogContentTypes?.movies),
      series: acc.series || Boolean(server.customization.catalogEnabled && server.customization.catalogContentTypes?.series),
      anime: acc.anime || Boolean(server.customization.catalogEnabled && server.customization.catalogContentTypes?.anime),
      uncategorized:
        acc.uncategorized ||
        Boolean(server.customization.catalogEnabled && server.customization.catalogContentTypes?.uncategorized !== false),
    }),
    { movies: false, series: false, anime: false, uncategorized: false },
  );
  return {
    ...base,
    catalogEnabled: servers.some((server) => server.customization.catalogEnabled && hasAnyEnabledCatalogType(server.customization)),
    catalogTmdbApiKey: base.catalogTmdbApiKey,
    catalogContentTypes: contentTypes,
  };
}

function catalogKindEnabled(catalogKind: TmdbCatalogKind, customization: Pick<AddonCustomization, "catalogContentTypes">) {
  const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
  if (catalogKind === "movie") return contentTypes.movies;
  if (catalogKind === "series") return contentTypes.series;
  return contentTypes.anime;
}

function catalogServerScope(profiles: ProfileService, profileId: number, catalogKind?: TmdbCatalogKind) {
  const servers = profiles.listFtpServerCatalogSettings(profileId);
  const enabledServers = servers.filter((server) => {
    if (!server.customization.catalogEnabled) return false;
    return catalogKind ? catalogKindEnabled(catalogKind, server.customization) : otherCatalogEnabled(server.customization);
  });
  const includeUnenrichedServerIds = catalogKind
    ? []
    : enabledServers.filter((server) => !hasAnyTypedCatalogContentType(server.customization)).map((server) => server.id);
  const defaultServerId = servers[0]?.id;
  return {
    ftpServerIds: enabledServers.map((server) => server.id),
    includeLegacyNullServer: Boolean(defaultServerId && enabledServers.some((server) => server.id === defaultServerId)),
    includeUnenrichedServerIds,
  };
}

function otherCatalogEnabled(customization: Pick<AddonCustomization, "catalogContentTypes">) {
  const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
  return contentTypes.uncategorized !== false;
}

function hasAnyTypedCatalogContentType(customization: Pick<AddonCustomization, "catalogContentTypes">) {
  const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
  return Boolean(contentTypes.movies || contentTypes.series || contentTypes.anime);
}

function hasAnyEnabledCatalogType(customization: Pick<AddonCustomization, "catalogContentTypes">) {
  return hasAnyTypedCatalogContentType(customization) || otherCatalogEnabled(customization);
}

function catalogExtraFrom(extra: string | undefined) {
  const params = new URLSearchParams((extra ?? "").replace(/^\?/, ""));
  const raw = params.get("skip");
  const search = params.get("search")?.trim() || undefined;
  return {
    skip: raw && /^\d+$/.test(raw) ? Number(raw) : 0,
    search,
  };
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value || "";
}

function internalFileId(id: string): number | null {
  const match = id.match(/^ftp:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function internalFolderId(id: string): number | null {
  const match = id.match(/^ftp-folder:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function loggableError(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.stack || error.message);
  return redactSecrets(String(error));
}

function otherCatalogMeta(item: {
  id: number;
  folderName: string;
  parsedYear: number | null;
  fileCount: number;
  serverCount: number;
}, baseUrl: string) {
  return {
    id: `ftp-folder:${item.id}`,
    type: "movie",
    name: item.folderName,
    description: `${item.fileCount} ${item.fileCount === 1 ? "file" : "files"} across ${item.serverCount} ${item.serverCount === 1 ? "server" : "servers"}`,
    poster: defaultFolderPosterUrl(baseUrl),
    releaseInfo: item.parsedYear ? String(item.parsedYear) : undefined,
  };
}

function defaultFolderPosterUrl(baseUrl: string) {
  return `${baseUrl}/assets/default-folder-poster.png`;
}
