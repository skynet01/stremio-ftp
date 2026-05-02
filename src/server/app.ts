import express from "express";
import helmet from "helmet";
import type { AppConfig } from "./config.js";

export function createApp(config: AppConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "stremio-ftp", baseUrl: config.baseUrl });
  });

  return app;
}
