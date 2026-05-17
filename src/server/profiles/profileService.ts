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
import {
  canonicalRootPaths,
  generateSharedIndexKey,
  hashSharedIndexKey,
  keyHintFromName,
  serverMatchesSharedIndexGroup,
} from "../shared/sharedIndex.js";

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
  uncategorized?: boolean;
};

export type LibraryLayout = "auto" | "folders" | "flat";
export type StreamDeliveryMode = "proxy" | "direct";
export type AdminSource = "environment" | "database" | null;

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
  sharedIndex: SharedIndexLink | null;
};

export type SharedIndexLink = {
  id: number;
  name: string;
  keyHint: string;
};

export type SharedIndexGroup = {
  id: number;
  keyHint: string;
  name: string;
  host: string;
  port: number;
  tlsMode: FtpConfig["tlsMode"];
  allowInvalidCertificate: boolean;
  rootPaths: string[];
  libraryLayout: LibraryLayout;
  catalogContentTypes: CatalogContentTypes;
  enabled: boolean;
  autoLinkImports: boolean;
  masterProfileFtpServerId: number | null;
  indexedMediaCount: number;
  lastIndexedAt: string | null;
  linkedServers: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminProfileSummary = {
  id: number;
  browserUid: string;
  createdAt: string;
  updatedAt: string;
  lastUnlockedAt: string | null;
  lastCountryCode: string | null;
  adminEnabled: boolean;
  adminSource: AdminSource;
  ftpServers: number;
  configuredFtpServers: number;
  indexedItems: number;
  lastScanAt: string | null;
  pendingScans: number;
};

export type AdminProfileList = {
  summary: {
    profiles: number;
    configuredProfiles: number;
    ftpServers: number;
    configuredFtpServers: number;
    indexedItems: number;
    pendingScans: number;
  };
  profiles: AdminProfileSummary[];
};

export type FtpServerCatalogSettings = {
  id: number;
  name: string;
  customization: Pick<AddonCustomization, "catalogEnabled" | "catalogContentTypes" | "libraryLayout" | "streamDeliveryMode">;
};

export type FtpServerInput = {
  name?: string;
  ftpConfig?: FtpConfig;
  customization?: Partial<AddonCustomization>;
  sharedIndexKey?: string;
};

export const DEFAULT_ADDON_CUSTOMIZATION: AddonCustomization = {
  addonName: "Stremio FTP Addon",
  addonLogoUrl: "",
  addonDescription:
    "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
  catalogEnabled: false,
  catalogTmdbApiKey: "",
  catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
  libraryLayout: "auto",
  streamDeliveryMode: "proxy",
  streamNameTemplate: DEFAULT_STREAM_NAME_TEMPLATE,
  streamDescriptionTemplate: DEFAULT_STREAM_DESCRIPTION_TEMPLATE,
};

function catalogContentTypesFromRow(row: {
  catalog_content_movies: number | null;
  catalog_content_series: number | null;
  catalog_content_anime: number | null;
  catalog_content_uncategorized?: number | null;
}): CatalogContentTypes {
  return {
    movies: row.catalog_content_movies === null ? true : Boolean(row.catalog_content_movies),
    series: row.catalog_content_series === null ? true : Boolean(row.catalog_content_series),
    anime: row.catalog_content_anime === null ? false : Boolean(row.catalog_content_anime),
    uncategorized: row.catalog_content_uncategorized === null || row.catalog_content_uncategorized === undefined
      ? true
      : Boolean(row.catalog_content_uncategorized),
  };
}

function adminSourceFor(browserUid: string, databaseAdminEnabled: boolean, environmentAdminBrowserUids: ReadonlySet<string>): AdminSource {
  if (environmentAdminBrowserUids.has(browserUid)) return "environment";
  if (databaseAdminEnabled) return "database";
  return null;
}

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

  async createProfile(browserUid: string, passphrase: string, countryCode: string | null = null) {
    const token = randomToken();
    const now = new Date().toISOString();
    const passphraseVerifier = await createPassphraseVerifier(passphrase);
    let result: Database.RunResult;
    try {
      result = this.db.transaction(() => {
        const created = this.db
          .prepare(`
            insert into profiles (browser_uid, passphrase_verifier, install_token_hash, last_country_code, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)
          `)
          .run(browserUid, passphraseVerifier, hashToken(token), countryCode, now, now);
        this.insertDefaultServer(Number(created.lastInsertRowid), now);
        return created;
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes("profiles.browser_uid")) throw new DuplicateProfileError();
      throw error;
    }
    return { profileId: Number(result.lastInsertRowid), installUrlToken: token };
  }

  async unlockProfile(browserUid: string, passphrase: string, countryCode: string | null = null) {
    const row = this.db.prepare("select id, passphrase_verifier from profiles where browser_uid = ?").get(browserUid) as
      | { id: number; passphrase_verifier: string }
      | undefined;
    if (!row || !(await verifyPassphrase(passphrase, row.passphrase_verifier))) throw new Error("Invalid passphrase");
    const now = new Date().toISOString();
    if (countryCode) {
      this.db.prepare("update profiles set last_unlocked_at = ?, last_country_code = ?, updated_at = ? where id = ?").run(
        now,
        countryCode,
        now,
        row.id,
      );
    } else {
      this.db.prepare("update profiles set last_unlocked_at = ? where id = ?").run(now, row.id);
    }
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
               catalog_content_anime, catalog_content_uncategorized, library_layout, stream_delivery_mode,
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
          catalog_content_uncategorized: number | null;
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
      catalogContentTypes: catalogContentTypesFromRow(row),
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
            catalog_content_uncategorized = ?,
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
        contentTypes.uncategorized === false ? 0 : 1,
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
               catalog_content_anime, catalog_content_uncategorized, library_layout, stream_delivery_mode
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
          catalog_content_uncategorized: number | null;
          library_layout: LibraryLayout | null;
          stream_delivery_mode: StreamDeliveryMode | null;
        }
      | undefined;
    if (!row) throw new ProfileNotFoundError();
    return {
      ...profileCustomization,
      catalogEnabled: Boolean(row.catalog_enabled),
      catalogTmdbApiKey: profileCustomization.catalogTmdbApiKey,
      catalogContentTypes: catalogContentTypesFromRow(row),
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
            catalog_content_uncategorized = ?,
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
        contentTypes.uncategorized === false ? 0 : 1,
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

  isAdminBrowserUid(browserUid: string, environmentAdminBrowserUids: ReadonlySet<string>): boolean {
    if (environmentAdminBrowserUids.has(browserUid)) return true;
    const row = this.db.prepare("select admin_enabled from profiles where browser_uid = ?").get(browserUid) as
      | { admin_enabled: number }
      | undefined;
    return Boolean(row?.admin_enabled);
  }

  setProfileAdminEnabled(profileId: number, adminEnabled: boolean, environmentAdminBrowserUids: ReadonlySet<string>) {
    const result = this.db
      .prepare("update profiles set admin_enabled = ?, updated_at = ? where id = ?")
      .run(adminEnabled ? 1 : 0, new Date().toISOString(), profileId);
    if (result.changes === 0) throw new ProfileNotFoundError();
    const row = this.db.prepare("select browser_uid, admin_enabled from profiles where id = ?").get(profileId) as {
      browser_uid: string;
      admin_enabled: number;
    };
    const adminSource = adminSourceFor(row.browser_uid, Boolean(row.admin_enabled), environmentAdminBrowserUids);
    return { profileId, adminEnabled: adminSource !== null, adminSource };
  }

  createSharedIndexGroupFromServer(
    profileId: number,
    serverId: number,
    input: { name: string; keyHint?: string; autoLinkImports?: boolean; enabled?: boolean },
  ): { group: SharedIndexGroup; sharedIndexKey: string } {
    const server = this.getFtpServer(profileId, serverId);
    if (!server.ftpConfig) throw new Error("FTP settings are not configured");
    const customization = server.customization;
    const now = new Date().toISOString();
    const sharedIndexKey = generateSharedIndexKey();
    const keyHint = input.keyHint?.trim() || keyHintFromName(input.name);
    const content = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
    const result = this.db
      .prepare(
        `
        insert into shared_index_groups (
          key_hint, name, shared_index_key_hash, host, port, tls_mode, allow_invalid_certificate,
          root_paths_json, library_layout, catalog_content_json, enabled, auto_link_imports,
          master_profile_ftp_server_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        keyHint,
        input.name.trim() || server.name,
        hashSharedIndexKey(sharedIndexKey),
        server.ftpConfig.host.trim().toLowerCase(),
        server.ftpConfig.port,
        server.ftpConfig.tlsMode,
        server.ftpConfig.allowInvalidCertificate ? 1 : 0,
        JSON.stringify(canonicalRootPaths(server.ftpConfig.roots)),
        customization.libraryLayout ?? "auto",
        JSON.stringify({
          movies: content.movies,
          series: content.series,
          anime: content.anime,
          uncategorized: content.uncategorized !== false,
        }),
        input.enabled === false ? 0 : 1,
        input.autoLinkImports === false ? 0 : 1,
        serverId,
        now,
        now,
      );
    return { group: this.getSharedIndexGroup(Number(result.lastInsertRowid))!, sharedIndexKey };
  }

  getSharedIndexGroup(groupId: number): SharedIndexGroup | null {
    const row = this.db.prepare("select * from shared_index_groups where id = ?").get(groupId) as SharedIndexGroupRow | undefined;
    return row ? this.sharedIndexGroupFromRow(row) : null;
  }

  listSharedIndexGroups(): SharedIndexGroup[] {
    const rows = this.db.prepare("select * from shared_index_groups order by name asc, id asc").all() as SharedIndexGroupRow[];
    return rows.map((row) => this.sharedIndexGroupFromRow(row));
  }

  resolveApprovedSharedIndexKey(profileId: number, serverId: number, sharedIndexKey: string): SharedIndexGroup | null {
    const server = this.getFtpServer(profileId, serverId);
    if (!server.ftpConfig) return null;
    const row = this.db
      .prepare(
        `
        select *
        from shared_index_groups
        where shared_index_key_hash = ?
          and enabled = 1
          and auto_link_imports = 1
        limit 1
      `,
      )
      .get(hashSharedIndexKey(sharedIndexKey)) as SharedIndexGroupRow | undefined;
    if (!row) return null;
    const group = this.sharedIndexGroupFromRow(row);
    return serverMatchesSharedIndexGroup(server.ftpConfig, group) ? group : null;
  }

  linkServerToSharedGroup(profileId: number, serverId: number, groupId: number, sharedIndexKey?: string) {
    const server = this.getFtpServer(profileId, serverId);
    const group = this.getSharedIndexGroup(groupId);
    if (!server.ftpConfig || !group || !serverMatchesSharedIndexGroup(server.ftpConfig, group)) {
      throw new Error("FTP server does not match shared index group");
    }
    const result = this.db
      .prepare(
        `
        update profile_ftp_servers
        set shared_index_group_id = ?,
            shared_index_key_hash = ?,
            scan_interval_minutes = 0,
            next_scheduled_scan_at = null,
            pending_scan_after = null,
            updated_at = ?
        where profile_id = ? and id = ?
      `,
      )
      .run(groupId, sharedIndexKey ? hashSharedIndexKey(sharedIndexKey) : null, new Date().toISOString(), profileId, serverId);
    if (result.changes === 0) throw new ProfileNotFoundError();
    return this.getFtpServer(profileId, serverId);
  }

  unlinkServerFromSharedGroup(profileId: number, serverId: number) {
    const result = this.db
      .prepare(
        `
        update profile_ftp_servers
        set shared_index_group_id = null,
            shared_index_key_hash = null,
            scan_interval_minutes = 0,
            next_scheduled_scan_at = null,
            updated_at = ?
        where profile_id = ? and id = ?
      `,
      )
      .run(new Date().toISOString(), profileId, serverId);
    if (result.changes === 0) throw new ProfileNotFoundError();
    return this.getFtpServer(profileId, serverId);
  }

  listAdminProfileSummaries(environmentAdminBrowserUids: ReadonlySet<string> = new Set()): AdminProfileList {
    const rows = this.db
      .prepare(
        `
        select
          p.id,
          p.browser_uid,
          p.created_at,
          p.updated_at,
          p.last_unlocked_at,
          p.last_country_code,
          p.admin_enabled,
          count(s.id) as ftp_servers,
          coalesce(sum(case when s.encrypted_ftp_config is not null then 1 else 0 end), 0) as configured_ftp_servers,
          coalesce(sum(s.indexed_media_count), 0) as indexed_items,
          max(s.last_indexed_at) as last_scan_at,
          coalesce(sum(case when s.pending_scan_after is not null then 1 else 0 end), 0) as pending_scans
        from profiles p
        left join profile_ftp_servers s on s.profile_id = p.id
        group by p.id
        order by p.created_at desc, p.id desc
      `,
      )
      .all() as Array<{
      id: number;
      browser_uid: string;
      created_at: string;
      updated_at: string;
      last_unlocked_at: string | null;
      last_country_code: string | null;
      admin_enabled: number;
      ftp_servers: number;
      configured_ftp_servers: number;
      indexed_items: number;
      last_scan_at: string | null;
      pending_scans: number;
    }>;

    const profiles = rows.map((row) => {
      const adminSource = adminSourceFor(row.browser_uid, Boolean(row.admin_enabled), environmentAdminBrowserUids);
      return {
        id: row.id,
        browserUid: row.browser_uid,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastUnlockedAt: row.last_unlocked_at,
        lastCountryCode: row.last_country_code,
        adminEnabled: adminSource !== null,
        adminSource,
        ftpServers: row.ftp_servers,
        configuredFtpServers: row.configured_ftp_servers,
        indexedItems: row.indexed_items,
        lastScanAt: row.last_scan_at,
        pendingScans: row.pending_scans,
      };
    });

    return {
      summary: {
        profiles: profiles.length,
        configuredProfiles: profiles.filter((profile) => profile.configuredFtpServers > 0).length,
        ftpServers: profiles.reduce((sum, profile) => sum + profile.ftpServers, 0),
        configuredFtpServers: profiles.reduce((sum, profile) => sum + profile.configuredFtpServers, 0),
        indexedItems: profiles.reduce((sum, profile) => sum + profile.indexedItems, 0),
        pendingScans: profiles.reduce((sum, profile) => sum + profile.pendingScans, 0),
      },
      profiles,
    };
  }

  listFtpServers(profileId: number): FtpServer[] {
    const rows = this.db
      .prepare("select * from profile_ftp_servers where profile_id = ? order by id asc")
      .all(profileId) as FtpServerRow[];
    if (!rows.length) throw new ProfileNotFoundError();
    return rows.map((row) => this.ftpServerFromRow(row));
  }

  listFtpServerCatalogSettings(profileId: number): FtpServerCatalogSettings[] {
    const profileCustomization = this.getAddonCustomization(profileId);
    const rows = this.db
      .prepare(
        `
        select id, name, catalog_enabled, catalog_content_movies, catalog_content_series,
               catalog_content_anime, catalog_content_uncategorized, library_layout, stream_delivery_mode
        from profile_ftp_servers
        where profile_id = ?
        order by id asc
      `,
      )
      .all(profileId) as Array<{
      id: number;
      name: string;
      catalog_enabled: number;
      catalog_content_movies: number | null;
      catalog_content_series: number | null;
      catalog_content_anime: number | null;
      catalog_content_uncategorized: number | null;
      library_layout: LibraryLayout | null;
      stream_delivery_mode: StreamDeliveryMode | null;
    }>;
    if (!rows.length) throw new ProfileNotFoundError();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      customization: {
        catalogEnabled: Boolean(row.catalog_enabled),
        catalogContentTypes: catalogContentTypesFromRow(row),
        libraryLayout: row.library_layout || profileCustomization.libraryLayout || "auto",
        streamDeliveryMode: row.stream_delivery_mode || profileCustomization.streamDeliveryMode || "proxy",
      },
    }));
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
          catalog_content_uncategorized,
          library_layout, stream_delivery_mode, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.customization?.catalogContentTypes?.uncategorized === false ? 0 : 1,
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
    const draft = !config.username?.trim() || !config.password;
    const pendingScanAfter = !draft && debounceScan ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
    const result = this.db
      .prepare(
        `
        update profile_ftp_servers
        set encrypted_ftp_config = ?, pending_scan_after = ?, updated_at = ?
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

  setProfileAndServersStreamDeliveryMode(profileId: number, streamDeliveryMode: StreamDeliveryMode) {
    const now = new Date().toISOString();
    const profileResult = this.db
      .prepare("update profiles set stream_delivery_mode = ?, updated_at = ? where id = ?")
      .run(streamDeliveryMode, now, profileId);
    if (profileResult.changes === 0) throw new ProfileNotFoundError();

    const serversResult = this.db
      .prepare("update profile_ftp_servers set stream_delivery_mode = ?, updated_at = ? where profile_id = ?")
      .run(streamDeliveryMode, now, profileId);
    return { profileId, serversUpdated: serversResult.changes };
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

  schedulePendingScan(profileId: number, serverId: number, pendingScanAfter: string) {
    const result = this.db
      .prepare("update profile_ftp_servers set pending_scan_after = ?, updated_at = ? where profile_id = ? and id = ?")
      .run(pendingScanAfter, new Date().toISOString(), profileId, serverId);
    if (result.changes === 0) throw new ProfileNotFoundError();
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

  deleteEmptyProfilesOlderThan(cutoffIso: string): number {
    const rows = this.db
      .prepare(
        `
        select p.id
        from profiles p
        where p.created_at < ?
          and p.encrypted_ftp_config is null
          and not exists (
            select 1 from profile_ftp_servers s
            where s.profile_id = p.id and s.encrypted_ftp_config is not null
          )
      `,
      )
      .all(cutoffIso) as Array<{ id: number }>;
    if (!rows.length) return 0;
    const stmt = this.db.prepare("delete from profiles where id = ?");
    const removeAll = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id);
    });
    removeAll(rows.map((row) => row.id));
    return rows.length;
  }

  deleteProfile(profileId: number): boolean {
    const result = this.db.prepare("delete from profiles where id = ?").run(profileId);
    return result.changes > 0;
  }

  browserUidForProfile(profileId: number): string | null {
    const row = this.db.prepare("select browser_uid from profiles where id = ?").get(profileId) as
      | { browser_uid: string }
      | undefined;
    return row?.browser_uid ?? null;
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
    const profileCustomization = this.getAddonCustomization(row.profile_id);
    return {
      id: row.id,
      profileId: row.profile_id,
      name: row.name,
      ftpConfig: row.encrypted_ftp_config ? decryptJson<FtpConfig>(row.encrypted_ftp_config, this.encryptionKey) : null,
      customization: {
        ...profileCustomization,
        catalogEnabled: Boolean(row.catalog_enabled),
        catalogTmdbApiKey: profileCustomization.catalogTmdbApiKey,
        catalogContentTypes: {
          movies: Boolean(row.catalog_content_movies),
          series: Boolean(row.catalog_content_series),
          anime: Boolean(row.catalog_content_anime),
          uncategorized: row.catalog_content_uncategorized !== 0,
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
      sharedIndex: row.shared_index_group_id ? this.sharedIndexLink(row.shared_index_group_id) : null,
    };
  }

  private sharedIndexLink(groupId: number): SharedIndexLink | null {
    const row = this.db.prepare("select id, name, key_hint from shared_index_groups where id = ?").get(groupId) as
      | { id: number; name: string; key_hint: string }
      | undefined;
    return row ? { id: row.id, name: row.name, keyHint: row.key_hint } : null;
  }

  private sharedIndexGroupFromRow(row: SharedIndexGroupRow): SharedIndexGroup {
    const linked = this.db.prepare("select count(*) as count from profile_ftp_servers where shared_index_group_id = ?").get(row.id) as {
      count: number;
    };
    return {
      id: row.id,
      keyHint: row.key_hint,
      name: row.name,
      host: row.host,
      port: row.port,
      tlsMode: row.tls_mode,
      allowInvalidCertificate: Boolean(row.allow_invalid_certificate),
      rootPaths: parseJsonArray(row.root_paths_json),
      libraryLayout: row.library_layout,
      catalogContentTypes: parseCatalogContentTypes(row.catalog_content_json),
      enabled: Boolean(row.enabled),
      autoLinkImports: Boolean(row.auto_link_imports),
      masterProfileFtpServerId: row.master_profile_ftp_server_id,
      indexedMediaCount: row.indexed_media_count,
      lastIndexedAt: row.last_indexed_at,
      linkedServers: linked.count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
  catalog_content_uncategorized: number;
  library_layout: LibraryLayout;
  stream_delivery_mode: StreamDeliveryMode;
  indexed_media_count: number;
  last_indexed_at: string | null;
  last_ftp_tested_at: string | null;
  last_ftp_test_ok: number | null;
  scan_interval_minutes: number;
  next_scheduled_scan_at: string | null;
  pending_scan_after: string | null;
  shared_index_group_id: number | null;
  shared_index_key_hash: string | null;
};

type SharedIndexGroupRow = {
  id: number;
  key_hint: string;
  name: string;
  shared_index_key_hash: string;
  host: string;
  port: number;
  tls_mode: FtpConfig["tlsMode"];
  allow_invalid_certificate: number;
  root_paths_json: string;
  library_layout: LibraryLayout;
  catalog_content_json: string;
  enabled: number;
  auto_link_imports: number;
  master_profile_ftp_server_id: number | null;
  indexed_media_count: number;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
};

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseCatalogContentTypes(value: string): CatalogContentTypes {
  try {
    const parsed = JSON.parse(value) as Partial<CatalogContentTypes>;
    return {
      movies: parsed.movies !== false,
      series: parsed.series !== false,
      anime: parsed.anime === true,
      uncategorized: parsed.uncategorized !== false,
    };
  } catch {
    return { movies: true, series: true, anime: false, uncategorized: true };
  }
}
