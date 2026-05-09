import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import { MediaRepository } from "../media/mediaRepository.js";
import type { ScanQueue } from "../scanner/scanQueue.js";
import { DuplicateProfileError, ProfileService, type FtpServer } from "./profileService.js";

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
const serverIdSchema = createSchema.extend({ serverId: z.number().int().positive() });
const MAX_STREAM_FORMATTER_TEMPLATE_LENGTH = 50000;
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
      uncategorized: z.boolean().default(true),
    })
    .default({ movies: true, series: true, anime: false, uncategorized: true }),
  libraryLayout: z.enum(["auto", "folders", "flat"]).default("auto"),
  streamDeliveryMode: z.enum(["proxy", "direct"]).default("proxy"),
  streamNameTemplate: z.string().trim().max(MAX_STREAM_FORMATTER_TEMPLATE_LENGTH).optional(),
  streamDescriptionTemplate: z.string().trim().max(MAX_STREAM_FORMATTER_TEMPLATE_LENGTH).optional(),
});
const saveCustomizationSchema = createSchema.extend({ customization: customizationSchema });
const saveServerSchema = serverIdSchema.extend({
  name: z.string().trim().min(1).max(80),
  ftpConfig: ftpConfigSchema,
  customization: customizationSchema.omit({
    addonName: true,
    addonLogoUrl: true,
    addonDescription: true,
    catalogTmdbApiKey: true,
    streamNameTemplate: true,
    streamDescriptionTemplate: true,
  }),
});

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

  router.post("/profile/ftp/load", async (req, res) => {
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

  router.post("/profile/servers/load", async (req, res) => {
    const parsed = authenticatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid server load request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.json({
        customization: service.getAddonCustomization(unlocked.profileId),
        servers: serverPayloads(service, scanQueue, unlocked.profileId),
        globalStats: globalStats(service, scanQueue, unlocked.profileId),
      });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/servers", rateLimitProfiles, async (req, res) => {
    const parsed = authenticatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid server create request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const server = service.createFtpServer(unlocked.profileId);
      res.status(201).json({
        server: serverPayload(service, scanQueue, server),
        globalStats: globalStats(service, scanQueue, unlocked.profileId),
      });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/servers/save", rateLimitProfiles, async (req, res) => {
    const parsed = saveServerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid server save request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const existingConfig = service.getFtpServerConfig(unlocked.profileId, parsed.data.serverId);
      const ftpConfig = ftpConfigWithStoredPassword(parsed.data.ftpConfig, existingConfig);
      if (!ftpConfig.password) return res.status(400).json({ error: "FTP password is required" });
      const server = service.saveFtpServer(unlocked.profileId, parsed.data.serverId, {
        name: parsed.data.name,
        ftpConfig,
        customization: parsed.data.customization,
      });
      res.json({
        server: serverPayload(service, scanQueue, server),
        globalStats: globalStats(service, scanQueue, unlocked.profileId),
      });
    } catch (error) {
      res.status(error instanceof Error && error.message.includes("FTP password") ? 400 : 401).json({
        error: error instanceof Error ? error.message : "Invalid passphrase",
      });
    }
  });

  router.post("/profile/servers/delete", rateLimitProfiles, async (req, res) => {
    const parsed = serverIdSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid server delete request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      service.deleteFtpServer(unlocked.profileId, parsed.data.serverId);
      res.json({
        servers: serverPayloads(service, scanQueue, unlocked.profileId),
        globalStats: globalStats(service, scanQueue, unlocked.profileId),
      });
    } catch (error) {
      res.status(error instanceof Error && error.message.includes("At least one") ? 400 : 401).json({
        error: error instanceof Error ? error.message : "Invalid passphrase",
      });
    }
  });

  router.post("/profile/servers/test", rateLimitProfiles, async (req, res) => {
    const parsed = serverIdSchema.extend({ ftpConfig: ftpConfigSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid server test request" });

    let unlocked: { profileId: number };
    try {
      unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
    } catch {
      return res.status(401).json({ error: "Invalid passphrase" });
    }

    const existingConfig = service.getFtpServerConfig(unlocked.profileId, parsed.data.serverId);
    const ftpConfig = ftpConfigWithStoredPassword(parsed.data.ftpConfig, existingConfig);
    if (!ftpConfig.password) return res.status(400).json({ error: "FTP password is required" });

    try {
      const client = await ftpClientFactory(ftpConfig);
      try {
        for (const root of ftpConfig.roots) await client.list(root);
      } finally {
        await client.close();
      }
      const connectionStatus = { lastTestedAt: new Date().toISOString(), ok: true };
      service.saveFtpServerConnectionStatus(unlocked.profileId, parsed.data.serverId, connectionStatus);
      res.json({ ok: true, connectionStatus });
    } catch (error) {
      service.saveFtpServerConnectionStatus(unlocked.profileId, parsed.data.serverId, {
        lastTestedAt: new Date().toISOString(),
        ok: false,
      });
      res.status(400).json({ error: ftpErrorMessage(error, "Unable to connect to FTP server") });
    }
  });

  router.post("/profile/customization/load", async (req, res) => {
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
    const parsed = authenticatedSchema
      .extend({ serverId: z.number().int().positive().optional(), all: z.boolean().optional(), force: z.boolean().optional() })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid rescan request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const scanOptions = parsed.data.force ? { force: true } : undefined;
      if (parsed.data.all) {
        const servers = service.listFtpServers(unlocked.profileId).filter((server) => server.ftpConfig);
        if (!servers.length) return res.status(400).json({ error: "FTP settings are not configured" });
        const scanStatuses = servers.map((server) => scanQueue.enqueueProfileScan(unlocked.profileId, "manual", server.id, scanOptions));
        return res.json({
          scanStatus: scanStatuses[0],
          scanStatuses,
          servers: serverPayloads(service, scanQueue, unlocked.profileId),
          globalStats: globalStats(service, scanQueue, unlocked.profileId),
        });
      }
      const serverId = parsed.data.serverId ?? service.defaultFtpServerId(unlocked.profileId);
      const ftpConfig = service.getFtpServerConfig(unlocked.profileId, serverId);
      if (!ftpConfig) return res.status(400).json({ error: "FTP settings are not configured" });
      res.json({ scanStatus: scanQueue.enqueueProfileScan(unlocked.profileId, "manual", serverId, scanOptions) });
    } catch (error) {
      res.status(400).json({ error: ftpErrorMessage(error, "Unable to refresh FTP index") });
    }
  });

  router.post("/profile/index/cancel", rateLimitProfiles, async (req, res) => {
    const parsed = authenticatedSchema.extend({ serverId: z.number().int().positive().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid scan cancel request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      const serverId = parsed.data.serverId ?? service.defaultFtpServerId(unlocked.profileId);
      res.json({ scanStatus: scanQueue.cancelServerScan(unlocked.profileId, serverId) });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/index/status", async (req, res) => {
    const parsed = authenticatedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid scan status request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      res.json({
        indexStatus: service.getIndexStatus(unlocked.profileId),
        scanStatus: scanQueue.getProfileScanStatus(unlocked.profileId),
        scanSchedule: service.getScanSchedule(unlocked.profileId),
        servers: serverPayloads(service, scanQueue, unlocked.profileId),
        globalStats: globalStats(service, scanQueue, unlocked.profileId),
      });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  router.post("/profile/index/schedule", rateLimitProfiles, async (req, res) => {
    const parsed = saveScanScheduleSchema.extend({ serverId: z.number().int().positive().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid scan schedule request" });

    try {
      const unlocked = await service.unlockProfile(parsed.data.browserUid, parsed.data.passphrase);
      if (parsed.data.intervalMinutes > 0 && parsed.data.intervalMinutes < config.scanMinRescanIntervalMinutes) {
        return res.status(400).json({
          error: `Rescan frequency must be at least ${config.scanMinRescanIntervalMinutes} minutes.`,
        });
      }
      const serverId = parsed.data.serverId ?? service.defaultFtpServerId(unlocked.profileId);
      const nextScheduledScanAt =
        parsed.data.intervalMinutes > 0 ? new Date(Date.now() + parsed.data.intervalMinutes * 60_000).toISOString() : null;
      service.saveFtpServerScanSchedule(unlocked.profileId, serverId, {
        intervalMinutes: parsed.data.intervalMinutes,
        nextScheduledScanAt,
      });
      res.json({ scanSchedule: service.getFtpServerScanSchedule(unlocked.profileId, serverId) });
    } catch {
      res.status(401).json({ error: "Invalid passphrase" });
    }
  });

  return router;
}

function serverPayloads(service: ProfileService, scanQueue: ScanQueue, profileId: number) {
  const servers = service.listFtpServers(profileId);
  return servers.map((server) => serverPayload(service, scanQueue, server));
}

function serverPayload(_service: ProfileService, scanQueue: ScanQueue, server: FtpServer) {
  const ftpConfig = server.ftpConfig;
  return {
    id: server.id,
    name: server.name,
    ftpConfig: ftpConfig
      ? {
          host: ftpConfig.host,
          port: ftpConfig.port,
          username: ftpConfig.username,
          password: "",
          passwordConfigured: Boolean(ftpConfig.password),
          tlsMode: ftpConfig.tlsMode,
          allowInvalidCertificate: ftpConfig.allowInvalidCertificate,
          roots: ftpConfig.roots,
        }
      : null,
    customization: server.customization,
    indexStatus: server.indexStatus,
    scanStatus: scanQueue.getServerScanStatus(server.profileId, server.id),
    scanSchedule: server.scanSchedule,
    connectionStatus: server.connectionStatus,
    pendingScanAfter: server.pendingScanAfter,
  };
}

function globalStats(service: ProfileService, scanQueue: ScanQueue, profileId: number) {
  const servers = service.listFtpServers(profileId);
  const counts = new MediaRepository(service.database).aggregateCountsForProfile(profileId);
  const statuses = servers.map((server) => scanQueue.getServerScanStatus(profileId, server.id));
  const activeScans = statuses.filter((status) => status.status === "running").length;
  const queuedScans = statuses.filter((status) => status.status === "queued").length;
  const pendingScans = queuedScans + servers.filter((server) => server.pendingScanAfter).length;
  const lastCompletedScanAt =
    servers
      .map((server) => server.indexStatus.lastScanAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  return {
    totalItems: counts.total,
    movies: counts.movies,
    series: counts.series,
    anime: counts.anime,
    uncategorized: counts.uncategorized,
    servers: servers.length,
    activeScans,
    pendingScans,
    lastCompletedScanAt,
    lastCompletedScanNewItems: scanQueue.latestCompletedScanNewItems(profileId, lastCompletedScanAt),
    status: activeScans > 0 || pendingScans > 0 ? "working" : counts.total > 0 ? "ready" : "idle",
  };
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
