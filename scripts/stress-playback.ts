// Playback stress/soak harness. Runs the real app stack against an in-process fake FTP server and
// exits non-zero on any invariant violation (crash, unhandled rejection, hang, wrong bytes or headers,
// leaked FTP connections/slots/streams, or heap growth over 50 MB).
//
//   npx tsx scripts/stress-playback.ts [options]
//
//   --viewers=10              viewers; each is its own profile and FTP user
//   --duration=10             seconds per scenario
//   --caps=3                  app FTP_MAX_CONNECTIONS values to run (comma list, fresh app per value)
//   --scenarios=A,B,C,D,E     A start-up concurrency, B rapid skipping, C slow consumers,
//                             D FTP faults, E HEAD storms
//   --server-user-cap=3       fake FTP server: max sessions per user (530 beyond it; 0 = unlimited)
//   --release-lag-ms=0        fake FTP server: a closed session keeps counting this long
//   --latency-ms=0            fake FTP server: delay added to every control reply
//   --ftp-timeout-ms=15000    app FTP_TIMEOUT_MS
//   --pool-idle-ms=2000       app FTP_POOL_IDLE_MS (0 turns pooling off); the "quiet" checks wait this out
//   --login-failure-cache-ms=1000  app FTP_LOGIN_FAILURE_CACHE_MS (how long a 530 fails fast)
//   --file-mb=256             size of the generated files
//   --seed=1                  PRNG seed for request plans and faults
//   --no-long-pause           skip the paused-reader check in scenario C
//   --json=path               also write the full report as JSON

import { writeFileSync } from "node:fs";
import {
  defaultHarnessOptions,
  fmtMs,
  runPlaybackStress,
  type HarnessReport,
  type ScenarioName,
  type ScenarioReport,
} from "./stress/playbackHarness";

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    args.set(match[1], match[2] ?? "true");
  }
  return args;
}

function numberArg(args: Map<string, string>, key: string, fallback: number) {
  const raw = args.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} must be a non-negative number`);
  return value;
}

const args = parseArgs(process.argv.slice(2));
const caps = (args.get("caps") ?? "3").split(",").map((value) => Number(value.trim()));
const scenarios = (args.get("scenarios") ?? "A,B,C,D,E").split(",").map((value) => value.trim().toUpperCase()) as ScenarioName[];
for (const scenario of scenarios) {
  if (!["A", "B", "C", "D", "E"].includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
}
const out = (line = "") => process.stdout.write(`${line}\n`);

const reports: HarnessReport[] = [];
const runStartedAt = Date.now();
for (const cap of caps) {
  const options = defaultHarnessOptions({
    viewers: numberArg(args, "viewers", 10),
    scenarioMs: numberArg(args, "duration", 10) * 1000,
    ftpMaxConnections: cap,
    serverUserCap: numberArg(args, "server-user-cap", 3),
    releaseLagMs: numberArg(args, "release-lag-ms", 0),
    latencyMs: numberArg(args, "latency-ms", 0),
    ftpTimeoutMs: numberArg(args, "ftp-timeout-ms", 15_000),
    poolIdleMs: numberArg(args, "pool-idle-ms", 2_000),
    loginFailureCacheMs: numberArg(args, "login-failure-cache-ms", 1_000),
    fileSizeBytes: numberArg(args, "file-mb", 256) * 1024 * 1024,
    seed: numberArg(args, "seed", 1),
    scenarios,
    longPause: !args.has("no-long-pause"),
    log: out,
  });
  out(
    `Run: FTP_MAX_CONNECTIONS=${cap}, ${options.viewers} viewers (one FTP user each), FTP server cap ${options.serverUserCap}/user, ` +
      `release lag ${options.releaseLagMs} ms, reply latency ${options.latencyMs} ms, FTP_TIMEOUT_MS=${options.ftpTimeoutMs}, FTP_POOL_IDLE_MS=${options.poolIdleMs}, plain FTP (no TLS)`,
  );
  const report = await runPlaybackStress(options);
  reports.push(report);
  printReport(report);
}

const violations = reports.flatMap((report) => report.violations.map((violation) => `cap ${report.options.ftpMaxConnections}: ${violation}`));
const warnings = reports.flatMap((report) => report.warnings.map((warning) => `cap ${report.options.ftpMaxConnections}: ${warning}`));
out();
out(`Finished in ${Math.round((Date.now() - runStartedAt) / 1000)} s.`);
for (const warning of warnings) out(`WARNING ${warning}`);
if (violations.length) {
  out(`FAILED: ${violations.length} invariant violation(s)`);
  for (const violation of violations.slice(0, 40)) out(`  - ${violation}`);
  if (violations.length > 40) out(`  ... ${violations.length - 40} more`);
} else {
  out("PASSED: no invariant violations");
}
const jsonPath = args.get("json");
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(reports, null, 2));
process.exit(violations.length ? 1 : 0);

function printReport(report: HarnessReport) {
  out();
  for (const scenario of report.scenarios) printScenario(scenario);
  out(
    `  memory (after GC): baseline heap ${report.memory.baseline.heapMB} MB / RSS ${report.memory.baseline.rssMB} MB -> ` +
      `final heap ${report.memory.final.heapMB} MB / RSS ${report.memory.final.rssMB} MB ` +
      `(after first scenario: heap ${report.scenarios[0]?.memory.heapMB ?? "-"} MB)`,
  );
  out();
}

function printScenario(scenario: ScenarioReport) {
  const status = scenario.violations.length ? "FAIL" : "pass";
  out(`  [${scenario.name}] ${status} - ${scenario.title}`);
  out(
    `      ${scenario.requests} requests in ${(scenario.durationMs / 1000).toFixed(1)} s; ` +
      `GET TTFB p50 ${fmtMs(scenario.ttfb.p50)} p95 ${fmtMs(scenario.ttfb.p95)} max ${fmtMs(scenario.ttfb.max)} (${scenario.ttfb.samples}); ` +
      `HEAD p50 ${fmtMs(scenario.head.p50)} p95 ${fmtMs(scenario.head.p95)} (${scenario.head.samples})`,
  );
  out(`      client outcomes: ${formatCounts(scenario.outcomes)}`);
  out(
    `      failed playback requests: ${scenario.playbackFailures}${scenario.playbackFailures ? ` (${formatCounts(scenario.playbackFailuresByLabel)})` : ""}; ` +
      `GETs that queued for a slot ${scenario.queuedWaits}, max FTP slots per user ${scenario.maxSlotsPerUser}; ` +
      `quiet after ${scenario.quiesceMs === null ? "never" : `${Math.round(scenario.quiesceMs)} ms`}`,
  );
  const server = scenario.server;
  out(
    `      FTP server: ${server.loginsAccepted} logins ok, ${server.loginsRejectedOverCap} refused over cap, ${server.loginsRejectedInjected} injected 530, ` +
      `max ${server.maxSessionsPerUser} sessions/user, ${server.transfersStarted} transfers (${server.transfersCompleted} completed, ` +
      `${server.transfersClosedByClient} closed by client), faults: ${server.dataDrops} data drops, ${server.controlDrops} control drops, ` +
      `${server.stalls} stalls, ${server.delayedReplies} delayed replies; ${(server.bytesSent / 1024 / 1024).toFixed(0)} MB sent`,
  );
  out(`      proxy outcomes: ${formatCounts(scenario.proxyOutcomes)}`);
  if (Object.keys(scenario.ftpEvents).length) out(`      proxy FTP events: ${formatCounts(scenario.ftpEvents)}`);
  if (Object.keys(scenario.loginErrors).length) out(`      FTP login errors: ${formatCounts(scenario.loginErrors)}`);
  if (Object.keys(scenario.appErrors).length) out(`      app log lines: ${formatCounts(scenario.appErrors, 6)}`);
  out(`      memory after: heap ${scenario.memory.heapMB} MB, RSS ${scenario.memory.rssMB} MB`);
  for (const note of scenario.notes) out(`      note: ${note}`);
  for (const violation of scenario.violations.slice(0, 10)) out(`      VIOLATION: ${violation}`);
  if (scenario.violations.length > 10) out(`      ... ${scenario.violations.length - 10} more violations`);
}

function formatCounts(counts: Record<string, number>, limit = 12) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, limit).map(([key, value]) => `${key} ${value}`);
  if (entries.length > limit) shown.push(`+${entries.length - limit} more`);
  return shown.join(", ") || "none";
}
