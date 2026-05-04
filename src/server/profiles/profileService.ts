import type Database from "better-sqlite3";
import {
  createPassphraseVerifier,
  decryptJson,
  encryptJson,
  hashToken,
  randomToken,
  verifyPassphrase,
} from "../security/crypto.js";
import { DEFAULT_STREAM_DESCRIPTION_TEMPLATE, DEFAULT_STREAM_NAME_TEMPLATE } from "../../shared/streamFormatter.js";

export type FtpConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  tlsMode: "none" | "explicit" | "implicit";
  allowInvalidCertificate: boolean;
  roots: string[];
};

export type AddonCustomization = {
  addonName: string;
  addonLogoUrl: string;
  addonDescription: string;
  catalogEnabled: boolean;
  catalogTmdbApiKey?: string;
  catalogContentTypes?: CatalogContentTypes;
  libraryLayout?: LibraryLayout;
  streamDeliveryMode?: StreamDeliveryMode;
  streamNameTemplate?: string;
  streamDescriptionTemplate?: string;
};

export type CatalogContentTypes = {
  movies: boolean;
  series: boolean;
  anime: boolean;
};

export type LibraryLayout = "auto" | "folders" | "flat";
export type StreamDeliveryMode = "proxy" | "direct";

export type IndexStatus = {
  lastScanAt: string | null;
  mediaItems: number;
};

export type ScanSchedule = {
  intervalMinutes: number;
  nextScheduledScanAt: string | null;
};

export type ConnectionStatus = {
  lastTestedAt: string | null;
  ok: boolean | null;
};

export type FtpServer = {
  id: number;
  profileId: number;
  name: string;
  ftpConfig: FtpConfig | null;
  customization: AddonCustomization;
  indexStatus: IndexStatus;
  scanSchedule: ScanSchedule;
  connectionStatus: ConnectionStatus;
  pendingScanAfter: string | null;
};

export type FtpServerInput = {
  name?: string;
  ftpConfig?: FtpConfig;
  customization?: Partial<AddonCustomization>;
};

export const DEFAULT_ADDON_CUSTOMIZATION: AddonCustomization = {
  addonName: "Stremio FTP Addon",
  addonLogoUrl: "",
  addonDescription:
    "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
  catalogEnabled: false,
  catalogTmdbApiKey: "",
  catalogContentTypes: { movies: true, series: true, anime: false },
  libraryLayout: "auto",
  streamDeliveryMode: "proxy",
  streamNameTemplate: DEFAULT_STREAM_NAME_TEMPLATE,
  streamDescriptionTemplate: DEFAULT_STREAM_DESCRIPTION_TEMPLATE,
};

export class DuplicateProfileError extends Error {
  constructor() {
    super("Profile already exists");
  }
}

export class ProfileNotFoundError extends Error {
  constructor() {
    super("Profile not found");
  }
}

export class ProfileService {
  constructor(
    private readonly db: Database.Database,
    private readonly encryptionKey: string,
  ) {}

  get database() {
    return this.db;
  }

  async createProfile(browserUid: string, passphrase: string) {
    const token = randomToken();
    const now = new Date().toISOString();
    const passphraseVerifier = await createPassphraseVerifier(passphrase);
    let result: Database.RunResult;
    try {
      result = this.db.transaction(() => {
        const created = this.db
          .prepare(`
            insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at)
            values (?, ?, ?, ?, ?)
          `)
          .run(browserUid, passphraseVerifier, hashToken(token), now, now);
        this.insertDefaultServer(Number(created.lastInsertRowid), now);
        return created;
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes("profiles.browser_uid")) throw new DuplicateProfileError();
      throw error;
    }
    return { profileId: Number(result.lastInsertRowid), installUrlToken: token };
  }

  async unlockProfile(browserUid: string, passphrase: string) {
    const row = this.db.prepare("select id, passphrase_verifier from profiles where browser_uid = ?").get(browserUid) as
      | { id: number; passphrase_verifier: string }
      | undefined;
    if (!row || !(await verifyPassphrase(passphrase, row.passphrase_verifier))) throw new Error("Invalid passphrase");
    this.db.prepare("update profiles set last_unlocked_at = ? where id = ?").run(new Date().toISOString(), row.id);
    return { profileId: row.id };
  }

  saveFtpConfig(profileId: number, config: FtpConfig) {
    const serverId = this.defaultFtpServerId(profileId);
    this.saveFtpServerConfig(profileId, serverId, config);
    const encrypted = encryptJson(config, this.encryptionKey);
    const result = this.db
      .prepare("update profiles set encrypted_ftp_config = ?, updated_at = ? where id = ?")
      .run(encrypted, new Date().toISOString(), profileId);
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  getFtpConfig(profileId: number): FtpConfig | null {
    return this.getFtpServerConfig(profileId, this.defaultFtpServerId(profileId));
  }

  getFtpServerConfig(profileId: number, serverId: number): FtpConfig | null {
    const row = this.db
      .prepare("select encrypted_ftp_config from profile_ftp_servers where profile_id = ? and id = ?")
      .get(profileId, serverId) as
      | { encrypted_ftp_config: string | null }
      | undefined;
    if (!row?.encrypted_ftp_config) return null;
    return decryptJson<FtpConfig>(row.encrypted_ftp_config, this.encryptionKey);
  }

  getAddonCustomization(profileId: number): AddonCustomization {
    const row = this.db
      .prepare(
        `
        select addon_name, addon_logo_url, addon_description, catalog_enabled,
               catalog_tmdb_api_key, catalog_content_movies, catalog_content_series,
               catalog_content_anime, library_layout, stream_delivery_mode,
               stream_name_template, stream_description_template
        from profiles
        where id = ?
      `,
      )
      .get(profileId) as
      | {
          addon_name: string | null;
          addon_logo_url: string | null;
          addon_description: string | null;
          catalog_enabled: number;
          catalog_tmdb_api_key: string | null;
          catalog_content_movies: number | null;
          catalog_content_series: number | null;
          catalog_content_anime: number | null;
          library_layout: LibraryLayout | null;
          stream_delivery_mode: StreamDeliveryMode | null;
          stream_name_template: string | null;
          stream_description_template: string | null;
        }
      | undefined;
    if (!row) throw new ProfileNotFoundError();
    return {
      addonName: row.addon_name?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonName,
      addonLogoUrl: row.addon_logo_url?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonLogoUrl,
      addonDescription: row.addon_description?.trim() || DEFAULT_ADDON_CUSTOMIZATION.addonDescription,
      catalogEnabled: Boolean(row.catalog_enabled),
      catalogTmdbApiKey: row.catalog_tmdb_api_key?.trim() || "",
      catalogContentTypes: {
        movies: row.catalog_content_movies === null ? true : Boolean(row.catalog_content_movies),
        series: row.catalog_content_series === null ? true : Boolean(row.catalog_content_series),
        anime: row.catalog_content_anime === null ? false : Boolean(row.catalog_content_anime),
      },
      libraryLayout: row.library_layout || "auto",
      streamDeliveryMode: row.stream_delivery_mode || "proxy",
      streamNameTemplate: row.stream_name_template?.trim() || DEFAULT_ADDON_CUSTOMIZATION.streamNameTemplate,
      streamDescriptionTemplate: row.stream_description_template?.trim() || DEFAULT_ADDON_CUSTOMIZATION.streamDescriptionTemplate,
    };
  }

  saveAddonCustomization(profileId: number, customization: AddonCustomization) {
    const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
    const libraryLayout = customization.libraryLayout ?? DEFAULT_ADDON_CUSTOMIZATION.libraryLayout!;
    const streamDeliveryMode = customization.streamDeliveryMode ?? DEFAULT_ADDON_CUSTOMIZATION.streamDeliveryMode!;
    const streamNameTemplate = customization.streamNameTemplate?.trim() || DEFAULT_ADDON_CUSTOMIZATION.streamNameTemplate!;
    const streamDescriptionTemplate =
      customization.streamDescriptionTemplate?.trim() || DEFAULT_ADDON_CUSTOMIZATION.streamDescriptionTemplate!;
    const result = this.db
      .prepare(
        `
        update profiles
        set addon_name = ?,
            addon_logo_url = ?,
            addon_description = ?,
            catalog_enabled = ?,
            catalog_tmdb_api_key = ?,
            catalog_content_movies = ?,
            catalog_content_series = ?,
            catalog_content_anime = ?,
            library_layout = ?,
            stream_delivery_mode = ?,
            stream_name_template = ?,
            stream_description_template = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        customization.addonName,
        customization.addonLogoUrl,
        customization.addonDescription,
        customization.catalogEnabled ? 1 : 0,
        customization.catalogTmdbApiKey?.trim() || "",
        contentTypes.movies ? 1 : 0,
        contentTypes.series ? 1 : 0,
        contentTypes.anime ? 1 : 0,
        libraryLayout,
        streamDeliveryMode,
        streamNameTemplate,
        streamDescriptionTemplate,
        new Date().toISOString(),
        profileId,
    );
    if (result.changes === 0) throw new ProfileNotFoundError();
    this.saveFtpServerCustomization(profileId, this.defaultFtpServerId(profileId), customization, false);
  }

  getFtpServerCustomization(profileId: number, serverId: number): AddonCustomization {
    const profileCustomization = this.getAddonCustomization(profileId);
    const row = this.db
      .prepare(
        `
        select catalog_enabled, catalog_tmdb_api_key, catalog_content_movies, catalog_content_series,
               catalog_content_anime, library_layout, stream_delivery_mode
        from profile_ftp_servers
        where profile_id = ? and id = ?
      `,
      )
      .get(profileId, serverId) as
      | {
          catalog_enabled: number;
          catalog_tmdb_api_key: string | null;
          catalog_content_movies: number | null;
          catalog_content_series: number | null;
          catalog_content_anime: number | null;
          library_layout: LibraryLayout | null;
          stream_delivery_mode: StreamDeliveryMode | null;
        }
      | undefined;
    if (!row) throw new ProfileNotFoundError();
    return {
      ...profileCustomization,
      catalogEnabled: Boolean(row.catalog_enabled),
      catalogTmdbApiKey: row.catalog_tmdb_api_key?.trim() || "",
      catalogContentTypes: {
        movies: row.catalog_content_movies === null ? true : Boolean(row.catalog_content_movies),
        series: row.catalog_content_series === null ? true : Boolean(row.catalog_content_series),
        anime: row.catalog_content_anime === null ? false : Boolean(row.catalog_content_anime),
      },
      libraryLayout: row.library_layout || "auto",
      streamDeliveryMode: row.stream_delivery_mode || "proxy",
    };
  }

  saveFtpServerCustomization(profileId: number, serverId: number, customization: Partial<AddonCustomization>, debounceScan = false) {
    const existing = this.getFtpServerCustomization(profileId, serverId);
    const next = { ...existing, ...customization };
    const contentTypes = next.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
    const libraryLayout = next.libraryLayout ?? DEFAULT_ADDON_CUSTOMIZATION.libraryLayout!;
    const streamDeliveryMode = next.streamDeliveryMode ?? DEFAULT_ADDON_CUSTOMIZATION.streamDeliveryMode!;
    const now = new Date().toISOString();
    const pendingScanAfter = debounceScan ? new Date(Date.now() + 5 * 60_000).toISOString() : this.getFtpServer(profileId, serverId).pendingScanAfter;
    const result = this.db
      .prepare(
        `
        update profile_ftp_servers
        set catalog_enabled = ?,
            catalog_tmdb_api_key = ?,
            catalog_content_movies = ?,
            catalog_content_series = ?,
            catalog_content_anime = ?,
            library_layout = ?,
            stream_delivery_mode = ?,
            pending_scan_after = ?,
            updated_at = ?
        where profile_id = ? and id = ?
      `,
      )
      .run(
        next.catalogEnabled ? 1 : 0,
        next.catalogTmdbApiKey?.trim() || "",
        contentTypes.movies ? 1 : 0,
        contentTypes.series ? 1 : 0,
        contentTypes.anime ? 1 : 0,
        libraryLayout,
        streamDeliveryMode,
        pendingScanAfter,
        now,
        profileId,
        serverId,
      );
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  getIndexStatus(profileId: number): IndexStatus {
    return this.getFtpServerIndexStatus(profileId, this.defaultFtpServerId(profileId));
  }

  getFtpServerIndexStatus(profileId: number, serverId: number): IndexStatus {
    const row = this.db.prepare("select last_indexed_at, indexed_media_count from profiles where id = ?").get(profileId) as
      | { last_indexed_at: string | null; indexed_media_count: number }
      | undefined;
    const serverRow = this.db
      .prepare("select last_indexed_at, indexed_media_count from profile_ftp_servers where profile_id = ? and id = ?")
      .get(profileId, serverId) as { last_indexed_at: string | null; indexed_media_count: number } | undefined;
    if (!serverRow && !row) throw new ProfileNotFoundError();
    return {
      lastScanAt: serverRow?.last_indexed_at ?? row?.last_indexed_at ?? null,
      mediaItems: serverRow?.indexed_media_count ?? row?.indexed_media_count ?? 0,
    };
  }

  saveIndexStatus(profileId: number, status: IndexStatus) {
    this.saveFtpServerIndexStatus(profileId, this.defaultFtpServerId(profileId), status);
  }

  saveFtpServerIndexStatus(profileId: number, serverId: number, status: IndexStatus) {
    const result = this.db
      .prepare("update profiles set last_indexed_at = ?, indexed_media_count = ?, updated_at = ? where id = ?")
      .run(status.lastScanAt, status.mediaItems, new Date().toISOString(), profileId);
    const serverResult = this.db
      .prepare(
        `
        update profile_ftp_servers
        set last_indexed_at = ?, indexed_media_count = ?, pending_scan_after = null, updated_at = ?
        where profile_id = ? and id = ?
      `,
      )
      .run(status.lastScanAt, status.mediaItems, new Date().toISOString(), profileId, serverId);
    if (result.changes === 0 || serverResult.changes === 0) throw new ProfileNotFoundError();
  }

  getScanSchedule(profileId: number): ScanSchedule {
    return this.getFtpServerScanSchedule(profileId, this.defaultFtpServerId(profileId));
  }

  getFtpServerScanSchedule(profileId: number, serverId: number): ScanSchedule {
    const row = this.db.prepare("select scan_interval_minutes, next_scheduled_scan_at from profiles where id = ?").get(profileId) as
      | { scan_interval_minutes: number; next_scheduled_scan_at: string | null }
      | undefined;
    const serverRow = this.db
      .prepare("select scan_interval_minutes, next_scheduled_scan_at from profile_ftp_servers where profile_id = ? and id = ?")
      .get(profileId, serverId) as { scan_interval_minutes: number; next_scheduled_scan_at: string | null } | undefined;
    if (!serverRow && !row) throw new ProfileNotFoundError();
    return {
      intervalMinutes: serverRow?.scan_interval_minutes ?? row?.scan_interval_minutes ?? 0,
      nextScheduledScanAt: serverRow?.next_scheduled_scan_at ?? row?.next_scheduled_scan_at ?? null,
    };
  }

  saveScanSchedule(profileId: number, schedule: ScanSchedule) {
    this.saveFtpServerScanSchedule(profileId, this.defaultFtpServerId(profileId), schedule);
  }

  saveFtpServerScanSchedule(profileId: number, serverId: number, schedule: ScanSchedule) {
    const result = this.db
      .prepare("update profiles set scan_interval_minutes = ?, next_scheduled_scan_at = ?, updated_at = ? where id = ?")
      .run(schedule.intervalMinutes, schedule.nextScheduledScanAt, new Date().toISOString(), profileId);
    const serverResult = this.db
      .prepare(
        "update profile_ftp_servers set scan_interval_minutes = ?, next_scheduled_scan_at = ?, updated_at = ? where profile_id = ? and id = ?",
      )
      .run(schedule.intervalMinutes, schedule.nextScheduledScanAt, new Date().toISOString(), profileId, serverId);
    if (result.changes === 0 || serverResult.changes === 0) throw new ProfileNotFoundError();
  }

  dueScheduledScanProfileIds(nowIso: string): number[] {
    const rows = this.db
      .prepare(
        `
        select id
        from profiles
        where scan_interval_minutes > 0
          and next_scheduled_scan_at is not null
          and next_scheduled_scan_at <= ?
          and encrypted_ftp_config is not null
        order by next_scheduled_scan_at asc, id asc
      `,
      )
      .all(nowIso) as { id: number }[];
    return rows.map((row) => row.id);
  }

  dueScheduledScanServerIds(nowIso: string): Array<{ profileId: number; serverId: number }> {
    const rows = this.db
      .prepare(
        `
        select profile_id, id
        from profile_ftp_servers
        where encrypted_ftp_config is not null
          and (
            (pending_scan_after is not null and pending_scan_after <= ?)
            or (scan_interval_minutes > 0 and next_scheduled_scan_at is not null and next_scheduled_scan_at <= ?)
          )
        order by coalesce(pending_scan_after, next_scheduled_scan_at) asc, profile_id asc, id asc
      `,
      )
      .all(nowIso, nowIso) as { profile_id: number; id: number }[];
    return rows.map((row) => ({ profileId: row.profile_id, serverId: row.id }));
  }

  getConnectionStatus(profileId: number): ConnectionStatus {
    return this.getFtpServerConnectionStatus(profileId, this.defaultFtpServerId(profileId));
  }

  getFtpServerConnectionStatus(profileId: number, serverId: number): ConnectionStatus {
    const row = this.db.prepare("select last_ftp_tested_at, last_ftp_test_ok from profiles where id = ?").get(profileId) as
      | { last_ftp_tested_at: string | null; last_ftp_test_ok: number | null }
      | undefined;
    const serverRow = this.db
      .prepare("select last_ftp_tested_at, last_ftp_test_ok from profile_ftp_servers where profile_id = ? and id = ?")
      .get(profileId, serverId) as { last_ftp_tested_at: string | null; last_ftp_test_ok: number | null } | undefined;
    if (!serverRow && !row) throw new ProfileNotFoundError();
    return {
      lastTestedAt: serverRow?.last_ftp_tested_at ?? row?.last_ftp_tested_at ?? null,
      ok:
        (serverRow?.last_ftp_test_ok ?? row?.last_ftp_test_ok ?? null) === null
          ? null
          : Boolean(serverRow?.last_ftp_test_ok ?? row?.last_ftp_test_ok),
    };
  }

  saveConnectionStatus(profileId: number, status: ConnectionStatus) {
    this.saveFtpServerConnectionStatus(profileId, this.defaultFtpServerId(profileId), status);
  }

  saveFtpServerConnectionStatus(profileId: number, serverId: number, status: ConnectionStatus) {
    const result = this.db
      .prepare("update profiles set last_ftp_tested_at = ?, last_ftp_test_ok = ?, updated_at = ? where id = ?")
      .run(status.lastTestedAt, status.ok === null ? null : status.ok ? 1 : 0, new Date().toISOString(), profileId);
    const serverResult = this.db
      .prepare(
        "update profile_ftp_servers set last_ftp_tested_at = ?, last_ftp_test_ok = ?, updated_at = ? where profile_id = ? and id = ?",
      )
      .run(status.lastTestedAt, status.ok === null ? null : status.ok ? 1 : 0, new Date().toISOString(), profileId, serverId);
    if (result.changes === 0 || serverResult.changes === 0) throw new ProfileNotFoundError();
  }

  listFtpServers(profileId: number): FtpServer[] {
    const rows = this.db
      .prepare("select * from profile_ftp_servers where profile_id = ? order by id asc")
      .all(profileId) as FtpServerRow[];
    if (!rows.length) throw new ProfileNotFoundError();
    return rows.map((row) => this.ftpServerFromRow(row));
  }

  getFtpServer(profileId: number, serverId: number): FtpServer {
    const row = this.db
      .prepare("select * from profile_ftp_servers where profile_id = ? and id = ?")
      .get(profileId, serverId) as FtpServerRow | undefined;
    if (!row) throw new ProfileNotFoundError();
    return this.ftpServerFromRow(row);
  }

  createFtpServer(profileId: number, input: FtpServerInput = {}) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        insert into profile_ftp_servers (
          profile_id, name, encrypted_ftp_config, catalog_enabled, catalog_tmdb_api_key,
          catalog_content_movies, catalog_content_series, catalog_content_anime,
          library_layout, stream_delivery_mode, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        profileId,
        input.name?.trim() || `Server ${this.listFtpServers(profileId).length + 1}`,
        input.ftpConfig ? encryptJson(input.ftpConfig, this.encryptionKey) : null,
        input.customization?.catalogEnabled ? 1 : 0,
        input.customization?.catalogTmdbApiKey?.trim() || "",
        input.customization?.catalogContentTypes?.movies === false ? 0 : 1,
        input.customization?.catalogContentTypes?.series === false ? 0 : 1,
        input.customization?.catalogContentTypes?.anime === true ? 1 : 0,
        input.customization?.libraryLayout ?? "auto",
        input.customization?.streamDeliveryMode ?? "proxy",
        now,
        now,
      );
    return this.getFtpServer(profileId, Number(result.lastInsertRowid));
  }

  saveFtpServer(profileId: number, serverId: number, input: FtpServerInput) {
    if (input.ftpConfig) this.saveFtpServerConfig(profileId, serverId, input.ftpConfig);
    if (input.customization) this.saveFtpServerCustomization(profileId, serverId, input.customization, true);
    if (input.name !== undefined) this.renameFtpServer(profileId, serverId, input.name);
    return this.getFtpServer(profileId, serverId);
  }

  saveFtpServerConfig(profileId: number, serverId: number, config: FtpConfig, debounceScan = true) {
    const now = new Date().toISOString();
    const pendingScanAfter = debounceScan ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
    const result = this.db
      .prepare(
        `
        update profile_ftp_servers
        set encrypted_ftp_config = ?, pending_scan_after = coalesce(?, pending_scan_after), updated_at = ?
        where profile_id = ? and id = ?
      `,
      )
      .run(encryptJson(config, this.encryptionKey), pendingScanAfter, now, profileId, serverId);
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  renameFtpServer(profileId: number, serverId: number, name: string) {
    const result = this.db
      .prepare("update profile_ftp_servers set name = ?, updated_at = ? where profile_id = ? and id = ?")
      .run(name.trim() || "FTP Server", new Date().toISOString(), profileId, serverId);
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  deleteFtpServer(profileId: number, serverId: number) {
    const servers = this.listFtpServers(profileId);
    if (servers.length <= 1) throw new Error("At least one FTP server is required");
    const result = this.db.prepare("delete from profile_ftp_servers where profile_id = ? and id = ?").run(profileId, serverId);
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  defaultFtpServerId(profileId: number): number {
    const row = this.db
      .prepare("select id from profile_ftp_servers where profile_id = ? order by id asc limit 1")
      .get(profileId) as { id: number } | undefined;
    if (!row) throw new ProfileNotFoundError();
    return row.id;
  }

  clearPendingScan(profileId: number, serverId: number) {
    this.db
      .prepare("update profile_ftp_servers set pending_scan_after = null, updated_at = ? where profile_id = ? and id = ?")
      .run(new Date().toISOString(), profileId, serverId);
  }

  rotateInstallToken(profileId: number) {
    const token = randomToken();
    const result = this.db
      .prepare("update profiles set install_token_hash = ?, updated_at = ? where id = ?")
      .run(hashToken(token), new Date().toISOString(), profileId);
    if (result.changes === 0) throw new ProfileNotFoundError();
    return { installUrlToken: token };
  }

  issueInstallToken(profileId: number) {
    const exists = this.db.prepare("select id from profiles where id = ?").get(profileId);
    if (!exists) throw new ProfileNotFoundError();
    const token = randomToken();
    this.db
      .prepare("insert into profile_install_tokens (profile_id, token_hash, created_at) values (?, ?, ?)")
      .run(profileId, hashToken(token), new Date().toISOString());
    return { installUrlToken: token };
  }

  profileIdForInstallToken(token: string): number | null {
    const tokenHash = hashToken(token);
    const profileRow = this.db.prepare("select id from profiles where install_token_hash = ?").get(tokenHash) as
      | { id: number }
      | undefined;
    if (profileRow) return profileRow.id;

    const issuedRow = this.db.prepare("select profile_id from profile_install_tokens where token_hash = ?").get(tokenHash) as
      | { profile_id: number }
      | undefined;
    return issuedRow?.profile_id ?? null;
  }

  private insertDefaultServer(profileId: number, now: string) {
    this.db
      .prepare(
        `
        insert into profile_ftp_servers (profile_id, name, created_at, updated_at)
        values (?, 'Server 1', ?, ?)
      `,
      )
      .run(profileId, now, now);
  }

  private ftpServerFromRow(row: FtpServerRow): FtpServer {
    return {
      id: row.id,
      profileId: row.profile_id,
      name: row.name,
      ftpConfig: row.encrypted_ftp_config ? decryptJson<FtpConfig>(row.encrypted_ftp_config, this.encryptionKey) : null,
      customization: {
        ...this.getAddonCustomization(row.profile_id),
        catalogEnabled: Boolean(row.catalog_enabled),
        catalogTmdbApiKey: row.catalog_tmdb_api_key?.trim() || "",
        catalogContentTypes: {
          movies: Boolean(row.catalog_content_movies),
          series: Boolean(row.catalog_content_series),
          anime: Boolean(row.catalog_content_anime),
        },
        libraryLayout: row.library_layout,
        streamDeliveryMode: row.stream_delivery_mode,
      },
      indexStatus: { lastScanAt: row.last_indexed_at, mediaItems: row.indexed_media_count },
      scanSchedule: { intervalMinutes: row.scan_interval_minutes, nextScheduledScanAt: row.next_scheduled_scan_at },
      connectionStatus: {
        lastTestedAt: row.last_ftp_tested_at,
        ok: row.last_ftp_test_ok === null ? null : Boolean(row.last_ftp_test_ok),
      },
      pendingScanAfter: row.pending_scan_after,
    };
  }
}

type FtpServerRow = {
  id: number;
  profile_id: number;
  name: string;
  encrypted_ftp_config: string | null;
  catalog_enabled: number;
  catalog_tmdb_api_key: string | null;
  catalog_content_movies: number;
  catalog_content_series: number;
  catalog_content_anime: number;
  library_layout: LibraryLayout;
  stream_delivery_mode: StreamDeliveryMode;
  indexed_media_count: number;
  last_indexed_at: string | null;
  last_ftp_tested_at: string | null;
  last_ftp_test_ok: number | null;
  scan_interval_minutes: number;
  next_scheduled_scan_at: string | null;
  pending_scan_after: string | null;
};
