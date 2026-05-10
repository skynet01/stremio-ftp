export type AppConfig = {
  baseUrl: string;
  configDir: string;
  sqlitePath: string;
  encryptionKey: string;
  setupToken: string | null;
  allowPublicProfileApi: boolean;
  tmdbApiKey: string | null;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  crawlerConcurrency: number;
  ftpTimeoutMs: number;
  ftpMaxConnections: number;
  maxOnDemandSearchMs: number;
  profileRateLimitWindowMs: number;
  profileRateLimitMax: number;
  scanGlobalConcurrency: number;
  scanQueueMax: number;
  scanCooldownMs: number;
  scanMinRescanIntervalMinutes: number;
  scanJobTimeoutMs: number;
  scanSchedulerIntervalMs: number;
  scanProgressAverageItems: number;
  scanTransientRetryDelayMs: number;
  maxFtpServersPerProfile: number;
  proxyStreamsDisabled: boolean;
  adminBrowserUids: ReadonlySet<string>;
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

function nonNegativeNumberValue(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
  return Number(raw);
}

function portValue(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = numberValue(env, key, fallback);
  if (parsed > 65535) throw new Error(`${key} must be an integer from 1 to 65535`);
  return parsed;
}

function booleanValue(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AppConfig {
  const baseUrl = requireValue(env, "BASE_URL").replace(/\/+$/, "");
  const encryptionKey = requireValue(env, "CONFIG_ENCRYPTION_KEY");
  if (encryptionKey.length < 32) throw new Error("CONFIG_ENCRYPTION_KEY must be at least 32 characters");
  const setupToken = (env.SETUP_TOKEN || env.STREMIO_FTP_SETUP_TOKEN)?.trim() || null;
  if (setupToken && setupToken.length < 16) throw new Error("SETUP_TOKEN must be at least 16 characters");
  const allowPublicProfileApi = booleanValue(env, "ALLOW_PUBLIC_PROFILE_API", false);
  if (!setupToken && !allowPublicProfileApi) throw new Error("SETUP_TOKEN is required unless ALLOW_PUBLIC_PROFILE_API=true");
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
    allowPublicProfileApi,
    tmdbApiKey,
    port: portValue(env, "PORT", 7000),
    logLevel,
    crawlerConcurrency: numberValue(env, "CRAWLER_CONCURRENCY", 2),
    ftpTimeoutMs: numberValue(env, "FTP_TIMEOUT_MS", 15000),
    ftpMaxConnections: numberValue(env, "FTP_MAX_CONNECTIONS", 4),
    maxOnDemandSearchMs: numberValue(env, "MAX_ON_DEMAND_SEARCH_MS", 4500),
    profileRateLimitWindowMs: numberValue(env, "PROFILE_RATE_LIMIT_WINDOW_MS", 600000),
    profileRateLimitMax: numberValue(env, "PROFILE_RATE_LIMIT_MAX", 20),
    scanGlobalConcurrency: numberValue(env, "SCAN_GLOBAL_CONCURRENCY", 2),
    scanQueueMax: numberValue(env, "SCAN_QUEUE_MAX", 50),
    scanCooldownMs: numberValue(env, "SCAN_COOLDOWN_MS", 900000),
    scanMinRescanIntervalMinutes: numberValue(env, "SCAN_MIN_RESCAN_INTERVAL_MINUTES", 0),
    scanJobTimeoutMs: numberValue(env, "SCAN_JOB_TIMEOUT_MS", 1800000),
    scanSchedulerIntervalMs: numberValue(env, "SCAN_SCHEDULER_INTERVAL_MS", 60000),
    scanProgressAverageItems: numberValue(env, "SCAN_PROGRESS_AVERAGE_ITEMS", 2000),
    scanTransientRetryDelayMs: numberValue(env, "SCAN_TRANSIENT_RETRY_DELAY_MS", 300000),
    maxFtpServersPerProfile: nonNegativeNumberValue(env, "MAX_FTP_SERVERS_PER_PROFILE", 0),
    proxyStreamsDisabled: booleanValue(env, "DISABLE_PROXY_STREAMS", false),
    adminBrowserUids: new Set(
      (env.ADMIN_BROWSER_UIDS ?? "")
        .split(/[,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  };
}
