import { Router } from "express";
import type { AppConfig } from "../config.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import { fetchCinemetaMeta } from "../metadata/cinemetaClient.js";
import { tmdbCatalogMeta } from "../metadata/tmdbClient.js";
import type { ProfileService } from "../profiles/profileService.js";
import { publicManifest, tokenManifest } from "./manifest.js";
import { resolveStreams } from "./streamResolver.js";

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
    if (fileId) {
      const file = mediaRepository.getFileForProfile(profileId, fileId);
      return res.json({ streams: file ? [directFileStream(config.baseUrl, installToken, file)] : [] });
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
      });
      res.json({ streams });
    } catch {
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

    const skip = skipFromExtra(stringParam(req.params.extra));
    if (catalogId === "ftp-other") {
      const items = mediaRepository.otherCatalogItems(profileId, 100, skip);
      const metas = (
        await Promise.all(
          items.map(async (item) => {
            const tmdbMeta = await tmdbCatalogMeta(
              { mediaKind: item.mediaKind, parsedTitle: item.parsedTitle, parsedYear: item.parsedYear, imdbId: null },
              config.tmdbApiKey,
            );
            return tmdbMeta ? null : otherCatalogMeta(item);
          }),
        )
      ).filter(Boolean);
      return res.json({ metas });
    }

    const items = mediaRepository.catalogItems(profileId, type, 100, skip);
    const metas = (await Promise.all(items.map((item) => tmdbCatalogMeta(item, config.tmdbApiKey)))).filter(Boolean);
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
      { mediaKind: type, parsedTitle: id, parsedYear: null, imdbId: id },
      config.tmdbApiKey,
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
    (type === "movie" && catalogId === "ftp-other")
  );
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

function directFileStream(
  baseUrl: string,
  installToken: string,
  file: { id: number; filename: string; quality: string | null; sizeBytes: number | null },
) {
  return {
    name: `FTP ${file.quality ?? "Source"}`,
    description: `${file.filename}${file.sizeBytes ? `\n${formatBytes(file.sizeBytes)}` : ""}`,
    url: `${baseUrl.replace(/\/+$/, "")}/proxy/${encodeURIComponent(installToken)}/${encodeURIComponent(String(file.id))}`,
    behaviorHints: {
      notWebReady: true,
      filename: file.filename,
      ...(file.sizeBytes ? { videoSize: file.sizeBytes } : {}),
    },
  };
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
