import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import type { ScanQueue } from "../scanner/scanQueue.js";
import { DEFAULT_ADDON_CUSTOMIZATION, DuplicateProfileError, ProfileService } from "./profileService.js";

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
const saveScanScheduleSchema = createSchema.extend({
  intervalMinutes: z.number().int().min(0).max(10080),
});
const customizationSchema = z.object({
  addonName: z.string().trim().min(1).max(80),
  addonLogoUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => !value || /^https?:\/\//i.test(value), "Logo URL must start with http:// or https://"),
  addonDescription: z.string().trim().min(1).max(260),
  catalogEnabled: z.boolean().default(false),
  catalogTmdbApiKey: z.string().trim().max(128).default(""),
  catalogContentTypes: z
    .object({
      movies: z.boolean().default(true),
      series: z.boolean().default(true),
      anime: z.boolean().default(false),
    })
    .default(DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!),
  libraryLayout: z.enum(["auto", "folders", "flat"]).default("auto"),
  streamDeliveryMode: z.enum(["proxy", "direct"]).default("proxy"),
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
  ftpClientFactory: FtpClientFactory,
  scanQueue: ScanQueue,
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
      const connectionStatus = { lastTestedAt: new Date().toISOString(), ok: true };
      service.saveConnectionStatus(unlocked.profileId, connectionStatus);
      res.json({ ok: true, connectionStatus });
    } catch (error) {
      service.saveConnectionStatus(unlocked.profileId, { lastTestedAt: new Date().toISOString(), ok: false });
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
          password: "",
          passwordConfigured: Boolean(ftpConfig.password),
          tlsMode: ftpConfig.tlsMode,
          allowInvalidCertificate: ftpConfig.allowInvalidCertificate,
          roots: ftpConfig.roots,
        },
        indexStatus: service.getIndexStatus(unlocked.profileId),
        scanStatus: scanQueue.getProfileScanStatus(unlocked.profileId),
        scanSchedule: service.getScanSchedule(unlocked.profileId),
        connectionStatus: service.getConnectionStatus(unlocked.profileId),
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
      res.json({ scanStatus: scanQueue.enqueueProfileScan(unlocked.profileId, "manual") });
    } catch (error) {
      res.status(400).json({ error: ftpErrorMessage(error, "Unable to refresh FTP index") });
    }
  });

  router.post("/profile/index/status", rateLimitProfiles, async (req, res) => {
    const parsed = authenticatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid scan status request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.json({
        indexStatus: service.getIndexStatus(unlocked.profileId),
        scanStatus: scanQueue.getProfileScanStatus(unlocked.profileId),
        scanSchedule: service.getScanSchedule(unlocked.profileId),
      });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/index/schedule", rateLimitProfiles, async (req, res) => {
    const parsed = saveScanScheduleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid scan schedule request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const nextScheduledScanAt =
        parsed.data.intervalMinutes > 0 ? new Date(Date.now() + parsed.data.intervalMinutes * 60_000).toISOString() : null;
      service.saveScanSchedule(unlocked.profileId, {
        intervalMinutes: parsed.data.intervalMinutes,
        nextScheduledScanAt,
      });
      res.json({ scanSchedule: service.getScanSchedule(unlocked.profileId) });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
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
