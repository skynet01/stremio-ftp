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
import { limitFtpClientFactory } from "./ftp/ftpConnectionLimiter.js";
import type { FtpClientFactory } from "./ftp/ftpTypes.js";
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
  app.set("trust proxy", "loopback");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(stremioCors());
  app.use(express.json({ limit: "128kb" }));

  const profileService = new ProfileService(db, config.encryptionKey);
  const mediaRepository = new MediaRepository(db);
  const ftpClientFactory = limitFtpClientFactory(options.ftpClientFactory ?? createBasicFtpClientFactory(config.ftpTimeoutMs), config.ftpMaxConnections);
  const scanQueue = new ScanQueue(config, profileService, mediaRepository, ftpClientFactory);
  const scanScheduler = setInterval(() => scanQueue.enqueueDueScheduledScans(), config.scanSchedulerIntervalMs);
  scanScheduler.unref();
  if (config.emptyProfileCleanupDays > 0) {
    const ageMs = config.emptyProfileCleanupDays * 24 * 60 * 60 * 1000;
    const runCleanup = () => {
      try {
        const cutoff = new Date(Date.now() - ageMs).toISOString();
        const removed = profileService.deleteEmptyProfilesOlderThan(cutoff);
        if (removed > 0) console.log(`[cleanup] Removed ${removed} empty profile(s) older than ${config.emptyProfileCleanupDays} day(s).`);
      } catch (error) {
        console.error("[cleanup] Failed to remove empty profiles:", error);
      }
    };
    runCleanup();
    const cleanupTimer = setInterval(runCleanup, config.emptyProfileCleanupIntervalMs);
    cleanupTimer.unref();
  }
  app.use("/api/profile", requireSetupToken(config));
  app.get("/api/setup", (req, res) => {
    const browserUid = (req.query.browserUid ?? "").toString();
    const isAdmin = Boolean(browserUid) && config.adminBrowserUids.has(browserUid);
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
  app.use("/api", profileRoutes(config, profileService, ftpClientFactory, scanQueue));
  app.use(createProxyRouter({ resolve: createFtpProxyResolver(profileService, mediaRepository, ftpClientFactory) }));
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

  return app;
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
