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
    const profileId = profiles.profileIdForInstallToken(req.params.installToken);
    res.json(profileId ? tokenManifest(profiles.getAddonCustomization(profileId)) : publicManifest());
  });

  router.get("/u/:installToken/stream/:type/:id.json", async (req, res) => {
    const type = stremioType(stringParam(req.params.type));
    const installToken = stringParam(req.params.installToken);
    const id = stringParam(req.params.id);
    const profileId = installToken ? profiles.profileIdForInstallToken(installToken) : null;
    if (!type || !profileId) return res.json({ streams: [] });

    const fileId = internalFileId(id);
    const customization = profiles.getAddonCustomization(profileId);
    const ftpConfig = profiles.getFtpConfig(profileId);
    if (fileId) {
      const files = mediaRepository.otherCatalogStreams(profileId, fileId);
      return res.json({
        streams: files.map((file) =>
          streamForMatch({
            baseUrl: config.baseUrl,
            installToken,
            match: file,
            streamDeliveryMode: customization.streamDeliveryMode,
            ftpConfig,
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
        ftpConfig,
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
    const customization = profileId ? profiles.getAddonCustomization(profileId) : null;
    if (!type || !profileId || !customization?.catalogEnabled || !isCatalogId(type, catalogId)) return res.json({ metas: [] });
    const tmdbApiKey = effectiveTmdbApiKey(customization, config);

    const skip = skipFromExtra(stringParam(req.params.extra));
    if (catalogId === "ftp-other") {
      const items = mediaRepository.otherCatalogItems(profileId, 100, skip);
      const metas = (
        await Promise.all(
          items.map(async (item) => {
            return (await resolvesInEnabledCatalog(item, tmdbApiKey, customization)) ? null : otherCatalogMeta(item);
          }),
        )
      ).filter(Boolean);
      return res.json({ metas });
    }

    const catalogKind = catalogKindForId(catalogId);
    if (!catalogKind || !catalogKindEnabled(catalogKind, customization)) return res.json({ metas: [] });
    const items = mediaRepository.catalogItems(profileId, catalogKind, 100, skip);
    const metas = (await Promise.all(items.map((item) => tmdbCatalogMeta(item, tmdbApiKey, catalogKind)))).filter(Boolean);
    res.json({ metas });
  });

  router.get("/u/:installToken/meta/:type/:id.json", async (req, res) => {
    const type = stremioType(stringParam(req.params.type));
    const id = stringParam(req.params.id);
    const profileId = profiles.profileIdForInstallToken(stringParam(req.params.installToken));
    const customization = profileId ? profiles.getAddonCustomization(profileId) : null;
    if (!type || !profileId || !customization?.catalogEnabled) return res.json({ meta: null });

    const fileId = internalFileId(id);
    if (fileId) {
      const item = mediaRepository.otherCatalogItem(profileId, fileId);
      return res.json({ meta: item ? otherCatalogMeta(item) : null });
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

function catalogKindEnabled(catalogKind: TmdbCatalogKind, customization: AddonCustomization) {
  const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
  if (catalogKind === "movie") return contentTypes.movies;
  if (catalogKind === "series") return contentTypes.series;
  return contentTypes.anime;
}

async function resolvesInEnabledCatalog(
  item: { mediaKind: "movie" | "series"; parsedTitle: string; parsedYear: number | null; imdbId?: string | null },
  tmdbApiKey: string | null,
  customization: AddonCustomization,
) {
  for (const catalogKind of ["movie", "series", "anime"] as const) {
    if (!catalogKindEnabled(catalogKind, customization)) continue;
    const meta = await tmdbCatalogMeta(
      {
        mediaKind: catalogKind === "movie" ? "movie" : "series",
        catalogKind,
        parsedTitle: item.parsedTitle,
        parsedYear: item.parsedYear,
        imdbId: item.imdbId ?? null,
      },
      tmdbApiKey,
      catalogKind,
    );
    if (meta) return true;
  }
  return false;
}

function skipFromExtra(extra: string | undefined) {
  if (!extra) return 0;
  const params = new URLSearchParams(extra.replace(/^\?/, ""));
  const raw = params.get("skip");
  return raw && /^\d+$/.test(raw) ? Number(raw) : 0;
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value || "";
}

function internalFileId(id: string): number | null {
  const match = id.match(/^ftp:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function loggableError(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.stack || error.message);
  return redactSecrets(String(error));
}

function otherCatalogMeta(item: {
  id: number;
  filename: string;
  parsedTitle: string;
  parsedYear: number | null;
}) {
  return {
    id: `ftp:${item.id}`,
    type: "movie",
    name: titleCase(item.parsedTitle),
    description: item.filename,
    releaseInfo: item.parsedYear ? String(item.parsedYear) : undefined,
  };
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
