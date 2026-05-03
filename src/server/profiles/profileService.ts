import type Database from "better-sqlite3";
import {
  createPassphraseVerifier,
  decryptJson,
  encryptJson,
  hashToken,
  randomToken,
  verifyPassphrase,
} from "../security/crypto.js";

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
};

export type CatalogContentTypes = {
  movies: boolean;
  series: boolean;
  anime: boolean;
};

export type LibraryLayout = "auto" | "folders" | "flat";

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

export const DEFAULT_ADDON_CUSTOMIZATION: AddonCustomization = {
  addonName: "Stremio FTP Addon",
  addonLogoUrl: "",
  addonDescription:
    "Stream movies and series episodes from your own FTP server as private Stremio sources, with proxy playback and an indexed library that stays on your server.",
  catalogEnabled: false,
  catalogTmdbApiKey: "",
  catalogContentTypes: { movies: true, series: true, anime: false },
  libraryLayout: "auto",
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
      result = this.db
        .prepare(`
          insert into profiles (browser_uid, passphrase_verifier, install_token_hash, created_at, updated_at)
          values (?, ?, ?, ?, ?)
        `)
        .run(browserUid, passphraseVerifier, hashToken(token), now, now);
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
    const encrypted = encryptJson(config, this.encryptionKey);
    const result = this.db
      .prepare("update profiles set encrypted_ftp_config = ?, updated_at = ? where id = ?")
      .run(encrypted, new Date().toISOString(), profileId);
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  getFtpConfig(profileId: number): FtpConfig | null {
    const row = this.db.prepare("select encrypted_ftp_config from profiles where id = ?").get(profileId) as
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
               catalog_content_anime, library_layout
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
    };
  }

  saveAddonCustomization(profileId: number, customization: AddonCustomization) {
    const contentTypes = customization.catalogContentTypes ?? DEFAULT_ADDON_CUSTOMIZATION.catalogContentTypes!;
    const libraryLayout = customization.libraryLayout ?? DEFAULT_ADDON_CUSTOMIZATION.libraryLayout!;
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
        new Date().toISOString(),
        profileId,
      );
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  getIndexStatus(profileId: number): IndexStatus {
    const row = this.db.prepare("select last_indexed_at, indexed_media_count from profiles where id = ?").get(profileId) as
      | { last_indexed_at: string | null; indexed_media_count: number }
      | undefined;
    if (!row) throw new ProfileNotFoundError();
    return {
      lastScanAt: row.last_indexed_at,
      mediaItems: row.indexed_media_count,
    };
  }

  saveIndexStatus(profileId: number, status: IndexStatus) {
    const result = this.db
      .prepare("update profiles set last_indexed_at = ?, indexed_media_count = ?, updated_at = ? where id = ?")
      .run(status.lastScanAt, status.mediaItems, new Date().toISOString(), profileId);
    if (result.changes === 0) throw new ProfileNotFoundError();
  }

  getScanSchedule(profileId: number): ScanSchedule {
    const row = this.db.prepare("select scan_interval_minutes, next_scheduled_scan_at from profiles where id = ?").get(profileId) as
      | { scan_interval_minutes: number; next_scheduled_scan_at: string | null }
      | undefined;
    if (!row) throw new ProfileNotFoundError();
    return {
      intervalMinutes: row.scan_interval_minutes,
      nextScheduledScanAt: row.next_scheduled_scan_at,
    };
  }

  saveScanSchedule(profileId: number, schedule: ScanSchedule) {
    const result = this.db
      .prepare("update profiles set scan_interval_minutes = ?, next_scheduled_scan_at = ?, updated_at = ? where id = ?")
      .run(schedule.intervalMinutes, schedule.nextScheduledScanAt, new Date().toISOString(), profileId);
    if (result.changes === 0) throw new ProfileNotFoundError();
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

  getConnectionStatus(profileId: number): ConnectionStatus {
    const row = this.db.prepare("select last_ftp_tested_at, last_ftp_test_ok from profiles where id = ?").get(profileId) as
      | { last_ftp_tested_at: string | null; last_ftp_test_ok: number | null }
      | undefined;
    if (!row) throw new ProfileNotFoundError();
    return {
      lastTestedAt: row.last_ftp_tested_at,
      ok: row.last_ftp_test_ok === null ? null : Boolean(row.last_ftp_test_ok),
    };
  }

  saveConnectionStatus(profileId: number, status: ConnectionStatus) {
    const result = this.db
      .prepare("update profiles set last_ftp_tested_at = ?, last_ftp_test_ok = ?, updated_at = ? where id = ?")
      .run(status.lastTestedAt, status.ok === null ? null : status.ok ? 1 : 0, new Date().toISOString(), profileId);
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
}
