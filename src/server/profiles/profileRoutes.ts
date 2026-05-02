import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { DuplicateProfileError, ProfileService } from "./profileService.js";

const createSchema = z.object({
  browserUid: z.string().min(8),
  passphrase: z.string().min(8),
});

function urls(baseUrl: string, token: string) {
  const manifestUrl = `${baseUrl}/u/${token}/manifest.json`;
  return {
    manifestUrl,
    stremioInstallUrl: manifestUrl.replace(/^https?:\/\//, "stremio://"),
  };
}

export function profileRoutes(config: AppConfig, service: ProfileService) {
  const router = Router();

  router.post("/profile", (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid profile request" });
    try {
      const created = service.createProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.status(201).json({
        profileId: created.profileId,
        recoveryUid: parsed.data.browserUid,
        ...urls(config.baseUrl, created.installUrlToken),
      });
    } catch (error) {
      if (error instanceof DuplicateProfileError) return res.status(409).json({ error: "Profile already exists" });
      throw error;
    }
  });

  router.post("/profile/unlock", (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid unlock request" });
    try {
      const unlocked = service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.json(unlocked);
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  return router;
}
