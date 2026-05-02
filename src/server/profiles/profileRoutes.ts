import { Router, type RequestHandler } from "express";
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
  const rateLimitProfiles = profileRateLimiter(config.profileRateLimitWindowMs, config.profileRateLimitMax);

  router.post("/profile", rateLimitProfiles, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid profile request" });
    try {
      const created = await service.createProfile(parsed.data.browserUid, parsed.data.passphrase);
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

  router.post("/profile/unlock", rateLimitProfiles, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid unlock request" });
    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.json(unlocked);
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  return router;
}

function profileRateLimiter(windowMs: number, maxAttempts: number): RequestHandler {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const current = attempts.get(key);
    const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    attempts.set(key, bucket);

    if (bucket.count > maxAttempts) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many profile attempts" });
    }

    next();
  };
}
