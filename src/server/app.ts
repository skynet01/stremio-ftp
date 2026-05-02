import type Database from "better-sqlite3";
import express from "express";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { createBasicFtpClient } from "./ftp/basicFtpClient.js";
import type { FtpClientFactory } from "./ftp/ftpTypes.js";
import { MediaRepository } from "./media/mediaRepository.js";
import { ProfileService } from "./profiles/profileService.js";
import { profileRoutes } from "./profiles/profileRoutes.js";
import { createFtpProxyResolver } from "./proxy/ftpProxyResolver.js";
import { createProxyRouter } from "./proxy/proxyRoutes.js";
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
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(stremioCors());
  app.use(express.json({ limit: "128kb" }));

  const profileService = new ProfileService(db, config.encryptionKey);
  const mediaRepository = new MediaRepository(db);
  const ftpClientFactory = options.ftpClientFactory ?? createBasicFtpClient;
  app.use("/api/profile", requireSetupToken(config));
  app.use("/api", profileRoutes(config, profileService, mediaRepository, ftpClientFactory));
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
    const provided = setupTokenFromRequest(req);
    if (!provided || !safeEqual(provided, config.setupToken)) {
      return res.status(403).json({ error: "Invalid setup token" });
    }
    next();
  };
}

function setupTokenFromRequest(req: express.Request) {
  const header = req.header("x-setup-token");
  if (header) return header;
  const query = req.query.setup;
  return typeof query === "string" ? query : null;
}

function safeEqual(a: string, b: string) {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}
