import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { crawlProfileRoot } from "../ftp/crawler.js";
import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import { DuplicateProfileError, ProfileService } from "./profileService.js";

const createSchema = z.object({
  browserUid: z.string().min(8),
  passphrase: z.string().min(8),
});

const ftpConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string(),
  tlsMode: z.enum(["none", "explicit", "implicit"]),
  allowInvalidCertificate: z.boolean(),
  roots: z.array(z.string().trim().min(1)).min(1),
});

const authenticatedSchema = createSchema;
const saveFtpSchema = createSchema.extend({ ftpConfig: ftpConfigSchema });
const customizationSchema = z.object({
  addonName: z.string().trim().min(1).max(80),
  addonLogoUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => !value || /^https?:\/\//i.test(value), "Logo URL must start with http:// or https://"),
});
const saveCustomizationSchema = createSchema.extend({ customization: customizationSchema });

function urls(baseUrl: string, token: string) {
  const manifestUrl = `${baseUrl}/u/${token}/manifest.json`;
  return {
    manifestUrl,
    stremioInstallUrl: manifestUrl.replace(/^https?:\/\//, "stremio://"),
  };
}

export function profileRoutes(
  config: AppConfig,
  service: ProfileService,
  mediaRepository: MediaRepository,
  ftpClientFactory: FtpClientFactory,
) {
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
      const issued = service.issueInstallToken(unlocked.profileId);
      res.json({
        ...unlocked,
        ...urls(config.baseUrl, issued.installUrlToken),
      });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/ftp/test", rateLimitProfiles, async (req, res) => {
    const parsed = saveFtpSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid FTP settings request" });

    let unlocked: { profileId: number };
    try {
      unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
    } catch {
      return res.status(401).json({ error: "Invalid passphrase" });
    }

    const existingConfig = service.getFtpConfig(unlocked.profileId);
    const ftpConfig = ftpConfigWithStoredPassword(parsed.data.ftpConfig, existingConfig);
    if (!ftpConfig.password) return res.status(400).json({ error: "FTP password is required" });

    try {
      const client = await ftpClientFactory(ftpConfig);
      try {
        for (const root of ftpConfig.roots) {
          await client.list(root);
        }
      } finally {
        await client.close();
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: ftpErrorMessage(error, "Unable to connect to FTP server") });
    }
  });

  router.post("/profile/ftp", rateLimitProfiles, async (req, res) => {
    const parsed = saveFtpSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid FTP settings request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const existingConfig = service.getFtpConfig(unlocked.profileId);
      const ftpConfig = ftpConfigWithStoredPassword(parsed.data.ftpConfig, existingConfig);
      if (!ftpConfig.password) return res.status(400).json({ error: "FTP password is required" });
      service.saveFtpConfig(unlocked.profileId, ftpConfig);
      res.json({ ok: true });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/ftp/load", rateLimitProfiles, async (req, res) => {
    const parsed = authenticatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid FTP settings request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const ftpConfig = service.getFtpConfig(unlocked.profileId);
      if (!ftpConfig) return res.status(404).json({ error: "FTP settings are not configured" });
      res.json({
        ftpConfig: {
          host: ftpConfig.host,
          port: ftpConfig.port,
          username: ftpConfig.username,
          password: ftpConfig.password,
          passwordConfigured: Boolean(ftpConfig.password),
          tlsMode: ftpConfig.tlsMode,
          allowInvalidCertificate: ftpConfig.allowInvalidCertificate,
          roots: ftpConfig.roots,
        },
      });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/customization/load", rateLimitProfiles, async (req, res) => {
    const parsed = authenticatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid customization request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.json({ customization: service.getAddonCustomization(unlocked.profileId) });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/customization", rateLimitProfiles, async (req, res) => {
    const parsed = saveCustomizationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid customization request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      service.saveAddonCustomization(unlocked.profileId, parsed.data.customization);
      res.json({ ok: true });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/index/rescan", rateLimitProfiles, async (req, res) => {
    const parsed = authenticatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid rescan request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const ftpConfig = service.getFtpConfig(unlocked.profileId);
      if (!ftpConfig) return res.status(400).json({ error: "FTP settings are not configured" });

      let filesSeen = 0;
      for (const rootPath of ftpConfig.roots) {
        const result = await crawlProfileRoot({
          profileId: unlocked.profileId,
          rootPath,
          ftpConfig,
          factory: ftpClientFactory,
          repo: mediaRepository,
        });
        filesSeen += result.filesSeen;
      }
      res.json({ filesSeen });
    } catch (error) {
      res.status(400).json({ error: ftpErrorMessage(error, "Unable to refresh FTP index") });
    }
  });

  return router;
}

function ftpErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error) || !error.message.trim()) return fallback;
  return `FTP error: ${error.message}`;
}

function ftpConfigWithStoredPassword(
  incoming: z.infer<typeof ftpConfigSchema>,
  existing: z.infer<typeof ftpConfigSchema> | null,
) {
  return {
    ...incoming,
    password: incoming.password || existing?.password || "",
  };
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
