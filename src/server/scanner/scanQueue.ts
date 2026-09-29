import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import {
  crawlProfileRoot,
  FtpCrawlSession,
  isScanCancelledError,
  isTransientFtpDisconnect,
  throwIfScanCancelled,
  type CrawlProgress,
} from "../ftp/crawler.js";
import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import type { CatalogEnrichmentCandidate, MediaRepository } from "../media/mediaRepository.js";
import { catalogMetaMatchesItem, tmdbCatalogEnrichment, type TmdbCatalogKind } from "../metadata/tmdbClient.js";
import type { ProfileService } from "../profiles/profileService.js";
import { nextAlignedScanAt } from "./schedule.js";

const MAX_ESTIMATED_SECONDS_REMAINING = 24 * 60 * 60;
const SCAN_JOB_ROW_ERROR = "Invalid scan job row";
const ENRICHMENT_RETRY_DELAY_MS = 5 * 60 * 1000;
const ENRICHMENT_BATCH_LIMIT = 5000;
const PROGRESS_WRITE_INTERVAL_MS = 250;

export type ScanTrigger = "manual" | "scheduled";
export type ScanJobStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type ScanMode = "full" | "incremental" | "force";
export type EnqueueScanOptions = {
  force?: boolean;
  retryMode?: ScanMode;
};

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
  mediaItemsAdded: number;
  scanMode: ScanMode | null;
};

type ScanJobRow = {
  id: number;
  target_kind: "profile_server" | "shared_group";
  profile_id: number;
  ftp_server_id: number | null;
  shared_index_group_id: number | null;
  status: Exclude<ScanJobStatus, "idle">;
  trigger: ScanTrigger;
  progress_percent: number;
  scan_mode: ScanMode | null;
  entries_seen: number;
  files_seen: number;
  media_items_added: number;
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
  private readonly running = new Set<string>();
  private readonly activeControllers = new Map<number, AbortController>();
  private readonly statements = new Map<string, Database.Statement>();

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

  async refreshStoredCatalogMetadata(): Promise<void> {
    await this.mediaRepository.reparseStoredFiles();
    const servers = this.db.prepare("select profile_id, id, shared_index_group_id from profile_ftp_servers where catalog_enabled = 1 order by id").all() as Array<{
      profile_id: number; id: number; shared_index_group_id: number | null;
    }>;
    const signal = new AbortController().signal;
    for (const server of servers) {
      const seenAt = new Date().toISOString();
      if (server.shared_index_group_id) {
        await this.enrichSharedCatalogMetadata(null, server.profile_id, server.id, server.shared_index_group_id, seenAt, signal);
      } else {
        await this.enrichCatalogMetadata(null, server.profile_id, server.id, seenAt, signal);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  enqueueProfileScan(
    profileId: number,
    trigger: ScanTrigger,
    ftpServerId = this.profileService.defaultFtpServerId(profileId),
    options: EnqueueScanOptions = {},
  ): ProfileScanStatus {
    const result = this.db.transaction((): ProfileScanStatus | number => {
      const active = this.activeJobForServer(profileId, ftpServerId);
      if (active) return this.rowToStatus(active);

      if (trigger === "manual" && !options.force) {
        const cooldownStatus = this.cooldownStatus(profileId, ftpServerId);
        if (cooldownStatus) return cooldownStatus;
      }

      const queuedCount = countFromRow(this.db.prepare("select count(*) as count from scan_jobs where status = 'queued'").get());
      if (queuedCount >= this.config.scanQueueMax) {
        return this.insertSkippedJob(profileId, ftpServerId, trigger, "Scan queue is full.");
      }

      if (trigger === "manual") this.profileService.clearPendingScan(profileId, ftpServerId);
      const scanMode = options.retryMode ?? this.scanModeForNextJob(profileId, ftpServerId, Boolean(options.force));
      if (options.force) this.mediaRepository.clearDirectorySnapshots(profileId, ftpServerId);

      const now = new Date().toISOString();
      const insert = this.db
        .prepare(
          `
          insert into scan_jobs (profile_id, ftp_server_id, status, trigger, progress_percent, scan_mode, message, queued_at)
          values (?, ?, 'queued', ?, 0, ?, ?, ?)
        `,
        )
        .run(profileId, ftpServerId, trigger, scanMode, queuedScanMessage(scanMode), now);
      return Number(insert.lastInsertRowid);
    })();

    if (typeof result !== "number") {
      if (result.status === "queued") this.pump();
      return result.id === null ? result : this.getJobStatus(result.id);
    }
    this.pump();
    return this.getJobStatus(result);
  }

  enqueueSharedIndexScan(sharedIndexGroupId: number, trigger: ScanTrigger, options: EnqueueScanOptions = {}): ProfileScanStatus {
    const result = this.db.transaction((): ProfileScanStatus | number => {
      const active = this.activeJobForSharedIndexGroup(sharedIndexGroupId);
      if (active) return this.rowToStatus(active);

      const queuedCount = countFromRow(this.db.prepare("select count(*) as count from scan_jobs where status = 'queued'").get());
      if (queuedCount >= this.config.scanQueueMax) {
        const scanConfig = this.profileService.sharedIndexScanConfig(sharedIndexGroupId);
        return this.insertSkippedJob(scanConfig.profileId, scanConfig.serverId, trigger, "Scan queue is full.", {
          targetKind: "shared_group",
          sharedIndexGroupId,
        });
      }

      const scanConfig = this.profileService.sharedIndexScanConfig(sharedIndexGroupId);
      const scanMode = options.retryMode ?? this.scanModeForNextSharedJob(sharedIndexGroupId, Boolean(options.force));
      if (options.force) this.mediaRepository.clearSharedDirectorySnapshots(sharedIndexGroupId);

      const now = new Date().toISOString();
      const insert = this.db
        .prepare(
          `
          insert into scan_jobs (
            target_kind, profile_id, ftp_server_id, shared_index_group_id, status, trigger,
            progress_percent, scan_mode, message, queued_at
          ) values ('shared_group', ?, ?, ?, 'queued', ?, 0, ?, ?, ?)
        `,
        )
        .run(scanConfig.profileId, scanConfig.serverId, sharedIndexGroupId, trigger, scanMode, queuedScanMessage(scanMode), now);
      return Number(insert.lastInsertRowid);
    })();

    if (typeof result !== "number") {
      if (result.status === "queued") this.pump();
      return result.id === null ? result : this.getJobStatus(result.id);
    }
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
        mediaItemsAdded: 0,
        scanMode: null,
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

  cancelSharedIndexScan(sharedIndexGroupId: number): ProfileScanStatus {
    const active = this.activeJobForSharedIndexGroup(sharedIndexGroupId);
    if (!active) return this.getSharedIndexScanStatus(sharedIndexGroupId);

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

  getSharedIndexScanStatus(sharedIndexGroupId: number): ProfileScanStatus {
    const row = this.db
      .prepare("select * from scan_jobs where target_kind = 'shared_group' and shared_index_group_id = ? order by id desc limit 1")
      .get(sharedIndexGroupId);
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
        mediaItems: this.mediaRepository.countForSharedIndexGroup(sharedIndexGroupId),
        mediaItemsAdded: 0,
        scanMode: null,
      };
    }
    return this.rowToStatus(scanJob);
  }

  enqueueDueScheduledScans(nowIso = new Date().toISOString()) {
    const now = new Date(nowIso);
    const dueTargets = this.profileService.dueScheduledScanServerIds(nowIso);
    const handledServers = new Set<string>();
    if (dueTargets.some(({ profileId, serverId, dueReason }) => dueReason === "scheduled" && this.profileService.getFtpServer(profileId, serverId).sharedIndex)) {
      for (const target of this.profileService.scheduledSharedIndexScanServerIds()) {
        handledServers.add(`${target.profileId}:${target.serverId}`);
        const ftpConfig = this.profileService.getFtpServerConfig(target.profileId, target.serverId);
        if (!ftpConfig || !ftpConfig.username?.trim() || !ftpConfig.password) {
          this.profileService.clearPendingScan(target.profileId, target.serverId);
          continue;
        }
        this.profileService.clearPendingScan(target.profileId, target.serverId);
        this.profileService.saveFtpServerScanSchedule(target.profileId, target.serverId, {
          intervalMinutes: target.intervalMinutes,
          nextScheduledScanAt: nextAlignedScanAt(target.intervalMinutes, now),
        });
        this.enqueueSharedIndexScan(target.sharedIndexGroupId, "scheduled");
      }
    }

    for (const { profileId, serverId, dueReason } of dueTargets) {
      if (handledServers.has(`${profileId}:${serverId}`)) continue;
      const ftpConfig = this.profileService.getFtpServerConfig(profileId, serverId);
      if (!ftpConfig || !ftpConfig.username?.trim() || !ftpConfig.password) {
        this.profileService.clearPendingScan(profileId, serverId);
        continue;
      }
      const schedule = this.profileService.getFtpServerScanSchedule(profileId, serverId);
      this.profileService.clearPendingScan(profileId, serverId);
      const server = this.profileService.getFtpServer(profileId, serverId);
      const retryMode =
        dueReason === "pending"
          ? server.sharedIndex
            ? this.latestFailedScanModeForSharedIndex(server.sharedIndex.id)
            : this.latestFailedScanModeForServer(profileId, serverId)
          : null;
      this.profileService.saveFtpServerScanSchedule(profileId, serverId, {
        intervalMinutes: schedule.intervalMinutes,
        nextScheduledScanAt: server.sharedIndex
          ? nextAlignedScanAt(schedule.intervalMinutes, now)
          : schedule.intervalMinutes > 0
            ? new Date(new Date(nowIso).getTime() + schedule.intervalMinutes * 60_000).toISOString()
            : null,
      });
      if (server.sharedIndex) this.enqueueSharedIndexScan(server.sharedIndex.id, "scheduled", { retryMode: retryMode ?? undefined });
      else this.enqueueProfileScan(profileId, "scheduled", serverId, { retryMode: retryMode ?? undefined });
    }
  }

  private pump() {
    while (this.activeCount < this.config.scanGlobalConcurrency) {
      const rows = this.db
        .prepare("select * from scan_jobs where status = 'queued' order by queued_at asc, id asc limit ?")
        .all(this.config.scanQueueMax);
      const scanJob = rows.map(optionalScanJobRow).find((row) => row && !this.running.has(targetKey(row)));
      if (!scanJob) return;
      this.startJob(scanJob);
    }
  }

  private startJob(row: ScanJobRow) {
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'running',
            started_at = ?,
            message = ?
        where id = ?
      `,
      )
      .run(startedAt, `${scanModeLabel(row.scan_mode ?? "full")} starting.`, row.id);
    this.running.add(targetKey(row));
    this.activeCount += 1;

    const abortController = new AbortController();
    this.activeControllers.set(row.id, abortController);

    const run = (async () =>
      row.target_kind === "shared_group" && row.shared_index_group_id
        ? await this.runSharedJob(row.id, row.shared_index_group_id, row.scan_mode ?? "full", abortController.signal)
        : await this.runJob(row.id, row.profile_id, row.ftp_server_id ?? this.profileService.defaultFtpServerId(row.profile_id), row.scan_mode ?? "full", abortController.signal))();

    void run
      .catch((error: unknown) => {
        if (isScanCancelledError(error)) {
          this.cancelJob(row.id);
          return;
        }
        const message = error instanceof Error ? error.message : "Unable to refresh FTP index";
        const label = row.target_kind === "shared_group" && row.shared_index_group_id ? "Shared scan" : "Scan";
        this.failJob(row.id, row.profile_id, row.ftp_server_id ?? this.profileService.defaultFtpServerId(row.profile_id), row.scan_mode ?? "full", message, label);
      })
      .catch((error: unknown) => logScanError(row.id, "Unable to record scan result", error))
      .finally(() => {
        this.activeControllers.delete(row.id);
        this.running.delete(targetKey(row));
        this.activeCount -= 1;
        try {
          this.pump();
        } catch (error) {
          logScanError(row.id, "Unable to start the next queued scan", error);
        }
      });
  }

  private async runSharedJob(jobId: number, sharedIndexGroupId: number, scanMode: ScanMode, signal: AbortSignal) {
    const scanConfig = this.profileService.sharedIndexScanConfig(sharedIndexGroupId);
    const ftpConfig = scanConfig.ftpConfig;
    if (!ftpConfig.username?.trim() || !ftpConfig.password) throw new Error("FTP username and password are required");
    const progressBaselineItems = this.lastSuccessfulSharedProgressItems(sharedIndexGroupId);
    const initialMediaItems = this.mediaRepository.countForSharedIndexGroup(sharedIndexGroupId);

    let filesSeen = 0;
    const startedAt = Date.now();
    const progressWriter = this.progressWriter(jobId, startedAt, progressBaselineItems, scanMode);
    const session = new FtpCrawlSession(this.ftpClientFactory, ftpConfig, signal);
    try {
      for (const rootPath of ftpConfig.roots) {
        throwIfScanCancelled(signal);
        const result = await crawlProfileRoot({
          profileId: scanConfig.profileId,
          ftpServerId: scanConfig.serverId,
          sharedIndexGroupId,
          rootPath,
          ftpConfig,
          factory: this.ftpClientFactory,
          session,
          repo: this.mediaRepository,
          parserOptions: {
            contentTypes: scanConfig.customization.catalogContentTypes,
            libraryLayout: scanConfig.customization.libraryLayout,
          },
          onProgress: (progress) => progressWriter.report(progress),
          signal,
        });
        filesSeen += result.filesSeen;
      }
    } finally {
      await session.close();
      progressWriter.flush();
    }

    throwIfScanCancelled(signal);
    const lastScanAt = new Date().toISOString();
    const mediaItems = this.mediaRepository.countForSharedIndexGroup(sharedIndexGroupId);
    const mediaItemsAdded = Math.max(0, mediaItems - initialMediaItems);
    this.profileService.saveSharedIndexStatus(sharedIndexGroupId, { lastScanAt, mediaItems });
    const enrichment = await this.enrichSharedCatalogMetadata(
      jobId,
      scanConfig.profileId,
      scanConfig.serverId,
      sharedIndexGroupId,
      lastScanAt,
      signal,
    );
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'succeeded',
            progress_percent = 100,
            files_seen = ?,
            media_items_added = ?,
            estimated_seconds_remaining = 0,
            message = ?,
            finished_at = ?
        where id = ?
      `,
      )
      .run(filesSeen, mediaItemsAdded, scanFinishedMessage(filesSeen, enrichment), lastScanAt, jobId);
  }

  private async runJob(jobId: number, profileId: number, ftpServerId: number, scanMode: ScanMode, signal: AbortSignal) {
    const ftpConfig = this.profileService.getFtpServerConfig(profileId, ftpServerId);
    if (!ftpConfig) throw new Error("FTP settings are not configured");
    if (!ftpConfig.username?.trim() || !ftpConfig.password) throw new Error("FTP username and password are required");
    const customization = this.profileService.getFtpServerCustomization(profileId, ftpServerId);
    const progressBaselineItems = this.lastSuccessfulProgressItems(profileId, ftpServerId);
    const initialMediaItems = this.mediaRepository.countForServer(profileId, ftpServerId);

    let filesSeen = 0;
    const startedAt = Date.now();
    const progressWriter = this.progressWriter(jobId, startedAt, progressBaselineItems, scanMode);
    const session = new FtpCrawlSession(this.ftpClientFactory, ftpConfig, signal);
    try {
      for (const rootPath of ftpConfig.roots) {
        throwIfScanCancelled(signal);
        const result = await crawlProfileRoot({
          profileId,
          ftpServerId,
          rootPath,
          ftpConfig,
          factory: this.ftpClientFactory,
          session,
          repo: this.mediaRepository,
          parserOptions: {
            contentTypes: customization.catalogContentTypes,
            libraryLayout: customization.libraryLayout,
          },
          onProgress: (progress) => progressWriter.report(progress),
          signal,
        });
        filesSeen += result.filesSeen;
      }
    } finally {
      await session.close();
      progressWriter.flush();
    }

    throwIfScanCancelled(signal);
    const lastScanAt = new Date().toISOString();
    const mediaItems = this.mediaRepository.countForServer(profileId, ftpServerId);
    const mediaItemsAdded = Math.max(0, mediaItems - initialMediaItems);
    this.profileService.saveFtpServerIndexStatus(profileId, ftpServerId, { lastScanAt, mediaItems });
    const enrichment = await this.enrichCatalogMetadata(jobId, profileId, ftpServerId, lastScanAt, signal);
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'succeeded',
            progress_percent = 100,
            files_seen = ?,
            media_items_added = ?,
            estimated_seconds_remaining = 0,
            message = ?,
            finished_at = ?
        where id = ?
      `,
      )
      .run(filesSeen, mediaItemsAdded, scanFinishedMessage(filesSeen, enrichment), lastScanAt, jobId);
  }

  latestCompletedScanNewItems(profileId: number, finishedAt: string | null) {
    if (!finishedAt) return null;
    const row = this.db
      .prepare(
        `
        select sum(media_items_added) as mediaItemsAdded
        from scan_jobs
        where profile_id = ?
          and status = 'succeeded'
          and finished_at = ?
      `,
      )
      .get(profileId, finishedAt) as { mediaItemsAdded: number | null } | undefined;
    return row?.mediaItemsAdded ?? null;
  }

  private async enrichCatalogMetadata(jobId: number | null, profileId: number, ftpServerId: number, seenAt: string, signal: AbortSignal) {
    const customization = this.profileService.getFtpServerCustomization(profileId, ftpServerId);
    if (!customization.catalogEnabled) return null;

    const catalogKinds = enabledCatalogKinds(customization.catalogContentTypes);
    if (!catalogKinds.length) return null;

    const candidates = this.mediaRepository.catalogEnrichmentCandidates(profileId, ftpServerId, catalogKinds);
    this.mediaRepository.syncCatalogEnrichmentCandidates(profileId, ftpServerId, candidates, seenAt);
    const pending = this.mediaRepository.pendingCatalogEnrichment(profileId, ftpServerId, new Date().toISOString(), ENRICHMENT_BATCH_LIMIT);
    if (!pending.length) return this.mediaRepository.catalogEnrichmentStats(profileId, ftpServerId);

    const apiKey = customization.catalogTmdbApiKey?.trim() || this.config.tmdbApiKey;
    const total = pending.length;
    let processed = 0;
    let retryCount = 0;

    this.saveEnrichmentProgress(jobId, processed, total, null);
    for (const candidate of pending) {
      throwIfScanCancelled(signal);
      if (catalogRecheckRequiresTmdbKey(candidate, apiKey)) {
        processed += 1;
        this.saveEnrichmentProgress(jobId, processed, total, candidate);
        continue;
      }
      const result = await tmdbCatalogEnrichment(candidate, apiKey, tmdbLookupKind(candidate));
      const now = new Date().toISOString();
      if (result.status === "matched") {
        if (candidate.existingMeta && catalogMetaMatchesItem(candidate, candidate.existingMeta, tmdbLookupKind(candidate))) {
          this.mediaRepository.saveCatalogEnrichmentUnmatched(candidate.id, now);
        } else {
          this.mediaRepository.saveCatalogEnrichmentMatch(candidate.id, result.meta, now);
        }
      } else if (result.status === "unmatched") {
        this.mediaRepository.saveCatalogEnrichmentUnmatched(candidate.id, now);
      } else {
        retryCount += 1;
        const nextAttemptAt = new Date(Date.now() + ENRICHMENT_RETRY_DELAY_MS).toISOString();
        this.mediaRepository.saveCatalogEnrichmentRetry(candidate.id, result.error, nextAttemptAt, now);
      }
      processed += 1;
      this.saveEnrichmentProgress(jobId, processed, total, candidate);
    }

    if (retryCount > 0) {
      this.profileService.schedulePendingScan(profileId, ftpServerId, new Date(Date.now() + ENRICHMENT_RETRY_DELAY_MS).toISOString());
    }
    return this.mediaRepository.catalogEnrichmentStats(profileId, ftpServerId);
  }

  private async enrichSharedCatalogMetadata(
    jobId: number | null,
    profileId: number,
    ftpServerId: number,
    sharedIndexGroupId: number,
    seenAt: string,
    signal: AbortSignal,
  ) {
    const customization = this.profileService.getFtpServerCustomization(profileId, ftpServerId);
    if (!customization.catalogEnabled) return null;

    const catalogKinds = enabledCatalogKinds(customization.catalogContentTypes);
    if (!catalogKinds.length) return null;

    const candidates = this.mediaRepository.sharedCatalogEnrichmentCandidates(sharedIndexGroupId, ftpServerId, catalogKinds);
    this.mediaRepository.syncCatalogEnrichmentCandidates(profileId, ftpServerId, candidates, seenAt);
    const pending = this.mediaRepository.pendingCatalogEnrichment(profileId, ftpServerId, new Date().toISOString(), ENRICHMENT_BATCH_LIMIT);
    if (!pending.length) return this.mediaRepository.catalogEnrichmentStats(profileId, ftpServerId);

    const apiKey = customization.catalogTmdbApiKey?.trim() || this.config.tmdbApiKey;
    const total = pending.length;
    let processed = 0;
    let retryCount = 0;

    this.saveEnrichmentProgress(jobId, processed, total, null);
    for (const candidate of pending) {
      throwIfScanCancelled(signal);
      if (catalogRecheckRequiresTmdbKey(candidate, apiKey)) {
        processed += 1;
        this.saveEnrichmentProgress(jobId, processed, total, candidate);
        continue;
      }
      const result = await tmdbCatalogEnrichment(candidate, apiKey, tmdbLookupKind(candidate));
      const now = new Date().toISOString();
      if (result.status === "matched") {
        if (candidate.existingMeta && catalogMetaMatchesItem(candidate, candidate.existingMeta, tmdbLookupKind(candidate))) {
          this.mediaRepository.saveCatalogEnrichmentUnmatched(candidate.id, now);
        } else {
          this.mediaRepository.saveCatalogEnrichmentMatch(candidate.id, result.meta, now);
        }
      } else if (result.status === "unmatched") {
        this.mediaRepository.saveCatalogEnrichmentUnmatched(candidate.id, now);
      } else {
        retryCount += 1;
        const nextAttemptAt = new Date(Date.now() + ENRICHMENT_RETRY_DELAY_MS).toISOString();
        this.mediaRepository.saveCatalogEnrichmentRetry(candidate.id, result.error, nextAttemptAt, now);
      }
      processed += 1;
      this.saveEnrichmentProgress(jobId, processed, total, candidate);
    }

    if (retryCount > 0) {
      this.profileService.schedulePendingScan(profileId, ftpServerId, new Date(Date.now() + ENRICHMENT_RETRY_DELAY_MS).toISOString());
    }
    return this.mediaRepository.catalogEnrichmentStats(profileId, ftpServerId);
  }

  private saveEnrichmentProgress(jobId: number | null, processed: number, total: number, candidate: CatalogEnrichmentCandidate | null) {
    if (jobId === null) return;
    const progressPercent = total > 0 ? Math.min(99, 95 + Math.floor((processed / total) * 4)) : 95;
    const title = candidate?.parsedTitle ? ` - ${candidate.parsedTitle}` : "";
    this.statement(
      `
      update scan_jobs
      set progress_percent = ?,
          estimated_seconds_remaining = null,
          current_path = null,
          message = ?
      where id = ?
    `,
    ).run(progressPercent, `Enriching TMDB metadata: ${processed}/${total}${title}.`, jobId);
  }

  private progressWriter(jobId: number, startedAt: number, baselineItems: number | null, scanMode: ScanMode) {
    return new ThrottledProgressWriter(
      (progress) => this.saveProgress(jobId, startedAt, progress, baselineItems, scanMode),
      (error) => logScanError(jobId, "Unable to save scan progress", error),
    );
  }

  private saveProgress(jobId: number, startedAt: number, progress: CrawlProgress, baselineItems: number | null, scanMode: ScanMode) {
    const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
    const progressItems = progress.entriesSeen + progress.directoriesSeen;
    const estimatedTotal = baselineItems ? Math.max(baselineItems, progressItems || 1) : Math.max(this.config.scanProgressAverageItems, progress.entriesSeen || 1);
    const progressRatio = baselineItems ? progressItems / estimatedTotal : 1 - Math.exp(-progressItems / estimatedTotal);
    const progressPercent = Math.min(95, Math.max(1, Math.round(progressRatio * 95)));
    const entriesRemaining = Math.max(0, estimatedTotal - progressItems);
    const entriesPerSecond = Math.max(0.01, progressItems / elapsedSeconds);
    const estimatedSecondsRemaining =
      entriesRemaining > 0 ? Math.max(1, Math.min(MAX_ESTIMATED_SECONDS_REMAINING, Math.round(entriesRemaining / entriesPerSecond))) : null;

    this.statement(
      `
      update scan_jobs
      set progress_percent = ?,
          entries_seen = ?,
          files_seen = ?,
          directories_seen = ?,
          current_path = ?,
          estimated_seconds_remaining = ?,
          message = ?
      where id = ?
    `,
    ).run(
      progressPercent,
      progress.entriesSeen,
      progress.filesSeen,
      progress.directoriesSeen,
      progress.currentPath,
      estimatedSecondsRemaining,
      scanProgressMessage(progress, scanMode),
      jobId,
    );
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private failJob(jobId: number, profileId: number, ftpServerId: number, scanMode: ScanMode, error: string, label: "Scan" | "Shared scan") {
    const retryDelayMs = isTransientFtpDisconnect(error) ? this.config.scanTransientRetryDelayMs : 0;
    const retryScheduled = retryDelayMs > 0 && this.scheduleRetry(jobId, profileId, ftpServerId, retryDelayMs);
    const retryMessage = retryScheduled ? ` Requeued to retry ${retryScanLabel(scanMode)} in ${formatDuration(retryDelayMs)} using verified directory snapshots only.` : "";
    this.db
      .prepare(
        `
        update scan_jobs
        set status = 'failed',
            error = ?,
            message = ?,
            finished_at = ?
        where id = ?
      `,
      )
      .run(error, `${label} failed: ${error}${retryMessage}`, new Date().toISOString(), jobId);
  }

  private scheduleRetry(jobId: number, profileId: number, ftpServerId: number, retryDelayMs: number) {
    try {
      this.profileService.schedulePendingScan(profileId, ftpServerId, new Date(Date.now() + retryDelayMs).toISOString());
      return true;
    } catch (error) {
      logScanError(jobId, "Unable to schedule scan retry", error);
      return false;
    }
  }

  private lastSuccessfulProgressItems(profileId: number, ftpServerId: number) {
    const row = this.db
      .prepare(
        `
        select entries_seen + directories_seen as items
        from scan_jobs
        where profile_id = ?
          and ftp_server_id = ?
          and status = 'succeeded'
          and entries_seen + directories_seen > 0
        order by finished_at desc, id desc
        limit 1
      `,
      )
      .get(profileId, ftpServerId) as { items: number } | undefined;
    return row?.items && row.items > 0 ? row.items : null;
  }

  private lastSuccessfulSharedProgressItems(sharedIndexGroupId: number) {
    const row = this.db
      .prepare(
        `
        select entries_seen + directories_seen as items
        from scan_jobs
        where target_kind = 'shared_group'
          and shared_index_group_id = ?
          and status = 'succeeded'
          and entries_seen + directories_seen > 0
        order by finished_at desc, id desc
        limit 1
      `,
      )
      .get(sharedIndexGroupId) as { items: number } | undefined;
    return row?.items && row.items > 0 ? row.items : null;
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
    return this.insertSkippedJob(profileId, ftpServerId, "manual", `Manual scan cooldown active. Try again in ${formatDuration(nextAllowedAt - Date.now())}.`);
  }

  private insertSkippedJob(
    profileId: number,
    ftpServerId: number,
    trigger: ScanTrigger,
    message: string,
    target: { targetKind?: "profile_server" | "shared_group"; sharedIndexGroupId?: number | null } = {},
  ) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        insert into scan_jobs (target_kind, profile_id, ftp_server_id, shared_index_group_id, status, trigger, progress_percent, message, queued_at, finished_at)
        values (?, ?, ?, ?, 'skipped', ?, 0, ?, ?, ?)
      `,
      )
      .run(target.targetKind ?? "profile_server", profileId, ftpServerId, target.sharedIndexGroupId ?? null, trigger, message, now, now);
    return this.getJobStatus(Number(result.lastInsertRowid));
  }

  private scanModeForNextJob(profileId: number, ftpServerId: number, force: boolean): ScanMode {
    if (force) return "force";
    return this.mediaRepository.countDirectorySnapshots(profileId, ftpServerId) > 0 ? "incremental" : "full";
  }

  private scanModeForNextSharedJob(sharedIndexGroupId: number, force: boolean): ScanMode {
    if (force) return "force";
    return this.mediaRepository.countSharedDirectorySnapshots(sharedIndexGroupId) > 0 ? "incremental" : "full";
  }

  private latestFailedScanModeForServer(profileId: number, ftpServerId: number): ScanMode | null {
    const row = this.db
      .prepare(
        `
        select scan_mode
        from scan_jobs
        where target_kind = 'profile_server'
          and profile_id = ?
          and ftp_server_id = ?
          and status = 'failed'
          and scan_mode is not null
        order by finished_at desc, id desc
        limit 1
      `,
      )
      .get(profileId, ftpServerId) as { scan_mode: ScanMode } | undefined;
    return row?.scan_mode ?? null;
  }

  private latestFailedScanModeForSharedIndex(sharedIndexGroupId: number): ScanMode | null {
    const row = this.db
      .prepare(
        `
        select scan_mode
        from scan_jobs
        where target_kind = 'shared_group'
          and shared_index_group_id = ?
          and status = 'failed'
          and scan_mode is not null
        order by finished_at desc, id desc
        limit 1
      `,
      )
      .get(sharedIndexGroupId) as { scan_mode: ScanMode } | undefined;
    return row?.scan_mode ?? null;
  }

  private activeJobForServer(profileId: number, ftpServerId: number) {
    const row = this.db
      .prepare(
        `
        select *
        from scan_jobs
        where profile_id = ?
          and ftp_server_id = ?
          and target_kind = 'profile_server'
          and status in ('queued', 'running')
        order by id desc
        limit 1
      `,
      )
      .get(profileId, ftpServerId);
    return optionalScanJobRow(row);
  }

  private activeJobForSharedIndexGroup(sharedIndexGroupId: number) {
    const row = this.db
      .prepare(
        `
        select *
        from scan_jobs
        where target_kind = 'shared_group'
          and shared_index_group_id = ?
          and status in ('queued', 'running')
        order by id desc
        limit 1
      `,
      )
      .get(sharedIndexGroupId);
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
      mediaItemsAdded: row.media_items_added,
      scanMode: row.scan_mode,
      mediaItems:
        row.target_kind === "shared_group" && row.shared_index_group_id !== null
          ? this.mediaRepository.countForSharedIndexGroup(row.shared_index_group_id)
          : row.ftp_server_id === null
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

class ThrottledProgressWriter {
  private pending: CrawlProgress | null = null;
  private lastWriteAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly write: (progress: CrawlProgress) => void,
    private readonly onTimerError: (error: unknown) => void,
  ) {}

  report(progress: CrawlProgress) {
    this.pending = progress;
    const waitMs = this.lastWriteAt + PROGRESS_WRITE_INTERVAL_MS - Date.now();
    if (waitMs <= 0) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      try {
        this.flush();
      } catch (error) {
        this.onTimerError(error);
      }
    }, waitMs);
    this.timer.unref();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const progress = this.pending;
    if (!progress) return;
    this.pending = null;
    this.lastWriteAt = Date.now();
    this.write(progress);
  }
}

function countFromRow(row: unknown): number {
  if (!isRecord(row) || typeof row.count !== "number") throw new Error("Invalid count row");
  return row.count;
}

function scanProgressMessage(progress: CrawlProgress, scanMode: ScanMode) {
  const fileLabel = `${progress.filesSeen} media file${progress.filesSeen === 1 ? "" : "s"}`;
  const entryLabel = `${progress.entriesSeen} entr${progress.entriesSeen === 1 ? "y" : "ies"}`;
  return `${scanModeLabel(scanMode)}: ${fileLabel}, ${entryLabel} seen.`;
}

function queuedScanMessage(scanMode: ScanMode) {
  return `Waiting for ${scanModeWorkerLabel(scanMode)} worker.`;
}

function scanModeLabel(scanMode: ScanMode) {
  if (scanMode === "incremental") return "Difference update";
  if (scanMode === "force") return "Force reindex";
  return "Full scan";
}

function scanModeWorkerLabel(scanMode: ScanMode) {
  if (scanMode === "incremental") return "difference update";
  if (scanMode === "force") return "force reindex";
  return "full scan";
}

function retryScanLabel(scanMode: ScanMode) {
  if (scanMode === "incremental") return "the difference update";
  if (scanMode === "force") return "the force reindex";
  return "the full scan";
}

function scanFinishedMessage(
  filesSeen: number,
  enrichment: { matched: number; unmatched: number; pending: number; retry: number } | null,
) {
  const fileLabel = `Indexed ${filesSeen} media file${filesSeen === 1 ? "" : "s"}.`;
  if (!enrichment) return fileLabel;
  const parts = [`Enriched ${enrichment.matched} title${enrichment.matched === 1 ? "" : "s"}`];
  if (enrichment.unmatched > 0) parts.push(`${enrichment.unmatched} unresolved`);
  if (enrichment.pending + enrichment.retry > 0) parts.push(`${enrichment.pending + enrichment.retry} queued for retry`);
  return `${fileLabel} ${parts.join("; ")}.`;
}

function enabledCatalogKinds(contentTypes: { movies: boolean; series: boolean; anime: boolean; uncategorized?: boolean } | undefined) {
  const enabled = contentTypes ?? { movies: true, series: true, anime: false, uncategorized: true };
  const kinds: Array<"movie" | "series" | "anime"> = [];
  if (enabled.movies) kinds.push("movie");
  if (enabled.series) kinds.push("series");
  if (enabled.anime) kinds.push("anime");
  return kinds;
}

function tmdbLookupKind(candidate: CatalogEnrichmentCandidate): TmdbCatalogKind {
  return candidate.catalogKind === "anime" ? candidate.mediaKind : candidate.catalogKind;
}

function catalogRecheckRequiresTmdbKey(candidate: CatalogEnrichmentCandidate, apiKey: string | null | undefined) {
  return candidate.status === "matched" && !candidate.imdbId && !apiKey;
}

function logScanError(jobId: number, context: string, error: unknown) {
  console.error(`[scan] Job ${jobId}: ${context}: ${error instanceof Error ? error.message : String(error)}`);
}

function formatDuration(durationMs: number) {
  const totalMinutes = Math.max(1, Math.ceil(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  if (!minutes) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function optionalScanJobRow(row: unknown): ScanJobRow | undefined {
  if (row === undefined) return undefined;
  return scanJobRow(row);
}

function scanJobRow(row: unknown): ScanJobRow {
  if (!isRecord(row)) throw new Error(SCAN_JOB_ROW_ERROR);
  return {
    id: numberField(row, "id"),
    target_kind: scanTargetKind(row.target_kind),
    profile_id: numberField(row, "profile_id"),
    ftp_server_id: nullableNumberField(row, "ftp_server_id"),
    shared_index_group_id: nullableNumberField(row, "shared_index_group_id"),
    status: persistedScanStatus(row.status),
    trigger: scanTrigger(row.trigger),
    progress_percent: numberField(row, "progress_percent"),
    scan_mode: nullableScanMode(row.scan_mode),
    entries_seen: numberField(row, "entries_seen"),
    files_seen: numberField(row, "files_seen"),
    directories_seen: numberField(row, "directories_seen"),
    media_items_added: numberField(row, "media_items_added"),
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

function nullableScanMode(value: unknown): ScanMode | null {
  switch (value) {
    case null:
      return null;
    case "full":
    case "incremental":
    case "force":
      return value;
    default:
      throw new Error(`${SCAN_JOB_ROW_ERROR}: scan_mode`);
  }
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

function scanTargetKind(value: unknown): ScanJobRow["target_kind"] {
  switch (value) {
    case "profile_server":
    case undefined:
    case null:
      return "profile_server";
    case "shared_group":
      return "shared_group";
    default:
      throw new Error(`${SCAN_JOB_ROW_ERROR}: target_kind`);
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

function targetKey(row: ScanJobRow) {
  return row.target_kind === "shared_group" ? `shared:${row.shared_index_group_id}` : `profile:${row.profile_id}`;
}
