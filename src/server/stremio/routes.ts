import { Router } from "express";
import type { AppConfig } from "../config.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import { fetchCinemetaMeta } from "../metadata/cinemetaClient.js";
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
    res.json(profileId ? tokenManifest() : publicManifest());
  });

  router.get("/u/:installToken/stream/:type/:id.json", async (req, res) => {
    const type = stremioType(req.params.type);
    const profileId = profiles.profileIdForInstallToken(req.params.installToken);
    if (!type || !profileId) return res.json({ streams: [] });

    try {
      const metadata = await fetchCinemetaMeta(type, cinemetaId(type, req.params.id), config.maxOnDemandSearchMs);
      if (!metadata) return res.json({ streams: [] });

      const streams = await resolveStreams({
        baseUrl: config.baseUrl,
        installToken: req.params.installToken,
        profileId,
        type,
        id: req.params.id,
        metadata,
        mediaRepository,
      });
      res.json({ streams });
    } catch {
      res.json({ streams: [] });
    }
  });

  return router;
}

function stremioType(type: string): StremioType | null {
  return type === "movie" || type === "series" ? type : null;
}

function cinemetaId(type: StremioType, id: string): string {
  return type === "series" ? id.split(":")[0] : id;
}
