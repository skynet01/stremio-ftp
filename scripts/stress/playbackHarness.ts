import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type Database from "better-sqlite3";
import { createApp } from "../../src/server/app";
import { loadConfig } from "../../src/server/config";
import { openDatabase } from "../../src/server/db/database";
import { createBasicFtpClientFactory, type BasicFtpClientOptions } from "../../src/server/ftp/basicFtpClient";
import type { FtpClient } from "../../src/server/ftp/ftpTypes";
import { MediaRepository } from "../../src/server/media/mediaRepository";
import { ProfileService, type FtpConfig } from "../../src/server/profiles/profileService";
import { FakeFtpServer, NO_FAULTS, seededRandom, type FakeFtpStats, type FtpFaults } from "./fakeFtpServer";
import { firstPatternMismatch } from "./pattern";

// End-to-end playback stress harness: the real Express app (createApp) with a temp SQLite database,
// the real basic-ftp client behind the real connection limiter, and an in-process fake FTP server.
// Every viewer is its own profile with its own FTP username, like the production setup.

export type ScenarioName = "A" | "B" | "C" | "D" | "E";

export const SCENARIO_TITLES: Record<ScenarioName, string> = {
  A: "concurrent start-up (HEAD, then 3 parallel GETs per viewer)",
  B: "rapid skipping (seek, read 0.5-4 MB, abort; bursts of 5 seeks in 100 ms)",
  C: "slow consumers and complete bounded ranges",
  D: "FTP faults (530s, drops, delays, stalls)",
  E: "HEAD warm-up storms mixed with GETs",
};

export type HarnessOptions = {
  viewers: number;
  scenarioMs: number;
  ftpMaxConnections: number;
  serverUserCap: number;
  releaseLagMs: number;
  latencyMs: number;
  ftpTimeoutMs: number;
  // App FTP_POOL_IDLE_MS. Short by default so the "quiet" checks do not wait out the production idle time.
  poolIdleMs: number;
  // App FTP_LOGIN_FAILURE_CACHE_MS. Short by default so an injected 530 in D does not fail the next scenario's probe.
  loginFailureCacheMs: number;
  hangTimeoutMs: number;
  quiesceTimeoutMs: number;
  fileSizeBytes: number;
  seed: number;
  scenarios: ScenarioName[];
  // One viewer in C pauses reading for longer than the FTP timeout (like a paused player).
  longPause: boolean;
  faults: FtpFaults;
  log: (line: string) => void;
};

export const DEFAULT_FAULTS: FtpFaults = {
  loginRejectRate: 0.05,
  replyDelayRate: 0.2,
  replyDelayMaxMs: 400,
  dataDropRate: 0.15,
  controlDropRate: 0.02,
  stallRate: 0.01,
};

export function defaultHarnessOptions(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    viewers: 10,
    scenarioMs: 15_000,
    ftpMaxConnections: 3,
    serverUserCap: 3,
    releaseLagMs: 0,
    latencyMs: 0,
    ftpTimeoutMs: 15_000,
    poolIdleMs: 2_000,
    loginFailureCacheMs: 1_000,
    hangTimeoutMs: 30_000,
    quiesceTimeoutMs: 15_000,
    fileSizeBytes: 256 * 1024 * 1024,
    seed: 1,
    scenarios: ["A", "B", "C", "D", "E"],
    longPause: true,
    faults: DEFAULT_FAULTS,
    log: () => undefined,
    ...overrides,
  };
}

type StressFile = { path: string; filename: string; size: number; seed: number };

type Viewer = {
  index: number;
  token: string;
  fileIds: number[];
  agent: http.Agent;
  rng: () => number;
};

type RangeSpec =
  | { kind: "none" }
  | { kind: "open"; start: number }
  | { kind: "bounded"; start: number; end: number }
  | { kind: "suffix"; length: number };

type RequestPlan = {
  method: "GET" | "HEAD";
  viewer: Viewer;
  fileIndex: number;
  range: RangeSpec;
  // Destroy the socket after this many body bytes (a seek away). Omit to read everything.
  readLimit?: number;
  bytesPerSec?: number;
  longPause?: { afterBytes: number; ms: number };
  label: string;
};

type RequestOutcome =
  | "complete"
  | "aborted"
  | "cancelled"
  | "status_error"
  | "premature_close"
  | "request_error"
  | "hang"
  | "bad_bytes"
  | "bad_headers";

type RequestResult = {
  plan: RequestPlan;
  status: number | null;
  outcome: RequestOutcome;
  headersMs: number | null;
  ttfbMs: number | null;
  bytes: number;
  durationMs: number;
  error?: string;
  silentBeforeCloseMs?: number;
};

type ActiveRequest = { promise: Promise<RequestResult>; cancel(): void };

export type ScenarioReport = {
  name: ScenarioName;
  title: string;
  ftpMaxConnections: number;
  durationMs: number;
  requests: number;
  outcomes: Record<string, number>;
  playbackFailures: number;
  playbackFailuresByLabel: Record<string, number>;
  ttfb: { p50: number | null; p95: number | null; max: number | null; samples: number };
  head: { p50: number | null; p95: number | null; samples: number };
  // GETs sent while the viewer's FTP slots were all in use, so they had to queue in the limiter.
  queuedWaits: number;
  maxSlotsPerUser: number;
  maxServerSessionsPerUser: number;
  server: FakeFtpStats;
  proxyOutcomes: Record<string, number>;
  ftpEvents: Record<string, number>;
  loginErrors: Record<string, number>;
  appErrors: Record<string, number>;
  slowFailures: number;
  quiesceMs: number | null;
  memory: { heapMB: number; rssMB: number };
  violations: string[];
  notes: string[];
  knownIssues: string[];
};

export type HarnessReport = {
  options: Omit<HarnessOptions, "log">;
  scenarios: ScenarioReport[];
  memory: { baseline: { heapMB: number; rssMB: number }; final: { heapMB: number; rssMB: number } };
  violations: string[];
  warnings: string[];
};

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Environment

type Environment = {
  options: HarnessOptions;
  tmpDir: string;
  db: Database.Database;
  ftp: FakeFtpServer;
  httpServer: http.Server;
  shutdownApp: () => Promise<void>;
  port: number;
  slots: SlotCounter;
  activeStreams: () => Promise<number>;
  files: StressFile[];
  viewerTokens: Array<{ token: string; fileIds: number[] }>;
  loginErrors: Map<string, number>;
  logs: LogCollector;
};

async function startEnvironment(options: HarnessOptions, logs: LogCollector): Promise<Environment> {
  const tmpDir = mkdtempSync(join(tmpdir(), "stremio-ftp-stress-"));
  const files: StressFile[] = [
    { path: "/Movies/Big.Buck.Bunny.2008.1080p.mkv", filename: "Big.Buck.Bunny.2008.1080p.mkv", size: options.fileSizeBytes + 7, seed: 0x1111 },
    { path: "/Movies/Sintel.2010.1080p.mkv", filename: "Sintel.2010.1080p.mkv", size: options.fileSizeBytes - 13, seed: 0x2222 },
    { path: "/Movies/Tears.of.Steel.2012.720p.mp4", filename: "Tears.of.Steel.2012.720p.mp4", size: Math.floor(options.fileSizeBytes * 0.75) + 1, seed: 0x3333 },
  ];
  const ftp = await new FakeFtpServer({
    files: Object.fromEntries(files.map((file) => [file.path, { size: file.size, seed: file.seed }])),
    perUserMaxConnections: options.serverUserCap,
    releaseLagMs: options.releaseLagMs,
    latencyMs: options.latencyMs,
    random: seededRandom(options.seed ^ 0x5eed),
  }).listen();

  const config = loadConfig({
    BASE_URL: "http://127.0.0.1:7000",
    CONFIG_ENCRYPTION_KEY: "stress-harness-encryption-key-0123456789",
    ALLOW_PUBLIC_PROFILE_API: "true",
    CONFIG_DIR: tmpDir,
    FTP_MAX_CONNECTIONS: String(options.ftpMaxConnections),
    FTP_TIMEOUT_MS: String(options.ftpTimeoutMs),
    FTP_POOL_IDLE_MS: String(options.poolIdleMs),
    FTP_LOGIN_FAILURE_CACHE_MS: String(options.loginFailureCacheMs),
    EMPTY_PROFILE_CLEANUP_DAYS: "0",
    SCAN_SCHEDULER_INTERVAL_MS: "3600000",
  });
  const db = openDatabase(config.sqlitePath);

  // The real basic-ftp client, wrapped only to observe it: the app's limiter sits in front of this factory and
  // holds a slot from the moment it calls the factory until it closes the client, so counting here mirrors slots.
  const loginErrors = new Map<string, number>();
  const slots = new SlotCounter();
  const basicFactory = createBasicFtpClientFactory(config.ftpTimeoutMs);
  const countingFactory = async (ftpConfig: FtpConfig, requestOptions?: BasicFtpClientOptions) => {
    slots.acquire(ftpConfig.username);
    let client: FtpClient;
    try {
      client = await basicFactory(ftpConfig, requestOptions);
    } catch (error) {
      slots.release(ftpConfig.username);
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      increment(loginErrors, message);
      throw error;
    }
    let released = false;
    return {
      ...client,
      close: async () => {
        try {
          await client.close();
        } finally {
          if (!released) {
            released = true;
            slots.release(ftpConfig.username);
          }
        }
      },
    };
  };
  const app = createApp(config, db, { ftpClientFactory: countingFactory, publicDir: tmpDir });

  const profiles = new ProfileService(db, config.encryptionKey);
  const media = new MediaRepository(db);
  const viewerTokens: Array<{ token: string; fileIds: number[] }> = [];
  for (let index = 0; index < options.viewers; index += 1) {
    const { profileId, installUrlToken } = await profiles.createProfile(viewerBrowserUid(index), VIEWER_PASSPHRASE);
    const serverId = profiles.defaultFtpServerId(profileId);
    profiles.saveFtpServerConfig(
      profileId,
      serverId,
      {
        host: "127.0.0.1",
        port: ftp.port,
        username: `viewer${index}`,
        password: "secret",
        tlsMode: "none",
        allowInvalidCertificate: false,
        roots: ["/Movies"],
      },
      false,
    );
    const fileIds = files.map((file) => {
      media.upsertParsedFile(profileId, {
        ftpServerId: serverId,
        ftpPath: file.path,
        filename: file.filename,
        normalizedFilename: file.filename.toLowerCase(),
        extension: file.filename.split(".").pop() ?? "mkv",
        mediaKind: "movie",
        parsedTitle: file.filename.split(".").slice(0, -3).join(" ").toLowerCase(),
        parsedYear: null,
        season: null,
        episode: null,
        imdbId: null,
        quality: "1080p",
        confidence: 90,
        sizeBytes: file.size,
      });
      const row = db.prepare("select id from media_files where profile_id = ? and ftp_path = ?").get(profileId, file.path) as { id: number };
      return row.id;
    });
    viewerTokens.push({ token: installUrlToken, fileIds });
  }

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  // The public build has no proxy stream tracker; the FTP-side counters and open HTTP connections cover leaks.
  const activeStreams = async () => 0;

  return { options, tmpDir, db, ftp, httpServer, shutdownApp: app.shutdown, port, slots, activeStreams, files, viewerTokens, loginErrors, logs };
}

const VIEWER_PASSPHRASE = "stress-passphrase";

function viewerBrowserUid(index: number) {
  return `stress-viewer-${index}-browser`;
}

// One-shot request without keep-alive, so polling never holds an HTTP connection open.
class SlotCounter {
  private readonly perUser = new Map<string, number>();
  maxPerUser = 0;

  acquire(user: string) {
    const next = (this.perUser.get(user) ?? 0) + 1;
    this.perUser.set(user, next);
    this.maxPerUser = Math.max(this.maxPerUser, next);
  }

  release(user: string) {
    const next = (this.perUser.get(user) ?? 0) - 1;
    if (next <= 0) this.perUser.delete(user);
    else this.perUser.set(user, next);
  }

  forUser(user: string) {
    return this.perUser.get(user) ?? 0;
  }

  total() {
    let total = 0;
    for (const count of this.perUser.values()) total += count;
    return total;
  }
}

async function stopEnvironment(env: Environment) {
  await env.shutdownApp();
  env.httpServer.closeAllConnections();
  await new Promise<void>((resolve) => env.httpServer.close(() => resolve()));
  await env.ftp.close();
  env.db.close();
  rmSync(env.tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Log capture: the proxy logs one JSON line per request; those become per-scenario outcome counts.

class LogCollector {
  proxyOutcomes = new Map<string, number>();
  ftpEvents = new Map<string, number>();
  appErrors = new Map<string, number>();
  private originals: Partial<Record<"log" | "info" | "warn" | "error", (...args: unknown[]) => void>> = {};

  install() {
    for (const level of ["log", "info", "warn", "error"] as const) {
      this.originals[level] = console[level];
      console[level] = (...args: unknown[]) => this.capture(level, args);
    }
  }

  restore() {
    for (const level of ["log", "info", "warn", "error"] as const) {
      const original = this.originals[level];
      if (original) console[level] = original;
    }
  }

  reset() {
    this.proxyOutcomes.clear();
    this.ftpEvents.clear();
    this.appErrors.clear();
  }

  private capture(level: string, args: unknown[]) {
    const [label, payload] = args;
    if (label === "[proxy-timing]" && typeof payload === "string") {
      const parsed = JSON.parse(payload) as { method: string; outcome: string };
      increment(this.proxyOutcomes, `${parsed.method} ${parsed.outcome}`);
      return;
    }
    if (label === "[proxy-ftp-timing]" && typeof payload === "string") {
      increment(this.ftpEvents, (JSON.parse(payload) as { event: string }).event);
      return;
    }
    const text = args
      .map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    increment(this.appErrors, `${level}: ${text.split("\n")[0].slice(0, 160)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP client that behaves like a player: keep-alive agent, Range requests, verifies every byte.

type RunContext = {
  env: Environment;
  report: ScenarioReport;
  results: RequestResult[];
  deadline: number;
};

function rangeHeader(range: RangeSpec) {
  switch (range.kind) {
    case "none":
      return null;
    case "open":
      return `bytes=${range.start}-`;
    case "bounded":
      return `bytes=${range.start}-${range.end}`;
    case "suffix":
      return `bytes=-${range.length}`;
  }
}

function expectedWindow(range: RangeSpec, size: number) {
  switch (range.kind) {
    case "none":
      return { status: 200, start: 0, end: size - 1 };
    case "open":
      return { status: 206, start: range.start, end: size - 1 };
    case "bounded":
      return { status: 206, start: range.start, end: Math.min(range.end, size - 1) };
    case "suffix":
      return { status: 206, start: size - Math.min(range.length, size), end: size - 1 };
  }
}

function headerProblem(plan: RequestPlan, file: StressFile, response: http.IncomingMessage) {
  const expected = expectedWindow(plan.range, file.size);
  const length = expected.end - expected.start + 1;
  if (response.statusCode !== expected.status) return `status ${response.statusCode}, expected ${expected.status}`;
  if (response.headers["accept-ranges"] !== "bytes") return `accept-ranges ${response.headers["accept-ranges"]}`;
  if (response.headers["content-length"] !== String(length)) return `content-length ${response.headers["content-length"]}, expected ${length}`;
  const contentRange = response.headers["content-range"];
  if (expected.status === 206 && contentRange !== `bytes ${expected.start}-${expected.end}/${file.size}`) {
    return `content-range ${contentRange}, expected bytes ${expected.start}-${expected.end}/${file.size}`;
  }
  if (expected.status === 200 && contentRange !== undefined) return `unexpected content-range ${contentRange}`;
  if (!response.headers["content-type"]) return "missing content-type";
  return null;
}

function startRequest(ctx: RunContext, plan: RequestPlan): ActiveRequest {
  const { env } = ctx;
  const file = env.files[plan.fileIndex];
  const startedAt = performance.now();
  const result: RequestResult = { plan, status: null, outcome: "request_error", headersMs: null, ttfbMs: null, bytes: 0, durationMs: 0 };
  let settled = false;
  let closingByClient = false;
  let watchdog: NodeJS.Timeout | null = null;
  let pauseTimer: NodeJS.Timeout | null = null;
  let lastActivityAt = startedAt;
  let resolveResult!: (value: RequestResult) => void;
  const promise = new Promise<RequestResult>((resolve) => {
    resolveResult = resolve;
  });

  const describe = () =>
    `viewer ${plan.viewer.index} ${plan.method} ${plan.label} ${rangeHeader(plan.range) ?? "(no range)"} on ${file.filename}`;

  const finish = (outcome: RequestOutcome, error?: string) => {
    if (settled) return;
    settled = true;
    if (watchdog) clearTimeout(watchdog);
    if (pauseTimer) clearTimeout(pauseTimer);
    result.outcome = outcome;
    if (error) result.error = error;
    result.durationMs = performance.now() - startedAt;
    ctx.results.push(result);
    resolveResult(result);
  };

  const violation = (outcome: RequestOutcome, message: string) => {
    ctx.report.violations.push(`${message} (${describe()})`);
    closingByClient = true;
    finish(outcome, message);
    request.destroy();
  };

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      violation("hang", `no progress for ${Math.round(env.options.hangTimeoutMs / 1000)} s`);
    }, env.options.hangTimeoutMs);
  };
  const disarmWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };

  if (plan.method === "GET" && env.slots.forUser(`viewer${plan.viewer.index}`) >= env.options.ftpMaxConnections) {
    ctx.report.queuedWaits += 1;
  }
  const header = rangeHeader(plan.range);
  const request = http.request({
    host: "127.0.0.1",
    port: env.port,
    method: plan.method,
    path: `/proxy/${plan.viewer.token}/${plan.viewer.fileIds[plan.fileIndex]}`,
    agent: plan.viewer.agent,
    headers: { "user-agent": "stress-playback", ...(header ? { range: header } : {}) },
  });

  request.on("error", (error) => {
    if (closingByClient || settled) return;
    finish("request_error", error.message);
  });

  request.on("response", (response) => {
    result.status = response.statusCode ?? null;
    result.headersMs = performance.now() - startedAt;
    lastActivityAt = performance.now();
    armWatchdog();
    response.on("error", () => undefined);

    if (response.statusCode !== 200 && response.statusCode !== 206) {
      if (response.statusCode === 404 || response.statusCode === 416) {
        violation("bad_headers", `unexpected status ${response.statusCode}`);
        return;
      }
      response.resume();
      response.once("end", () => finish("status_error", `status ${response.statusCode}`));
      response.once("close", () => finish("status_error", `status ${response.statusCode}`));
      return;
    }

    const problem = headerProblem(plan, file, response);
    if (problem) {
      violation("bad_headers", `bad headers: ${problem}`);
      return;
    }

    const window = expectedWindow(plan.range, file.size);
    const expectedLength = plan.method === "HEAD" ? 0 : window.end - window.start + 1;
    let position = window.start;
    let longPauseDone = false;

    response.on("data", (chunk: Buffer) => {
      if (settled) return;
      const now = performance.now();
      result.ttfbMs ??= now - startedAt;
      lastActivityAt = now;
      const mismatch = firstPatternMismatch(file.seed, position, chunk);
      if (mismatch >= 0) {
        violation("bad_bytes", `wrong byte at file offset ${position + mismatch}`);
        return;
      }
      position += chunk.length;
      result.bytes += chunk.length;
      if (result.bytes > expectedLength) {
        violation("bad_bytes", `received ${result.bytes} bytes, more than content-length ${expectedLength}`);
        return;
      }
      if (plan.readLimit !== undefined && result.bytes >= plan.readLimit && result.bytes < expectedLength) {
        closingByClient = true;
        finish("aborted");
        request.destroy();
        return;
      }

      let pauseMs = 0;
      if (plan.bytesPerSec) pauseMs = (chunk.length / plan.bytesPerSec) * 1000;
      if (plan.longPause && !longPauseDone && result.bytes >= plan.longPause.afterBytes) {
        longPauseDone = true;
        pauseMs = plan.longPause.ms;
      }
      if (pauseMs >= 1) {
        response.pause();
        disarmWatchdog();
        pauseTimer = setTimeout(() => {
          pauseTimer = null;
          if (settled) return;
          lastActivityAt = performance.now();
          armWatchdog();
          response.resume();
        }, pauseMs);
      } else {
        armWatchdog();
      }
    });

    response.once("end", () => {
      if (settled) return;
      if (result.bytes !== expectedLength) {
        violation("bad_bytes", `body ended after ${result.bytes} of ${expectedLength} bytes`);
        return;
      }
      finish("complete");
    });

    response.once("close", () => {
      if (settled || closingByClient) return;
      if (!response.complete) {
        result.silentBeforeCloseMs = performance.now() - lastActivityAt;
        finish("premature_close", "connection closed before the body was complete");
      }
    });
  });

  request.end();
  armWatchdog();

  return {
    promise,
    cancel: () => {
      if (settled) return;
      closingByClient = true;
      finish("cancelled");
      request.destroy();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Scenario building blocks

function randomInt(rng: () => number, min: number, max: number) {
  return min + Math.floor(rng() * (max - min + 1));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSeekStart(rng: () => number, size: number) {
  // Mostly mid-file; sometimes within the last few MB so a seek can run into end of file.
  if (rng() < 0.08) return size - randomInt(rng, 1, 3 * MB);
  return randomInt(rng, 0, size - 5 * MB);
}

function seekPlan(viewer: Viewer, fileIndex: number, size: number, label: string, readLimit: number): RequestPlan {
  return { method: "GET", viewer, fileIndex, range: { kind: "open", start: randomSeekStart(viewer.rng, size) }, readLimit, label };
}

function boundedPlan(viewer: Viewer, fileIndex: number, size: number, label: string, minBytes: number, maxBytes: number): RequestPlan {
  const length = randomInt(viewer.rng, minBytes, maxBytes);
  const start = randomInt(viewer.rng, 0, size - length);
  return { method: "GET", viewer, fileIndex, range: { kind: "bounded", start, end: start + length - 1 }, label };
}

async function seek(ctx: RunContext, viewer: Viewer, fileIndex: number) {
  const size = ctx.env.files[fileIndex].size;
  return startRequest(ctx, seekPlan(viewer, fileIndex, size, "seek", randomInt(viewer.rng, MB / 2, 4 * MB))).promise;
}

// A player scrubbing: five seeks within ~100 ms, each new request issued before the previous one is dropped.
async function seekBurst(ctx: RunContext, viewer: Viewer, fileIndex: number) {
  const size = ctx.env.files[fileIndex].size;
  const pending: Array<Promise<RequestResult>> = [];
  let previous: ActiveRequest | null = null;
  for (let index = 0; index < 5; index += 1) {
    const last = index === 4;
    const next = startRequest(ctx, seekPlan(viewer, fileIndex, size, last ? "burst-final" : "burst", last ? randomInt(viewer.rng, MB / 2, 4 * MB) : 64 * MB));
    previous?.cancel();
    previous = next;
    pending.push(next.promise);
    if (!last) await sleep(randomInt(viewer.rng, 10, 25));
  }
  await Promise.all(pending);
}

async function head(ctx: RunContext, viewer: Viewer, fileIndex: number, withRange: boolean) {
  const size = ctx.env.files[fileIndex].size;
  const range: RangeSpec = withRange ? { kind: "open", start: randomInt(viewer.rng, 0, size - 1) } : { kind: "none" };
  return startRequest(ctx, { method: "HEAD", viewer, fileIndex, range, label: "head" }).promise;
}

async function scenarioA(ctx: RunContext, viewer: Viewer) {
  while (performance.now() < ctx.deadline) {
    const fileIndex = viewer.index % ctx.env.files.length;
    const size = ctx.env.files[fileIndex].size;
    await head(ctx, viewer, fileIndex, false);
    const tailStart = size - randomInt(viewer.rng, 256 * 1024, 2 * MB);
    await Promise.all([
      startRequest(ctx, { method: "GET", viewer, fileIndex, range: { kind: "open", start: 0 }, readLimit: randomInt(viewer.rng, 2 * MB, 4 * MB), label: "start" }).promise,
      startRequest(ctx, { method: "GET", viewer, fileIndex, range: { kind: "open", start: tailStart }, label: "tail" }).promise,
      startRequest(ctx, boundedPlan(viewer, fileIndex, size, "bounded", MB, 2 * MB)).promise,
    ]);
    await sleep(randomInt(viewer.rng, 100, 300));
  }
}

// Rounds of 30-50 back-to-back seeks per viewer, repeated until the scenario deadline.
async function scenarioB(ctx: RunContext, viewer: Viewer) {
  do {
    const seeks = randomInt(viewer.rng, 30, 50);
    for (let index = 0; index < seeks && performance.now() < ctx.deadline; index += 1) {
      const fileIndex = (viewer.index + (viewer.rng() < 0.2 ? 1 : 0)) % ctx.env.files.length;
      if (viewer.rng() < 0.15) await seekBurst(ctx, viewer, fileIndex);
      else await seek(ctx, viewer, fileIndex);
    }
    await sleep(randomInt(viewer.rng, 50, 250));
  } while (performance.now() < ctx.deadline);
}

async function scenarioC(ctx: RunContext, viewer: Viewer) {
  const slow = viewer.index % 2 === 1;
  const bytesPerSec = () => (slow ? randomInt(viewer.rng, MB, 4 * MB) : undefined);
  if (viewer.index === 0 && ctx.env.options.longPause) {
    // A paused player: the socket stops being read for longer than the FTP timeout, then resumes.
    const size = ctx.env.files[0].size;
    const start = randomInt(viewer.rng, 0, size - 16 * MB);
    const result = await startRequest(ctx, {
      method: "GET",
      viewer,
      fileIndex: 0,
      range: { kind: "bounded", start, end: start + 8 * MB - 1 },
      longPause: { afterBytes: MB, ms: ctx.env.options.ftpTimeoutMs + 3_000 },
      label: "long-pause",
    }).promise;
    // A failure is tallied as a known issue (see runScenario), not as an invariant violation.
    if (result.outcome === "complete") ctx.report.notes.push("paused reader resumed and completed its range");
  }
  while (performance.now() < ctx.deadline) {
    const fileIndex = randomInt(viewer.rng, 0, ctx.env.files.length - 1);
    const size = ctx.env.files[fileIndex].size;
    const pick = viewer.rng();
    let plan: RequestPlan;
    if (pick < 0.6) plan = boundedPlan(viewer, fileIndex, size, "bounded", MB / 2, 3 * MB);
    else if (pick < 0.75) plan = { method: "GET", viewer, fileIndex, range: { kind: "suffix", length: randomInt(viewer.rng, 64 * 1024, 2 * MB) }, label: "suffix" };
    else if (pick < 0.9) plan = { method: "GET", viewer, fileIndex, range: { kind: "open", start: size - randomInt(viewer.rng, MB / 2, 2 * MB) }, label: "tail" };
    else {
      const start = size - randomInt(viewer.rng, 64 * 1024, MB);
      plan = { method: "GET", viewer, fileIndex, range: { kind: "bounded", start, end: size + 1000 }, label: "past-eof" };
    }
    plan.bytesPerSec = bytesPerSec();
    await startRequest(ctx, plan).promise;
  }
}

async function scenarioD(ctx: RunContext, viewer: Viewer) {
  while (performance.now() < ctx.deadline) {
    const fileIndex = randomInt(viewer.rng, 0, ctx.env.files.length - 1);
    const size = ctx.env.files[fileIndex].size;
    const pick = viewer.rng();
    if (pick < 0.45) await seek(ctx, viewer, fileIndex);
    else if (pick < 0.55) await seekBurst(ctx, viewer, fileIndex);
    else if (pick < 0.65) await head(ctx, viewer, fileIndex, viewer.rng() < 0.5);
    else await startRequest(ctx, boundedPlan(viewer, fileIndex, size, "bounded", 256 * 1024, 3 * MB)).promise;
  }
}

async function scenarioE(ctx: RunContext, viewer: Viewer) {
  while (performance.now() < ctx.deadline) {
    const heads: Array<Promise<RequestResult>> = [];
    const count = randomInt(viewer.rng, 3, 8);
    for (let index = 0; index < count; index += 1) {
      heads.push(head(ctx, viewer, randomInt(viewer.rng, 0, ctx.env.files.length - 1), viewer.rng() < 0.3));
      await sleep(randomInt(viewer.rng, 0, 30));
    }
    await Promise.all(heads);
    const fileIndex = randomInt(viewer.rng, 0, ctx.env.files.length - 1);
    const size = ctx.env.files[fileIndex].size;
    if (viewer.rng() < 0.5) await seek(ctx, viewer, fileIndex);
    else await startRequest(ctx, boundedPlan(viewer, fileIndex, size, "bounded", MB / 2, 2 * MB)).promise;
    await sleep(randomInt(viewer.rng, 50, 200));
  }
}

const SCENARIOS: Record<ScenarioName, (ctx: RunContext, viewer: Viewer) => Promise<void>> = {
  A: scenarioA,
  B: scenarioB,
  C: scenarioC,
  D: scenarioD,
  E: scenarioE,
};

// ---------------------------------------------------------------------------------------------
// Scenario runner and invariants

function isPlaybackFailure(result: RequestResult) {
  if (result.plan.method !== "GET") return false;
  if (result.outcome === "complete" || result.outcome === "aborted" || result.outcome === "cancelled") return false;
  // Cancelled burst requests never count; everything else that did not deliver is a failed playback request.
  return true;
}

async function runScenario(env: Environment, name: ScenarioName, scenarioIndex: number): Promise<ScenarioReport> {
  const { options } = env;
  const report: ScenarioReport = {
    name,
    title: SCENARIO_TITLES[name],
    ftpMaxConnections: options.ftpMaxConnections,
    durationMs: 0,
    requests: 0,
    outcomes: {},
    playbackFailures: 0,
    playbackFailuresByLabel: {},
    ttfb: { p50: null, p95: null, max: null, samples: 0 },
    head: { p50: null, p95: null, samples: 0 },
    queuedWaits: 0,
    maxSlotsPerUser: 0,
    maxServerSessionsPerUser: 0,
    server: { ...env.ftp.stats },
    proxyOutcomes: {},
    ftpEvents: {},
    loginErrors: {},
    appErrors: {},
    slowFailures: 0,
    quiesceMs: null,
    memory: { heapMB: 0, rssMB: 0 },
    violations: [],
    notes: [],
    knownIssues: [],
  };
  env.ftp.resetStats();
  env.ftp.faults = name === "D" ? { ...options.faults } : { ...NO_FAULTS };
  env.logs.reset();
  env.loginErrors.clear();
  env.slots.maxPerUser = 0;

  const viewers: Viewer[] = env.viewerTokens.map((viewer, index) => ({
    index,
    token: viewer.token,
    fileIds: viewer.fileIds,
    agent: new http.Agent({ keepAlive: true, maxSockets: 8 }),
    rng: seededRandom(options.seed * 1000 + scenarioIndex * 100 + index),
  }));
  const startedAt = performance.now();
  const ctx: RunContext = { env, report, results: [], deadline: startedAt + options.scenarioMs };

  // A viewer loop that is still running long after its deadline means a request never settled.
  const scenarioLimitMs = options.scenarioMs + options.hangTimeoutMs + options.ftpTimeoutMs + 10_000;
  let limitTimer: NodeJS.Timeout | null = null;
  const finished = await Promise.race([
    Promise.all(viewers.map((viewer) => SCENARIOS[name](ctx, viewer))).then(() => true),
    new Promise<boolean>((resolve) => {
      limitTimer = setTimeout(() => resolve(false), scenarioLimitMs);
    }),
  ]);
  if (limitTimer) clearTimeout(limitTimer);
  if (!finished) report.violations.push(`scenario did not finish within ${Math.round(scenarioLimitMs / 1000)} s`);
  env.ftp.faults = { ...NO_FAULTS };
  report.maxSlotsPerUser = env.slots.maxPerUser;
  report.durationMs = performance.now() - startedAt;
  for (const viewer of viewers) viewer.agent.destroy();

  // Invariant: once every client is gone, nothing stays open or queued anywhere.
  const quiesceStartedAt = performance.now();
  let state = await pipelineState(env);
  while (!isQuiet(state) && performance.now() - quiesceStartedAt < options.quiesceTimeoutMs) {
    await sleep(50);
    state = await pipelineState(env);
  }
  if (isQuiet(state)) report.quiesceMs = performance.now() - quiesceStartedAt;
  else report.violations.push(`not quiet ${Math.round(options.quiesceTimeoutMs / 1000)} s after clients left: ${JSON.stringify(state)}`);

  // Tally results.
  const ttfb: number[] = [];
  const headMs: number[] = [];
  for (const result of ctx.results) {
    report.requests += 1;
    increment(report.outcomes, `${result.plan.method} ${result.outcome}`);
    if (result.plan.method === "GET" && result.ttfbMs !== null) ttfb.push(result.ttfbMs);
    if (result.plan.method === "HEAD" && result.headersMs !== null && result.outcome === "complete") headMs.push(result.headersMs);
    if (isPlaybackFailure(result) && result.plan.label === "long-pause") {
      report.knownIssues.push(
        `paused reader lost its stream: ${result.outcome} after ${(result.bytes / MB).toFixed(1)} of 8 MB ` +
          `(pause ${Math.round((options.ftpTimeoutMs + 3_000) / 1000)} s > FTP_TIMEOUT_MS)`,
      );
    } else if (isPlaybackFailure(result)) {
      report.playbackFailures += 1;
      increment(report.playbackFailuresByLabel, result.plan.label);
      if ((result.silentBeforeCloseMs ?? 0) > 3_000) report.slowFailures += 1;
    }
  }
  report.ttfb = { ...percentiles(ttfb), max: ttfb.length ? Math.max(...ttfb) : null, samples: ttfb.length };
  const headStats = percentiles(headMs);
  report.head = { p50: headStats.p50, p95: headStats.p95, samples: headMs.length };
  report.server = { ...env.ftp.stats };
  report.maxServerSessionsPerUser = env.ftp.stats.maxSessionsPerUser;
  report.proxyOutcomes = Object.fromEntries(env.logs.proxyOutcomes);
  report.ftpEvents = Object.fromEntries(env.logs.ftpEvents);
  report.loginErrors = Object.fromEntries(env.loginErrors);
  report.appErrors = Object.fromEntries(env.logs.appErrors);

  // Without injected faults, a failed playback request is only acceptable if the FTP server refused a login
  // because the user was over its session cap (a configuration mismatch that the report calls out).
  if (name !== "D" && report.playbackFailures > 0 && report.server.loginsRejectedOverCap === 0) {
    report.violations.push(`${report.playbackFailures} playback request(s) failed without any FTP fault or cap rejection`);
  }
  if (report.server.loginsRejectedOverCap > 0) {
    report.notes.push(
      `FTP server refused ${report.server.loginsRejectedOverCap} login(s) with 530 because the user already had ${options.serverUserCap} session(s)`,
    );
  }
  if (report.slowFailures > 0) report.notes.push(`${report.slowFailures} failure(s) went silent for more than 3 s before the connection closed`);

  // Invariant: no slot or queue position leaked. Every viewer can immediately use all of its slots again.
  // Runs after the tally so the probe's own traffic stays out of the scenario numbers.
  await probeSlots(env, report);

  report.memory = measureMemory();
  return report;
}

type PipelineState = {
  ftpControl: number;
  ftpData: number;
  ftpPassive: number;
  ftpCountedSessions: number;
  ftpSlots: number;
  activeStreams: number;
  httpConnections: number;
};

async function pipelineState(env: Environment): Promise<PipelineState> {
  const httpConnections = await new Promise<number>((resolve) => env.httpServer.getConnections((_error, count) => resolve(count)));
  return {
    ftpControl: env.ftp.openControlCount(),
    ftpData: env.ftp.openDataCount(),
    ftpPassive: env.ftp.pendingPassiveCount(),
    ftpCountedSessions: env.ftp.countedSessions(),
    ftpSlots: env.slots.total(),
    activeStreams: await env.activeStreams(),
    httpConnections,
  };
}

function isQuiet(state: PipelineState) {
  return (
    state.ftpControl === 0 &&
    state.ftpData === 0 &&
    state.ftpPassive === 0 &&
    state.ftpCountedSessions === 0 &&
    state.ftpSlots === 0 &&
    state.activeStreams === 0 &&
    state.httpConnections === 0
  );
}

async function probeSlots(env: Environment, report: ScenarioReport) {
  const { options } = env;
  const perViewer = options.serverUserCap > 0 ? Math.min(options.ftpMaxConnections, options.serverUserCap) : options.ftpMaxConnections;
  const probeReport: ScenarioReport = { ...report, violations: [] };
  const ctx: RunContext = { env, report: probeReport, results: [], deadline: 0 };
  const agents: http.Agent[] = [];
  const pending: Array<Promise<RequestResult>> = [];
  const startedAt = performance.now();
  env.viewerTokens.forEach((viewer, index) => {
    const agent = new http.Agent({ keepAlive: false, maxSockets: perViewer });
    agents.push(agent);
    const probeViewer: Viewer = { index, token: viewer.token, fileIds: viewer.fileIds, agent, rng: seededRandom(index + 7) };
    for (let slot = 0; slot < perViewer; slot += 1) {
      const start = slot * MB;
      pending.push(
        startRequest(ctx, { method: "GET", viewer: probeViewer, fileIndex: slot % env.files.length, range: { kind: "bounded", start, end: start + 256 * 1024 - 1 }, label: "probe" }).promise,
      );
    }
  });
  const results = await Promise.all(pending);
  for (const agent of agents) agent.destroy();
  const failed = results.filter((result) => result.outcome !== "complete");
  const slowest = Math.max(...results.map((result) => result.durationMs));
  report.violations.push(...probeReport.violations);
  if (failed.length) {
    report.violations.push(`slot probe: ${failed.length} of ${results.length} requests failed (${failed.map((result) => result.outcome).join(", ")})`);
  } else if (slowest > 5_000) {
    report.violations.push(`slot probe: slowest of ${results.length} parallel requests took ${Math.round(slowest)} ms (leaked slot or queue entry?)`);
  }
  // Let the probe's own FTP sessions close before the next scenario.
  let state = await pipelineState(env);
  while (!isQuiet(state) && performance.now() - startedAt < options.quiesceTimeoutMs) {
    await sleep(50);
    state = await pipelineState(env);
  }
  if (!isQuiet(state)) report.violations.push(`not quiet after the slot probe: ${JSON.stringify(state)}`);
}

// ---------------------------------------------------------------------------------------------
// Entry point

let gcFunction: (() => void) | null = null;

function measureMemory() {
  if (!gcFunction) {
    const exposed = (globalThis as { gc?: () => void }).gc;
    if (exposed) gcFunction = exposed;
    else {
      setFlagsFromString("--expose-gc");
      gcFunction = runInNewContext("gc") as () => void;
    }
  }
  gcFunction();
  gcFunction();
  const usage = process.memoryUsage();
  return { heapMB: round1(usage.heapUsed / MB), rssMB: round1(usage.rss / MB) };
}

export async function runPlaybackStress(options: HarnessOptions): Promise<HarnessReport> {
  const processViolations: string[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    processViolations.push(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  };
  const onUncaughtException = (error: Error) => {
    processViolations.push(`uncaughtException: ${error.stack ?? error.message}`);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  const logs = new LogCollector();
  logs.install();
  const reportedOptions: Partial<HarnessOptions> = { ...options };
  delete reportedOptions.log;
  const report: HarnessReport = {
    options: reportedOptions as Omit<HarnessOptions, "log">,
    scenarios: [],
    memory: { baseline: { heapMB: 0, rssMB: 0 }, final: { heapMB: 0, rssMB: 0 } },
    violations: [],
    warnings: [],
  };

  let env: Environment | null = null;
  try {
    env = await startEnvironment(options, logs);
    report.memory.baseline = measureMemory();
    for (const [index, name] of options.scenarios.entries()) {
      options.log(`  scenario ${name} (FTP_MAX_CONNECTIONS=${options.ftpMaxConnections}): ${SCENARIO_TITLES[name]} ...`);
      const scenarioReport = await runScenario(env, name, index);
      scenarioReport.violations.push(...processViolations.splice(0));
      report.scenarios.push(scenarioReport);
      options.log(
        `    ${scenarioReport.violations.length ? "FAIL" : "pass"} · ${scenarioReport.requests} requests · ${scenarioReport.playbackFailures} failed playback · TTFB p50/p95 ${fmtMs(scenarioReport.ttfb.p50)}/${fmtMs(scenarioReport.ttfb.p95)}`,
      );
    }
  } finally {
    if (env) await stopEnvironment(env);
    logs.restore();
    // Late errors from teardown still count.
    await sleep(100);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  }

  report.memory.final = report.scenarios.at(-1)?.memory ?? measureMemory();
  report.violations.push(...processViolations);
  for (const scenario of report.scenarios) {
    report.violations.push(...scenario.violations.map((violation) => `[${scenario.name}] ${violation}`));
    report.warnings.push(...scenario.knownIssues.map((issue) => `[${scenario.name}] known issue: ${issue}`));
    if (scenario.server.loginsRejectedOverCap > 0) {
      report.warnings.push(
        `[${scenario.name}] ${scenario.playbackFailures} playback request(s) failed; the FTP server refused ` +
          `${scenario.server.loginsRejectedOverCap} login(s) over its ${options.serverUserCap}-session cap`,
      );
    }
  }

  // Memory: compare the end of the first scenario (pools and JIT warmed up) with the end of the run.
  const first = report.scenarios[0]?.memory;
  if (first && report.scenarios.length > 1) {
    const heapGrowth = report.memory.final.heapMB - first.heapMB;
    const rssGrowth = report.memory.final.rssMB - first.rssMB;
    if (heapGrowth > 50) report.violations.push(`heap grew ${heapGrowth.toFixed(1)} MB across scenarios`);
    if (rssGrowth > 50) report.warnings.push(`RSS grew ${rssGrowth.toFixed(1)} MB across scenarios (heap ${heapGrowth.toFixed(1)} MB)`);
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Helpers

function increment(target: Map<string, number> | Record<string, number>, key: string) {
  if (target instanceof Map) target.set(key, (target.get(key) ?? 0) + 1);
  else target[key] = (target[key] ?? 0) + 1;
}

function percentiles(values: number[]) {
  if (!values.length) return { p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { p50: at(0.5), p95: at(0.95) };
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

export function fmtMs(value: number | null) {
  return value === null ? "-" : `${Math.round(value)}ms`;
}
