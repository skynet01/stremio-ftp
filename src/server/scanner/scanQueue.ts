import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { crawlProfileRoot, isScanCancelledError, ScanCancelledError, type CrawlProgress } from "../ftp/crawler.js";
import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { ProfileService } from "../profiles/profileService.js";

const MAX_ESTIMATED_SECONDS_REMAINING = 24 * 60 * 60;
const SCAN_JOB_ROW_ERROR = "Invalid scan job row";

export type ScanTrigger = "manual" | "scheduled";
export type ScanJobStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type ProfileScanStatus = {
  id: number | null;
  status: ScanJobStatus;
  trigger: ScanTrigger | null;
  progressPercent: number;
  entriesSeen: number;
  filesSeen: number;
  directoriesSeen: number;
  currentPath: string | null;
  estimatedSecondsRemaining: number | null;
  message: string | null;
  error: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  mediaItems: number;
};

type ScanJobRow = {
  id: number;
  profile_id: number;
  ftp_server_id: number | null;
  status: Exclude<ScanJobStatus, "idle">;
  trigger: ScanTrigger;
  progress_percent: number;
  entries_seen: number;
  files_seen: number;
  directories_seen: number;
  current_path: string | null;
  estimated_seconds_remaining: number | null;
  message: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export class ScanQueue {
  private readonly db: Database.Database;
  private activeCount = 0;
  private readonly running = new Set<number>();
  private readonly activeControllers = new Map<number, AbortController>();

  constructor(
    private readonly config: AppConfig,
    private readonly profileService: ProfileService,
    private readonly mediaRepository: MediaRepository,
    private readonly ftpClientFactory: FtpClientFactory,
  ) {
    this.db = profileService.database;
    this.recoverInterruptedJobs();
    this.pump();
  }

  enqueueProfileScan(profileId: number, trigger: ScanTrigger, ftpServerId = this.profileService.defaultFtpServerId(profileId)): ProfileScanStatus {
    const result = this.db.transaction((): ProfileScanStatus | number => {
      const active = this.activeJobForServer(profileId, ftpServerId);
      if (active) return this.rowToStatus(active);

      if (trigger === "manual") {
        const cooldownStatus = this.cooldownStatus(profileId, ftpServerId);
        if (cooldownStatus) return cooldownStatus;
      }

      const queuedCount = countFromRow(this.db.prepare("select count(*) as count from scan_jobs where status = 'queued'").get());
      if (queuedCount >= this.config.scanQueueMax) {
        return this.insertSkippedJob(profileId, ftpServerId, trigger, "Scan queue is full.");
      }

      const now = new Date().toISOString();
      const insert = this.db
        .prepare(
          `
          insert into scan_jobs (profile_id, ftp_server_id, status, trigger, progress_percent, message, queued_at)
          values (?, ?, 'queued', ?, 0, 'Waiting for scan worker.', ?)
        `,
        )
        .run(profileId, ftpServerId, trigger, now);
      return Number(insert.lastInsertRowid);
    })();

    if (typeof result !== "number") return result;
    this.pump();
    return this.getJobStatus(result);
  }

  getProfileScanStatus(profileId: number): ProfileScanStatus {
    return this.getServerScanStatus(profileId, this.profileService.defaultFtpServerId(profileId));
  }

  getServerScanStatus(profileId: number, ftpServerId: number): ProfileScanStatus {
    const row = this.db
      .prepare("select * from scan_jobs where profile_id = ? and ftp_server_id = ? order by id desc limit 1")
      .get(profileId, ftpServerId);
    const scanJob = optionalScanJobRow(row);
    if (!scanJob) {
      return {
        id: null,
        status: "idle",
        trigger: null,
        progressPercent: 0,
        entriesSeen: 0,
        filesSeen: 0,
        directoriesSeen: 0,
        currentPath: null,
        estimatedSecondsRemaining: null,
        message: null,
        error: null,
        queuedAt: null,
        startedAt: null,
        finishedAt: null,
        mediaItems: this.mediaRepository.countForServer(profileId, ftpServerId),
      };
    }
    return this.rowToStatus(scanJob);
  }

  getJobStatus(jobId: number): ProfileScanStatus {
    const row = optionalScanJobRow(this.db.prepare("select * from scan_jobs where id = ?").get(jobId));
    if (!row) throw new Error("Scan job not found");
    return this.rowToStatus(row);
  }

  cancelProfileScan(profileId: number): ProfileScanStatus {
    return this.cancelServerScan(profileId, this.profileService.defaultFtpServerId(profileId));
  }

  cancelServerScan(profileId: number, ftpServerId: number): ProfileScanStatus {
    const active = this.activeJobForServer(profileId, ftpServerId);
    if (!active) return this.getServerScanStatus(profileId, ftpServerId);

    if (active.status === "queued") {
      this.cancelJob(active.id);
      return this.getJobStatus(active.id);
    }

    this.activeControllers.get(active.id)?.abort();
    this.db
      .prepare(
        `
        update scan_jobs
        set message = 'Halting scan.'
        where id = ? and status = 'running'
      `,
      )
      .run(active.id);
    return this.getJobStatus(active.id);
  }

  enqueueDueScheduledScans(nowIso = new Date().toISOString()) {
    for (const { profileId, serverId } of this.profileService.dueScheduledScanServerIds(nowIso)) {
      const schedule = this.profileService.getFtpServerScanSchedule(profileId, serverId);
      this.profileService.clearPendingScan(profileId, serverId);
      this.profileService.saveFtpServerScanSchedule(profileId, serverId, {
        intervalMinutes: schedule.intervalMinutes,
        nextScheduledScanAt:
          schedule.intervalMinutes > 0 ? new Date(new Date(nowIso).getTime() + schedule.intervalMinutes * 60_000).toISOString() : null,
      });
      this.enqueueProfileScan(profileId, "scheduled", serverId);
    }
  }

  private pump() {
    while (this.activeCount < this.config.scanGlobalConcurrency) {
      const rows = this.db
        .prepare("select * from scan_jobs where status = 'queued' order by queued_at asc, id asc limit ?")
        .all(this.config.scanQueueMax);
      const scanJob = rows.map(optionalScanJobRow).find((row) => row && !this.running.has(row.profile_id));
      if (!scanJob) return;
      this.startJob(scanJob);
    }
  }

  private startJob(row: ScanJobRow) {
    const startedAt = new Date().toISOString();
    this.running.add(row.profile_id);
    this.activeCount += 1;
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'running',
            started_at = ?,
            message = 'Scanning FTP library.'
        where id = ?
      `,
      )
      .run(startedAt, row.id);

    const abortController = new AbortController();
    this.activeControllers.set(row.id, abortController);

    void this.runJob(row.id, row.profile_id, row.ftp_server_id ?? this.profileService.defaultFtpServerId(row.profile_id), abortController.signal)
      .catch((error: unknown) => {
        if (isScanCancelledError(error)) {
          this.cancelJob(row.id);
          return;
        }
        const message = error instanceof Error ? error.message : "Unable to refresh FTP index";
        this.failJob(row.id, message);
      })
      .finally(() => {
        this.activeControllers.delete(row.id);
        this.running.delete(row.profile_id);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async runJob(jobId: number, profileId: number, ftpServerId: number, signal: AbortSignal) {
    const ftpConfig = this.profileService.getFtpServerConfig(profileId, ftpServerId);
    if (!ftpConfig) throw new Error("FTP settings are not configured");
    const customization = this.profileService.getFtpServerCustomization(profileId, ftpServerId);

    let filesSeen = 0;
    const startedAt = Date.now();
    for (const rootPath of ftpConfig.roots) {
      throwIfScanCancelled(signal);
      const result = await crawlProfileRoot({
        profileId,
        ftpServerId,
        rootPath,
        ftpConfig,
        factory: this.ftpClientFactory,
        repo: this.mediaRepository,
        parserOptions: {
          contentTypes: customization.catalogContentTypes,
          libraryLayout: customization.libraryLayout,
        },
        onProgress: (progress) => this.saveProgress(jobId, startedAt, progress),
        signal,
      });
      filesSeen += result.filesSeen;
    }

    throwIfScanCancelled(signal);
    const lastScanAt = new Date().toISOString();
    const mediaItems = this.mediaRepository.countForServer(profileId, ftpServerId);
    this.profileService.saveFtpServerIndexStatus(profileId, ftpServerId, { lastScanAt, mediaItems });
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'succeeded',
            progress_percent = 100,
            files_seen = ?,
            estimated_seconds_remaining = 0,
            message = ?,
            finished_at = ?
        where id = ?
      `,
      )
      .run(filesSeen, `Indexed ${filesSeen} media file${filesSeen === 1 ? "" : "s"}.`, lastScanAt, jobId);
  }

  private saveProgress(jobId: number, startedAt: number, progress: CrawlProgress) {
    const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
    const estimatedTotal = Math.max(this.config.scanProgressAverageItems, progress.entriesSeen || 1);
    const progressPercent = Math.min(95, Math.max(1, Math.round((progress.entriesSeen / estimatedTotal) * 100)));
    const entriesRemaining = Math.max(0, estimatedTotal - progress.entriesSeen);
    const entriesPerSecond = Math.max(0.01, progress.entriesSeen / elapsedSeconds);
    const estimatedSecondsRemaining = Math.min(
      MAX_ESTIMATED_SECONDS_REMAINING,
      Math.round(entriesRemaining / entriesPerSecond),
    );

    this.db
      .prepare(
        `
        update scan_jobs
        set progress_percent = ?,
            entries_seen = ?,
            files_seen = ?,
            directories_seen = ?,
            current_path = ?,
            estimated_seconds_remaining = ?,
            message = 'Scanning FTP library.'
        where id = ?
      `,
      )
      .run(
        progressPercent,
        progress.entriesSeen,
        progress.filesSeen,
        progress.directoriesSeen,
        progress.currentPath,
        estimatedSecondsRemaining,
        jobId,
      );
  }

  private failJob(jobId: number, error: string) {
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'failed',
            error = ?,
            message = 'Scan failed.',
            finished_at = ?
        where id = ?
      `,
      )
      .run(error, new Date().toISOString(), jobId);
  }

  private cancelJob(jobId: number) {
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'cancelled',
            message = 'Scan halted.',
            error = null,
            finished_at = ?
        where id = ?
      `,
      )
      .run(new Date().toISOString(), jobId);
  }

  private cooldownStatus(profileId: number, ftpServerId: number) {
    const result = this.db
      .prepare(
        `
        select *
        from scan_jobs
        where profile_id = ?
          and ftp_server_id = ?
          and trigger = 'manual'
          and status = 'succeeded'
          and finished_at is not null
        order by finished_at desc
        limit 1
      `,
      )
      .get(profileId, ftpServerId);
    const row = optionalScanJobRow(result);
    if (!row?.finished_at) return null;

    const finishedAt = new Date(row.finished_at).getTime();
    const nextAllowedAt = finishedAt + this.config.scanCooldownMs;
    if (Date.now() >= nextAllowedAt) return null;
    return this.insertSkippedJob(profileId, ftpServerId, "manual", `Manual scan cooldown active. Try again after ${new Date(nextAllowedAt).toISOString()}.`);
  }

  private insertSkippedJob(profileId: number, ftpServerId: number, trigger: ScanTrigger, message: string) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        insert into scan_jobs (profile_id, ftp_server_id, status, trigger, progress_percent, message, queued_at, finished_at)
        values (?, ?, 'skipped', ?, 0, ?, ?, ?)
      `,
      )
      .run(profileId, ftpServerId, trigger, message, now, now);
    return this.getJobStatus(Number(result.lastInsertRowid));
  }

  private activeJobForServer(profileId: number, ftpServerId: number) {
    const row = this.db
      .prepare(
        `
        select *
        from scan_jobs
        where profile_id = ?
          and ftp_server_id = ?
          and status in ('queued', 'running')
        order by id desc
        limit 1
      `,
      )
      .get(profileId, ftpServerId);
    return optionalScanJobRow(row);
  }

  private rowToStatus(row: ScanJobRow): ProfileScanStatus {
    return {
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      progressPercent: row.progress_percent,
      entriesSeen: row.entries_seen,
      filesSeen: row.files_seen,
      directoriesSeen: row.directories_seen,
      currentPath: row.current_path,
      estimatedSecondsRemaining: row.estimated_seconds_remaining,
      message: row.message,
      error: row.error,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      mediaItems:
        row.ftp_server_id === null
          ? this.mediaRepository.countForProfile(row.profile_id)
          : this.mediaRepository.countForServer(row.profile_id, row.ftp_server_id),
    };
  }

  private recoverInterruptedJobs() {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'failed',
            error = 'Scan interrupted by server restart.',
            message = 'Scan interrupted.',
            finished_at = coalesce(finished_at, ?)
        where status = 'running'
      `,
      )
      .run(now);
  }
}

function countFromRow(row: unknown): number {
  if (!isRecord(row) || typeof row.count !== "number") throw new Error("Invalid count row");
  return row.count;
}

function throwIfScanCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new ScanCancelledError();
}

function optionalScanJobRow(row: unknown): ScanJobRow | undefined {
  if (row === undefined) return undefined;
  return scanJobRow(row);
}

function scanJobRow(row: unknown): ScanJobRow {
  if (!isRecord(row)) throw new Error(SCAN_JOB_ROW_ERROR);
  return {
    id: numberField(row, "id"),
    profile_id: numberField(row, "profile_id"),
    ftp_server_id: nullableNumberField(row, "ftp_server_id"),
    status: persistedScanStatus(row.status),
    trigger: scanTrigger(row.trigger),
    progress_percent: numberField(row, "progress_percent"),
    entries_seen: numberField(row, "entries_seen"),
    files_seen: numberField(row, "files_seen"),
    directories_seen: numberField(row, "directories_seen"),
    current_path: nullableStringField(row, "current_path"),
    estimated_seconds_remaining: nullableNumberField(row, "estimated_seconds_remaining"),
    message: nullableStringField(row, "message"),
    error: nullableStringField(row, "error"),
    queued_at: stringField(row, "queued_at"),
    started_at: nullableStringField(row, "started_at"),
    finished_at: nullableStringField(row, "finished_at"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(row: Record<string, unknown>, key: keyof ScanJobRow): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`${SCAN_JOB_ROW_ERROR}: ${String(key)}`);
  return value;
}

function nullableNumberField(row: Record<string, unknown>, key: keyof ScanJobRow): number | null {
  const value = row[key];
  if (value === null || typeof value === "number") return value;
  throw new Error(`${SCAN_JOB_ROW_ERROR}: ${String(key)}`);
}

function stringField(row: Record<string, unknown>, key: keyof ScanJobRow): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`${SCAN_JOB_ROW_ERROR}: ${String(key)}`);
  return value;
}

function nullableStringField(row: Record<string, unknown>, key: keyof ScanJobRow): string | null {
  const value = row[key];
  if (value === null || typeof value === "string") return value;
  throw new Error(`${SCAN_JOB_ROW_ERROR}: ${String(key)}`);
}

function persistedScanStatus(value: unknown): ScanJobRow["status"] {
  switch (value) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "skipped":
    case "cancelled":
      return value;
    default:
      throw new Error(`${SCAN_JOB_ROW_ERROR}: status`);
  }
}

function scanTrigger(value: unknown): ScanTrigger {
  switch (value) {
    case "manual":
    case "scheduled":
      return value;
    default:
      throw new Error(`${SCAN_JOB_ROW_ERROR}: trigger`);
  }
}
