import type Database from "better-sqlite3";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { MediaRepository } from "./media/mediaRepository.js";
import { ProfileService } from "./profiles/profileService.js";
import { profileRoutes } from "./profiles/profileRoutes.js";
import { createProxyRouter } from "./proxy/proxyRoutes.js";
import { stremioRoutes } from "./stremio/routes.js";

export function createApp(config: AppConfig, db: Database.Database = openDatabase(config.sqlitePath)) {
  const app = express();
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  const indexHtml = path.join(publicDir, "index.html");
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "128kb" }));

  const profileService = new ProfileService(db, config.encryptionKey);
  const mediaRepository = new MediaRepository(db);
  app.use("/api", profileRoutes(config, profileService));
  app.use(createProxyRouter({ resolve: async () => null }));
  app.use(stremioRoutes(config, profileService, mediaRepository));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "stremio-ftp", baseUrl: config.baseUrl });
  });

  if (existsSync(indexHtml)) {
    app.use(express.static(publicDir));
    app.get(["/", "/configure"], (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  return app;
}
