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
  tlsMode: "none" | "explicit";
  allowInvalidCertificate: boolean;
  roots: string[];
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

  rotateInstallToken(profileId: number) {
    const token = randomToken();
    const result = this.db
      .prepare("update profiles set install_token_hash = ?, updated_at = ? where id = ?")
      .run(hashToken(token), new Date().toISOString(), profileId);
    if (result.changes === 0) throw new ProfileNotFoundError();
    return { installUrlToken: token };
  }

  profileIdForInstallToken(token: string): number | null {
    const row = this.db.prepare("select id from profiles where install_token_hash = ?").get(hashToken(token)) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }
}
