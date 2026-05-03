export type AppConfig = {
  baseUrl: string;
  configDir: string;
  sqlitePath: string;
  encryptionKey: string;
  setupToken: string | null;
  tmdbApiKey: string | null;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  crawlerConcurrency: number;
  ftpTimeoutMs: number;
  maxOnDemandSearchMs: number;
  profileRateLimitWindowMs: number;
  profileRateLimitMax: number;
  scanGlobalConcurrency: number;
  scanQueueMax: number;
  scanCooldownMs: number;
  scanJobTimeoutMs: number;
  scanSchedulerIntervalMs: number;
  scanProgressAverageItems: number;
};

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

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
  const setupToken = (env.SETUP_TOKEN || env.STREMIO_FTP_SETUP_TOKEN)?.trim() || null;
  if (setupToken && setupToken.length < 16) throw new Error("SETUP_TOKEN must be at least 16 characters");
  const tmdbApiKey = env.TMDB_API_KEY?.trim() || null;

  const configDir = env.CONFIG_DIR?.trim() || "/config";
  const logLevel = (env.LOG_LEVEL || "info") as AppConfig["logLevel"];
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);

  return {
    baseUrl,
    configDir,
    sqlitePath: `${configDir.replace(/\/+$/, "")}/stremio-ftp.sqlite`,
    encryptionKey,
    setupToken,
    tmdbApiKey,
    port: portValue(env, "PORT", 7000),
    logLevel,
    crawlerConcurrency: numberValue(env, "CRAWLER_CONCURRENCY", 2),
    ftpTimeoutMs: numberValue(env, "FTP_TIMEOUT_MS", 15000),
    maxOnDemandSearchMs: numberValue(env, "MAX_ON_DEMAND_SEARCH_MS", 4500),
    profileRateLimitWindowMs: numberValue(env, "PROFILE_RATE_LIMIT_WINDOW_MS", 600000),
    profileRateLimitMax: numberValue(env, "PROFILE_RATE_LIMIT_MAX", 20),
    scanGlobalConcurrency: numberValue(env, "SCAN_GLOBAL_CONCURRENCY", 2),
    scanQueueMax: numberValue(env, "SCAN_QUEUE_MAX", 50),
    scanCooldownMs: numberValue(env, "SCAN_COOLDOWN_MS", 900000),
    scanJobTimeoutMs: numberValue(env, "SCAN_JOB_TIMEOUT_MS", 1800000),
    scanSchedulerIntervalMs: numberValue(env, "SCAN_SCHEDULER_INTERVAL_MS", 60000),
    scanProgressAverageItems: numberValue(env, "SCAN_PROGRESS_AVERAGE_ITEMS", 2000),
  };
}
