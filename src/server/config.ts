export type AppConfig = {
  baseUrl: string;
  configDir: string;
  sqlitePath: string;
  encryptionKey: string;
  setupToken: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  crawlerConcurrency: number;
  ftpTimeoutMs: number;
  maxOnDemandSearchMs: number;
  profileRateLimitWindowMs: number;
  profileRateLimitMax: number;
};

function requireValue(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function numberValue(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${key} must be a positive integer`);
  return Number(raw);
}

function portValue(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = numberValue(env, key, fallback);
  if (parsed > 65535) throw new Error(`${key} must be an integer from 1 to 65535`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AppConfig {
  const baseUrl = requireValue(env, "BASE_URL").replace(/\/+$/, "");
  const encryptionKey = requireValue(env, "CONFIG_ENCRYPTION_KEY");
  if (encryptionKey.length < 32) throw new Error("CONFIG_ENCRYPTION_KEY must be at least 32 characters");
  const setupToken = requireValue(env, "SETUP_TOKEN");
  if (setupToken.length < 16) throw new Error("SETUP_TOKEN must be at least 16 characters");

  const configDir = env.CONFIG_DIR?.trim() || "/config";
  const logLevel = (env.LOG_LEVEL || "info") as AppConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL is invalid");

  return {
    baseUrl,
    configDir,
    sqlitePath: `${configDir.replace(/\/+$/, "")}/stremio-ftp.sqlite`,
    encryptionKey,
    setupToken,
    port: portValue(env, "PORT", 7000),
    logLevel,
    crawlerConcurrency: numberValue(env, "CRAWLER_CONCURRENCY", 2),
    ftpTimeoutMs: numberValue(env, "FTP_TIMEOUT_MS", 15000),
    maxOnDemandSearchMs: numberValue(env, "MAX_ON_DEMAND_SEARCH_MS", 4500),
    profileRateLimitWindowMs: numberValue(env, "PROFILE_RATE_LIMIT_WINDOW_MS", 600000),
    profileRateLimitMax: numberValue(env, "PROFILE_RATE_LIMIT_MAX", 20),
  };
}
