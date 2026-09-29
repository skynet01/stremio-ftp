import type Database from "better-sqlite3";
import express from "express";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { createBasicFtpClientFactory } from "./ftp/basicFtpClient.js";
import { createFtpConnectionPool } from "./ftp/ftpConnectionPool.js";
import { limitFtpClientFactoryByKey } from "./ftp/ftpConnectionLimiter.js";
import type { FtpClientFactory } from "./ftp/ftpTypes.js";
import { redactSecrets } from "./logging/redact.js";
import { MediaRepository } from "./media/mediaRepository.js";
import { ProfileService } from "./profiles/profileService.js";
import { profileRoutes } from "./profiles/profileRoutes.js";
import { createFtpProxyResolver } from "./proxy/ftpProxyResolver.js";
import { createProxyRouter } from "./proxy/proxyRoutes.js";
import { ScanQueue } from "./scanner/scanQueue.js";
import { stremioRoutes } from "./stremio/routes.js";

type AppOptions = {
  publicDir?: string;
  ftpClientFactory?: FtpClientFactory;
};

export function createApp(
  config: AppConfig,
  db: Database.Database = openDatabase(config.sqlitePath),
  options: AppOptions = {},
) {
  const app = express();
  const publicDir = options.publicDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  const indexHtml = path.join(publicDir, "index.html");
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://api.github.com"],
          upgradeInsecureRequests: config.baseUrl.startsWith("https://") ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(stremioCors());
  app.use(express.json({ limit: "128kb" }));

  const profileService = new ProfileService(db, config.encryptionKey);
  const mediaRepository = new MediaRepository(db);
  const baseFtpClientFactory = options.ftpClientFactory ?? createBasicFtpClientFactory(config.ftpTimeoutMs);
  const ftpClientFactory = limitFtpClientFactoryByKey(baseFtpClientFactory, config.ftpMaxConnections);
  // Configs built without loadConfig (tests) leave pooling off.
  const ftpPool = createFtpConnectionPool(ftpClientFactory, { idleMs: config.ftpPoolIdleMs ?? 0 });
  const scanQueue = new ScanQueue(config, profileService, mediaRepository, ftpClientFactory);
  const scanScheduler = setInterval(
    guardedTimerTask("[scan-scheduler] Failed to enqueue scheduled scans:", () => scanQueue.enqueueDueScheduledScans()),
    config.scanSchedulerIntervalMs,
  );
  scanScheduler.unref();
  if (config.emptyProfileCleanupDays > 0) {
    const ageMs = config.emptyProfileCleanupDays * 24 * 60 * 60 * 1000;
    const runCleanup = guardedTimerTask("[cleanup] Failed to remove empty profiles:", () => {
      const cutoff = new Date(Date.now() - ageMs).toISOString();
      const removed = profileService.deleteEmptyProfilesOlderThan(cutoff);
      if (removed > 0) console.log(`[cleanup] Removed ${removed} empty profile(s) older than ${config.emptyProfileCleanupDays} day(s).`);
    });
    runCleanup();
    const cleanupTimer = setInterval(runCleanup, config.emptyProfileCleanupIntervalMs);
    cleanupTimer.unref();
  }
  app.use("/api/profile", requireSetupToken(config));
  app.get("/api/setup", (req, res) => {
    const browserUid = (req.query.browserUid ?? "").toString();
    const isAdmin = Boolean(browserUid) && profileService.isAdminBrowserUid(browserUid, config.adminBrowserUids);
    res.json({
      setupTokenRequired: Boolean(config.setupToken) || !config.allowPublicProfileApi,
      maxFtpServersPerProfile: isAdmin ? 0 : config.maxFtpServersPerProfile,
      proxyStreamsDisabled: isAdmin ? false : config.proxyStreamsDisabled,
      isAdmin,
    });
  });
  app.get("/api/setup/validate", requireSetupToken(config), (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api", profileRoutes(config, profileService, ftpClientFactory, scanQueue, mediaRepository));
  app.use(createProxyRouter({ resolve: createFtpProxyResolver(profileService, mediaRepository, ftpPool) }));
  app.use(stremioRoutes(config, profileService, mediaRepository));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "stremio-ftp", baseUrl: config.baseUrl });
  });

  if (existsSync(indexHtml)) {
    app.use(express.static(publicDir));
    app.get("/", (_req, res) => {
      res.sendFile("index.html", { root: publicDir });
    });
    app.get("/configure", (_req, res) => {
      res.sendFile("index.html", { root: publicDir });
    });
    app.get("/u/:installToken/configure", (_req, res) => {
      res.redirect(302, "/");
    });
  }

  app.use(jsonErrorHandler());

  // Logs out pooled FTP connections; the process calls it before exiting.
  return Object.assign(app, { shutdown: () => ftpPool.close() });
}

function guardedTimerTask(failureMessage: string, task: () => void) {
  return () => {
    try {
      task();
    } catch (error) {
      console.error(failureMessage, redactSecrets(error instanceof Error ? error.message : String(error)));
    }
  };
}

function jsonErrorHandler(): express.ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = httpErrorStatus(error);
    if (status >= 500) {
      const route = `${req.baseUrl}${typeof req.route?.path === "string" ? req.route.path : ""}` || "unmatched route";
      console.error(`[http] ${req.method} ${route} failed:`, loggableError(error));
    }
    res.status(status).json({ error: publicErrorMessage(status) });
  };
}

function publicErrorMessage(status: number) {
  if (status >= 500) return "Internal server error";
  if (status === 400) return "Invalid request body";
  if (status === 413) return "Request body too large";
  return "Request failed";
}

function httpErrorStatus(error: unknown) {
  const candidate = error as { status?: unknown; statusCode?: unknown } | null | undefined;
  const status = candidate?.status ?? candidate?.statusCode;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function loggableError(error: unknown) {
  return redactSecrets(error instanceof Error ? error.stack || error.message : String(error));
}

function stremioCors(): express.RequestHandler {
  return (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, x-setup-token");
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

function requireSetupToken(config: AppConfig): express.RequestHandler {
  return (req, res, next) => {
    if (!config.setupToken && config.allowPublicProfileApi) return next();
    if (!config.setupToken) return res.status(403).json({ error: "Invalid setup token" });
    const provided = setupTokenFromRequest(req);
    if (!provided || !safeEqual(provided, config.setupToken)) {
      return res.status(403).json({ error: "Invalid setup token" });
    }
    next();
  };
}

function setupTokenFromRequest(req: express.Request) {
  const header = req.header("x-setup-token");
  return header || null;
}

function safeEqual(a: string, b: string) {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}
