import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { crawlProfileRoot, type CrawlProgress } from "../ftp/crawler.js";
import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { ProfileService } from "../profiles/profileService.js";

export type ScanTrigger = "manual" | "scheduled";
export type ScanJobStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "skipped";

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

  enqueueProfileScan(profileId: number, trigger: ScanTrigger): ProfileScanStatus {
    const active = this.activeJobForProfile(profileId);
    if (active) return this.rowToStatus(active);

    if (trigger === "manual") {
      const cooldownStatus = this.cooldownStatus(profileId);
      if (cooldownStatus) return cooldownStatus;
    }

    const queuedCount = this.db.prepare("select count(*) as count from scan_jobs where status = 'queued'").get() as { count: number };
    if (queuedCount.count >= this.config.scanQueueMax) {
      return this.insertSkippedJob(profileId, trigger, "Scan queue is full.");
    }

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        insert into scan_jobs (profile_id, status, trigger, progress_percent, message, queued_at)
        values (?, 'queued', ?, 0, 'Waiting for scan worker.', ?)
      `,
      )
      .run(profileId, trigger, now);
    this.pump();
    return this.getJobStatus(Number(result.lastInsertRowid));
  }

  getProfileScanStatus(profileId: number): ProfileScanStatus {
    const row = this.db
      .prepare("select * from scan_jobs where profile_id = ? order by id desc limit 1")
      .get(profileId) as ScanJobRow | undefined;
    if (!row) {
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
        mediaItems: this.mediaRepository.countForProfile(profileId),
      };
    }
    return this.rowToStatus(row);
  }

  getJobStatus(jobId: number): ProfileScanStatus {
    const row = this.db.prepare("select * from scan_jobs where id = ?").get(jobId) as ScanJobRow | undefined;
    if (!row) throw new Error("Scan job not found");
    return this.rowToStatus(row);
  }

  enqueueDueScheduledScans(nowIso = new Date().toISOString()) {
    for (const profileId of this.profileService.dueScheduledScanProfileIds(nowIso)) {
      const schedule = this.profileService.getScanSchedule(profileId);
      this.profileService.saveScanSchedule(profileId, {
        intervalMinutes: schedule.intervalMinutes,
        nextScheduledScanAt: new Date(new Date(nowIso).getTime() + schedule.intervalMinutes * 60_000).toISOString(),
      });
      this.enqueueProfileScan(profileId, "scheduled");
    }
  }

  private pump() {
    while (this.activeCount < this.config.scanGlobalConcurrency) {
      const row = this.db
        .prepare("select * from scan_jobs where status = 'queued' order by queued_at asc, id asc limit 1")
        .get() as ScanJobRow | undefined;
      if (!row) return;
      if (this.running.has(row.profile_id)) return;
      this.startJob(row);
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

    void this.runJob(row.id, row.profile_id)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unable to refresh FTP index";
        this.failJob(row.id, message);
      })
      .finally(() => {
        this.running.delete(row.profile_id);
        this.activeCount -= 1;
        this.pump();
      });
  }

  private async runJob(jobId: number, profileId: number) {
    const ftpConfig = this.profileService.getFtpConfig(profileId);
    if (!ftpConfig) throw new Error("FTP settings are not configured");
    const customization = this.profileService.getAddonCustomization(profileId);

    let filesSeen = 0;
    const startedAt = Date.now();
    for (const rootPath of ftpConfig.roots) {
      const result = await crawlProfileRoot({
        profileId,
        rootPath,
        ftpConfig,
        factory: this.ftpClientFactory,
        repo: this.mediaRepository,
        parserOptions: {
          contentTypes: customization.catalogContentTypes,
          libraryLayout: customization.libraryLayout,
        },
        onProgress: (progress) => this.saveProgress(jobId, startedAt, progress),
      });
      filesSeen += result.filesSeen;
    }

    const lastScanAt = new Date().toISOString();
    const mediaItems = this.mediaRepository.countForProfile(profileId);
    this.profileService.saveIndexStatus(profileId, { lastScanAt, mediaItems });
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
    const estimatedSecondsRemaining = Math.round(entriesRemaining / entriesPerSecond);

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

  private cooldownStatus(profileId: number) {
    const row = this.db
      .prepare(
        `
        select *
        from scan_jobs
        where profile_id = ?
          and trigger = 'manual'
          and status = 'succeeded'
          and finished_at is not null
        order by finished_at desc
        limit 1
      `,
      )
      .get(profileId) as ScanJobRow | undefined;
    if (!row?.finished_at) return null;

    const finishedAt = new Date(row.finished_at).getTime();
    const nextAllowedAt = finishedAt + this.config.scanCooldownMs;
    if (Date.now() >= nextAllowedAt) return null;
    return this.insertSkippedJob(profileId, "manual", `Manual scan cooldown active. Try again after ${new Date(nextAllowedAt).toISOString()}.`);
  }

  private insertSkippedJob(profileId: number, trigger: ScanTrigger, message: string) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        insert into scan_jobs (profile_id, status, trigger, progress_percent, message, queued_at, finished_at)
        values (?, 'skipped', ?, 0, ?, ?, ?)
      `,
      )
      .run(profileId, trigger, message, now, now);
    return this.getJobStatus(Number(result.lastInsertRowid));
  }

  private activeJobForProfile(profileId: number) {
    return this.db
      .prepare(
        `
        select *
        from scan_jobs
        where profile_id = ?
          and status in ('queued', 'running')
        order by id desc
        limit 1
      `,
      )
      .get(profileId) as ScanJobRow | undefined;
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
      mediaItems: this.mediaRepository.countForProfile(row.profile_id),
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
