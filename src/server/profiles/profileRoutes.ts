import { Router, type Request, type RequestHandler, type Response } from "express";
import { isIP } from "node:net";
import { z } from "zod";
import { MAX_STREAM_FORMATTER_TEMPLATE_LENGTH } from "../../shared/streamFormatter.js";
import type { AppConfig } from "../config.js";
import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import { countryCodeFromRequest } from "../http/requestMetadata.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { ScanQueue } from "../scanner/scanQueue.js";
import {
  DuplicateProfileError,
  InvalidPassphraseError,
  ProfileNotFoundError,
  ProfileRequestError,
  ProfileService,
  SharedIndexMasterDeleteError,
  SharedIndexMasterIdentityChangeError,
  SharedIndexUnlinkRequiredError,
  type FtpServer,
} from "./profileService.js";

const createSchema = z.object({
  browserUid: z.string().min(8),
  passphrase: z.string().min(8),
});

const ftpConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string(),
  password: z.string(),
  tlsMode: z.enum(["none", "explicit", "implicit"]),
  allowInvalidCertificate: z.boolean(),
  roots: z.array(z.string().trim().min(1)).min(1),
});

export function isDraftFtpConfig(ftpConfig: { username?: string | null; password?: string | null }) {
  return !ftpConfig.username?.trim() || !ftpConfig.password;
}

const authenticatedSchema = createSchema;
const saveFtpSchema = createSchema.extend({ ftpConfig: ftpConfigSchema });
const serverIdSchema = createSchema.extend({ serverId: z.number().int().positive() });
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
  catalogSort: z.enum(["alphabetical", "newest"]).optional(),
  catalogTmdbApiKey: z.string().trim().max(128).default(""),
  combineUncategorizedCatalogs: z.boolean().default(false),
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
    combineUncategorizedCatalogs: true,
    streamNameTemplate: true,
    streamDescriptionTemplate: true,
  }),
  sharedIndexKey: z.string().trim().min(1).max(256).optional(),
  unlinkSharedIndex: z.boolean().optional(),
});

type AuthenticatedBody = z.infer<typeof authenticatedSchema>;
type ProfileContext<T> = { res: Response; data: T; profileId: number };

export function installUrls(baseUrl: string, token: string) {
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
  mediaRepository: MediaRepository,
  failedUnlocks: FailedUnlockLimiter = createFailedUnlockLimiter(config),
) {
  const router = Router();
  const rateLimitProfiles = profileRateLimiter(config.profileRateLimitWindowMs, config.profileRateLimitMax);
  const isAdminBrowserUid = (browserUid: string) => service.isAdminBrowserUid(browserUid, config.adminBrowserUids);
  const enforceDeliveryModeFor = <T extends { streamDeliveryMode?: "proxy" | "direct" }>(browserUid: string, value: T): T =>
    config.proxyStreamsDisabled && !isAdminBrowserUid(browserUid) ? { ...value, streamDeliveryMode: "direct" } : value;
  const withProfile = <T extends AuthenticatedBody>(
    schema: z.ZodType<T>,
    invalidMessage: string,
    handler: (context: ProfileContext<T>) => unknown,
    options: { recordCountry?: boolean } = {},
  ): RequestHandler =>
    async (req, res) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: invalidMessage });
      const profileId = await unlockWithFailureLimit(
        service,
        failedUnlocks,
        req,
        res,
        parsed.data,
        options.recordCountry ? countryCodeFromRequest(req) : null,
      );
      if (profileId === null) return;
      try {
        await handler({ res, data: parsed.data, profileId });
      } catch (error) {
        if (res.headersSent) throw error;
        if (error instanceof ProfileNotFoundError) return res.status(404).json({ error: "Profile or FTP server not found" });
        if (error instanceof ProfileRequestError) return res.status(400).json({ error: error.message });
        throw error;
      }
    };

  router.post("/profile", rateLimitProfiles, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid profile request" });
    try {
      const created = await service.createProfile(parsed.data.browserUid, parsed.data.passphrase, countryCodeFromRequest(req));
      res.status(201).json({
        profileId: created.profileId,
        recoveryUid: parsed.data.browserUid,
        ...installUrls(config.baseUrl, created.installUrlToken),
      });
    } catch (error) {
      if (error instanceof DuplicateProfileError) return res.status(409).json({ error: "Profile already exists" });
      throw error;
    }
  });

  router.post(
    "/profile/unlock",
    rateLimitProfiles,
    withProfile(
      createSchema,
      "Invalid unlock request",
      ({ res, profileId }) => {
        const issued = service.issueInstallToken(profileId);
        res.json({
          profileId,
          ...installUrls(config.baseUrl, issued.installUrlToken),
        });
      },
      { recordCountry: true },
    ),
  );

  router.post(
    "/profile/ftp/test",
    rateLimitProfiles,
    withProfile(saveFtpSchema, "Invalid FTP settings request", async ({ res, data, profileId }) => {
      const existingConfig = service.getFtpConfig(profileId);
      const ftpConfig = ftpConfigWithStoredPassword(data.ftpConfig, existingConfig);
      if (isDraftFtpConfig(ftpConfig)) return res.status(400).json({ error: "FTP username and password are required to test" });

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
        service.saveConnectionStatus(profileId, connectionStatus);
        res.json({ ok: true, connectionStatus });
      } catch (error) {
        service.saveConnectionStatus(profileId, { lastTestedAt: new Date().toISOString(), ok: false });
        res.status(400).json({ error: ftpErrorMessage(error, "Unable to connect to FTP server") });
      }
    }),
  );

  router.post(
    "/profile/ftp",
    rateLimitProfiles,
    withProfile(saveFtpSchema, "Invalid FTP settings request", ({ res, data, profileId }) => {
      const existingConfig = service.getFtpConfig(profileId);
      const ftpConfig = ftpConfigWithStoredPassword(data.ftpConfig, existingConfig);
      service.saveFtpConfig(profileId, ftpConfig);
      res.json({ ok: true, draft: isDraftFtpConfig(ftpConfig) });
    }),
  );

  router.post(
    "/profile/ftp/load",
    withProfile(authenticatedSchema, "Invalid FTP settings request", ({ res, profileId }) => {
      const ftpConfig = service.getFtpConfig(profileId);
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
        indexStatus: service.getIndexStatus(profileId),
        scanStatus: scanQueue.getProfileScanStatus(profileId),
        scanSchedule: service.getScanSchedule(profileId),
        connectionStatus: service.getConnectionStatus(profileId),
      });
    }),
  );

  router.post(
    "/profile/servers/load",
    withProfile(authenticatedSchema, "Invalid server load request", ({ res, profileId }) => {
      res.json({
        customization: service.getAddonCustomization(profileId),
        ...serversWithStats(service, scanQueue, mediaRepository, profileId),
      });
    }),
  );

  router.post(
    "/profile/servers",
    rateLimitProfiles,
    withProfile(authenticatedSchema, "Invalid server create request", ({ res, data, profileId }) => {
      if (config.maxFtpServersPerProfile > 0 && !isAdminBrowserUid(data.browserUid)) {
        const existing = service.listFtpServers(profileId).length;
        if (existing >= config.maxFtpServersPerProfile) {
          return res.status(400).json({
            error: `This server allows at most ${config.maxFtpServersPerProfile} FTP ${config.maxFtpServersPerProfile === 1 ? "server" : "servers"} per profile.`,
          });
        }
      }
      const server = service.createFtpServer(profileId);
      res.status(201).json({
        server: serverPayload(service, scanQueue, server),
        globalStats: globalStats(service, scanQueue, mediaRepository, profileId),
      });
    }),
  );

  router.post(
    "/profile/servers/save",
    rateLimitProfiles,
    withProfile(saveServerSchema, "Invalid server save request", ({ res, data, profileId }) => {
      const existingConfig = service.getFtpServerConfig(profileId, data.serverId);
      const ftpConfig = ftpConfigWithStoredPassword(data.ftpConfig, existingConfig);
      let server: FtpServer;
      try {
        server = service.saveFtpServer(profileId, data.serverId, {
          name: data.name,
          ftpConfig,
          customization: enforceDeliveryModeFor(data.browserUid, data.customization),
          sharedIndexKey: data.sharedIndexKey,
          unlinkSharedIndex: data.unlinkSharedIndex,
        });
      } catch (error) {
        if (error instanceof SharedIndexUnlinkRequiredError) {
          return res.status(409).json({
            error: error.message,
            requiresSharedIndexUnlink: true,
            sharedIndexName: error.sharedIndexName,
          });
        }
        if (error instanceof SharedIndexMasterIdentityChangeError) {
          return res.status(409).json({
            error: error.message,
            invalidatesSharedIndex: true,
            sharedIndexName: error.sharedIndexName,
          });
        }
        throw error;
      }
      if (server.sharedIndex) scanQueue.cancelServerScan(profileId, server.id);
      res.json({
        server: serverPayload(service, scanQueue, server),
        globalStats: globalStats(service, scanQueue, mediaRepository, profileId),
      });
    }),
  );

  router.post(
    "/profile/servers/delete",
    rateLimitProfiles,
    withProfile(serverIdSchema, "Invalid server delete request", ({ res, data, profileId }) => {
      try {
        service.deleteFtpServer(profileId, data.serverId);
      } catch (error) {
        if (error instanceof SharedIndexMasterDeleteError) {
          return res.status(409).json({
            error: error.message,
            invalidatesSharedIndex: true,
            sharedIndexName: error.sharedIndexName,
          });
        }
        throw error;
      }
      res.json({
        ...serversWithStats(service, scanQueue, mediaRepository, profileId),
      });
    }),
  );

  router.post(
    "/profile/servers/test",
    rateLimitProfiles,
    withProfile(serverIdSchema.extend({ ftpConfig: ftpConfigSchema }), "Invalid server test request", async ({ res, data, profileId }) => {
      const existingConfig = service.getFtpServerConfig(profileId, data.serverId);
      const ftpConfig = ftpConfigWithStoredPassword(data.ftpConfig, existingConfig);
      if (isDraftFtpConfig(ftpConfig)) return res.status(400).json({ error: "FTP username and password are required to test" });

      try {
        const client = await ftpClientFactory(ftpConfig);
        try {
          for (const root of ftpConfig.roots) await client.list(root);
        } finally {
          await client.close();
        }
        const connectionStatus = { lastTestedAt: new Date().toISOString(), ok: true };
        service.saveFtpServerConnectionStatus(profileId, data.serverId, connectionStatus);
        res.json({ ok: true, connectionStatus });
      } catch (error) {
        service.saveFtpServerConnectionStatus(profileId, data.serverId, {
          lastTestedAt: new Date().toISOString(),
          ok: false,
        });
        res.status(400).json({ error: ftpErrorMessage(error, "Unable to connect to FTP server") });
      }
    }),
  );

  router.post(
    "/profile/settings/export",
    withProfile(authenticatedSchema, "Invalid export request", ({ res, profileId }) => {
      const customization = service.getAddonCustomization(profileId);
      const servers = service.listFtpServers(profileId).map((server) => ({
        id: server.id,
        name: server.name,
        ftpConfig: server.ftpConfig,
        customization: server.customization,
        scanSchedule: server.scanSchedule,
      }));
      res.json({ customization, servers });
    }),
  );

  router.post(
    "/profile/delete",
    rateLimitProfiles,
    withProfile(authenticatedSchema, "Invalid delete request", ({ res, profileId }) => {
      service.deleteProfile(profileId);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/profile/customization/load",
    withProfile(authenticatedSchema, "Invalid customization request", ({ res, profileId }) => {
      res.json({ customization: service.getAddonCustomization(profileId) });
    }),
  );

  router.post(
    "/profile/customization",
    rateLimitProfiles,
    withProfile(saveCustomizationSchema, "Invalid customization request", ({ res, data, profileId }) => {
      service.saveAddonCustomization(profileId, enforceDeliveryModeFor(data.browserUid, data.customization));
      res.json({ ok: true });
    }),
  );

  router.post(
    "/profile/index/rescan",
    rateLimitProfiles,
    withProfile(
      authenticatedSchema.extend({ serverId: z.number().int().positive().optional(), all: z.boolean().optional(), force: z.boolean().optional() }),
      "Invalid rescan request",
      ({ res, data, profileId }) => {
        const scanOptions = data.force ? { force: true } : undefined;
        if (data.all) {
          const servers = service
            .listFtpServers(profileId)
            .filter((server) => server.ftpConfig && !isDraftFtpConfig(server.ftpConfig) && (!server.sharedIndex || isSharedIndexMaster(server)));
          if (!servers.length) return res.status(400).json({ error: "No FTP servers can be rescanned from this profile." });
          const scanStatuses = servers.map((server) =>
            server.sharedIndex
              ? scanQueue.enqueueSharedIndexScan(server.sharedIndex.id, "manual", scanOptions)
              : scanQueue.enqueueProfileScan(profileId, "manual", server.id, scanOptions),
          );
          return res.json({
            scanStatus: scanStatuses[0],
            scanStatuses,
            ...serversWithStats(service, scanQueue, mediaRepository, profileId),
          });
        }
        const serverId = data.serverId ?? service.defaultFtpServerId(profileId);
        const ftpConfig = service.getFtpServerConfig(profileId, serverId);
        if (!ftpConfig) return res.status(400).json({ error: "FTP settings are not configured" });
        if (isDraftFtpConfig(ftpConfig)) return res.status(400).json({ error: "Fill in username and password before scanning this server." });
        const server = service.getFtpServer(profileId, serverId);
        if (server.sharedIndex && !isSharedIndexMaster(server)) {
          return res.status(400).json({ error: "Linked servers are scanned through their shared index group." });
        }
        res.json({
          scanStatus: server.sharedIndex
            ? scanQueue.enqueueSharedIndexScan(server.sharedIndex.id, "manual", scanOptions)
            : scanQueue.enqueueProfileScan(profileId, "manual", serverId, scanOptions),
        });
      },
    ),
  );

  router.post(
    "/profile/index/cancel",
    rateLimitProfiles,
    withProfile(authenticatedSchema.extend({ serverId: z.number().int().positive().optional() }), "Invalid scan cancel request", ({ res, data, profileId }) => {
      const serverId = data.serverId ?? service.defaultFtpServerId(profileId);
      const server = service.getFtpServer(profileId, serverId);
      res.json({ scanStatus: server.sharedIndex ? scanQueue.cancelSharedIndexScan(server.sharedIndex.id) : scanQueue.cancelServerScan(profileId, serverId) });
    }),
  );

  router.post(
    "/profile/index/status",
    withProfile(authenticatedSchema, "Invalid scan status request", ({ res, profileId }) => {
      res.json({
        indexStatus: service.getIndexStatus(profileId),
        scanStatus: scanQueue.getProfileScanStatus(profileId),
        scanSchedule: service.getScanSchedule(profileId),
        ...serversWithStats(service, scanQueue, mediaRepository, profileId),
      });
    }),
  );

  router.post(
    "/profile/index/schedule",
    rateLimitProfiles,
    withProfile(saveScanScheduleSchema.extend({ serverId: z.number().int().positive().optional() }), "Invalid scan schedule request", ({ res, data, profileId }) => {
      if (data.intervalMinutes > 0 && data.intervalMinutes < config.scanMinRescanIntervalMinutes) {
        return res.status(400).json({
          error: `Rescan frequency must be at least ${config.scanMinRescanIntervalMinutes} minutes.`,
        });
      }
      const serverId = data.serverId ?? service.defaultFtpServerId(profileId);
      const server = service.getFtpServer(profileId, serverId);
      if (server.sharedIndex && !isSharedIndexMaster(server)) {
        return res.status(400).json({ error: "Shared index scans are scheduled from the master index." });
      }
      const nextScheduledScanAt = data.intervalMinutes > 0 ? new Date(Date.now() + data.intervalMinutes * 60_000).toISOString() : null;
      service.saveFtpServerScanSchedule(profileId, serverId, {
        intervalMinutes: data.intervalMinutes,
        nextScheduledScanAt,
      });
      res.json({ scanSchedule: service.getFtpServerScanSchedule(profileId, serverId) });
    }),
  );

  return router;
}

function serversWithStats(service: ProfileService, scanQueue: ScanQueue, mediaRepository: MediaRepository, profileId: number) {
  const servers = service.listFtpServers(profileId);
  return {
    servers: servers.map((server) => serverPayload(service, scanQueue, server)),
    globalStats: globalStats(service, scanQueue, mediaRepository, profileId, servers),
  };
}

function serverPayload(service: ProfileService, scanQueue: ScanQueue, server: FtpServer) {
  const ftpConfig = server.ftpConfig;
  const draft = ftpConfig ? isDraftFtpConfig(ftpConfig) : false;
  const sharedGroup = server.sharedIndex;
  const sharedScanStatus = sharedGroup ? scanQueue.getSharedIndexScanStatus(sharedGroup.id) : null;
  const sharedMaster = Boolean(sharedGroup?.isMaster);
  return {
    id: server.id,
    name: server.name,
    draft,
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
    indexStatus: sharedGroup
      ? { lastScanAt: sharedGroup.lastIndexedAt, mediaItems: sharedGroup.indexedMediaCount }
      : server.indexStatus,
    scanStatus: sharedScanStatus ?? scanQueue.getServerScanStatus(server.profileId, server.id),
    scanSchedule: sharedGroup ? service.sharedIndexGroupScanSchedule(sharedGroup.id) : server.scanSchedule,
    connectionStatus: server.connectionStatus,
    pendingScanAfter: sharedGroup ? null : server.pendingScanAfter,
    sharedIndex: sharedGroup
      ? {
          id: sharedGroup.id,
          name: sharedGroup.name,
          keyHint: sharedGroup.keyHint,
          linked: true,
          isMaster: sharedMaster,
          message: sharedMaster ? "This server is the shared index master." : "Scanning handled by shared master index.",
        }
      : null,
  };
}

function isSharedIndexMaster(server: FtpServer) {
  return Boolean(server.sharedIndex?.isMaster);
}

function globalStats(
  service: ProfileService,
  scanQueue: ScanQueue,
  mediaRepository: MediaRepository,
  profileId: number,
  servers = service.listFtpServers(profileId),
) {
  const linkedGroupIds = [...new Set(servers.map((server) => server.sharedIndex?.id).filter((id): id is number => typeof id === "number"))];
  const counts = mediaRepository.aggregateCountsForProfileWithSharedIndexes(profileId, linkedGroupIds);
  const statuses = [
    ...servers.filter((server) => !server.sharedIndex).map((server) => scanQueue.getServerScanStatus(profileId, server.id)),
    ...linkedGroupIds.map((groupId) => scanQueue.getSharedIndexScanStatus(groupId)),
  ];
  const activeScans = statuses.filter((status) => status.status === "running").length;
  const queuedScans = statuses.filter((status) => status.status === "queued").length;
  const pendingScans = queuedScans + servers.filter((server) => !server.sharedIndex && server.pendingScanAfter).length;
  const lastCompletedScanAt =
    [
      ...servers.filter((server) => !server.sharedIndex).map((server) => server.indexStatus.lastScanAt),
      ...servers.map((server) => server.sharedIndex?.lastIndexedAt ?? null),
    ]
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

const MAX_FAILED_UNLOCK_ATTEMPTS = 10;

type AttemptBucket = { count: number; resetAt: number };

export class AttemptWindow {
  private readonly buckets = new Map<string, AttemptBucket>();
  private nextSweepAt = 0;

  constructor(private readonly windowMs: number) {}

  get size() {
    return this.buckets.size;
  }

  current(key: string, now = Date.now()): AttemptBucket | null {
    this.sweep(now);
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > now ? bucket : null;
  }

  add(key: string, now = Date.now()): AttemptBucket {
    const bucket = this.current(key, now) ?? { count: 0, resetAt: now + this.windowMs };
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return bucket;
  }

  clear(key: string) {
    this.buckets.delete(key);
  }

  private sweep(now: number) {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export type FailedUnlockLimiter = ReturnType<typeof createFailedUnlockLimiter>;

export function createFailedUnlockLimiter(config: Pick<AppConfig, "profileRateLimitWindowMs" | "profileRateLimitMax">) {
  const maxFailures = Math.min(config.profileRateLimitMax, MAX_FAILED_UNLOCK_ATTEMPTS);
  const failures = new AttemptWindow(config.profileRateLimitWindowMs);
  const keyFor = (req: Request, browserUid: string) => `${profileRateLimitKey(req)}|uid:${browserUid}`;

  return {
    retryAfterSeconds(req: Request, browserUid: string, now = Date.now()) {
      const bucket = failures.current(keyFor(req, browserUid), now);
      return bucket && bucket.count >= maxFailures ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) : 0;
    },
    recordFailure(req: Request, browserUid: string) {
      failures.add(keyFor(req, browserUid));
    },
    recordSuccess(req: Request, browserUid: string) {
      failures.clear(keyFor(req, browserUid));
    },
  };
}

export async function unlockWithFailureLimit(
  service: ProfileService,
  failedUnlocks: FailedUnlockLimiter,
  req: Request,
  res: Response,
  credentials: AuthenticatedBody,
  countryCode: string | null = null,
): Promise<number | null> {
  const retryAfter = failedUnlocks.retryAfterSeconds(req, credentials.browserUid);
  if (retryAfter > 0) {
    res.setHeader("Retry-After", retryAfter);
    res.status(429).json({ error: "Too many profile attempts" });
    return null;
  }
  try {
    const { profileId } = await service.unlockProfile(credentials.browserUid, credentials.passphrase, countryCode);
    failedUnlocks.recordSuccess(req, credentials.browserUid);
    return profileId;
  } catch (error) {
    if (!(error instanceof InvalidPassphraseError)) throw error;
    failedUnlocks.recordFailure(req, credentials.browserUid);
    res.status(401).json({ error: "Invalid passphrase" });
    return null;
  }
}

function profileRateLimiter(windowMs: number, maxAttempts: number): RequestHandler {
  const attempts = new AttemptWindow(windowMs);

  return (req, res, next) => {
    const now = Date.now();
    const bucket = attempts.add(profileRateLimitKey(req), now);
    if (bucket.count > maxAttempts) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many profile attempts" });
    }

    next();
  };
}

function profileRateLimitKey(req: Request) {
  const cloudflareIp = req.header("cf-connecting-ip")?.trim();
  if (cloudflareIp && isIP(cloudflareIp)) return `ip:${cloudflareIp}`;

  return `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
}
