import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { ProfileService } from "../src/server/profiles/profileService";

const key = "0123456789abcdef0123456789abcdef";

describe("ProfileService", () => {
  it("creates, unlocks, and rotates install tokens", () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);

    const created = service.createProfile("browser-uid", "passphrase");
    expect(created.installUrlToken).toHaveLength(32);

    const unlocked = service.unlockProfile("browser-uid", "passphrase");
    expect(unlocked.profileId).toBe(created.profileId);
    expect(() => service.unlockProfile("browser-uid", "wrong")).toThrow("Invalid passphrase");

    const rotated = service.rotateInstallToken(created.profileId);
    expect(rotated.installUrlToken).not.toBe(created.installUrlToken);
  });

  it("stores encrypted ftp config", () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const created = service.createProfile("browser-uid", "passphrase");

    service.saveFtpConfig(created.profileId, {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "explicit",
      allowInvalidCertificate: true,
      roots: ["/Media"],
    });

    const row = db.prepare("select encrypted_ftp_config from profiles where id = ?").get(created.profileId) as {
      encrypted_ftp_config: string;
    };
    expect(row.encrypted_ftp_config).not.toContain("secret");
    expect(service.getFtpConfig(created.profileId)?.host).toBe("ftp.example.test");
  });

  it("throws when saving ftp config for a missing profile", () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);

    expect(() =>
      service.saveFtpConfig(404, {
        host: "ftp.example.test",
        port: 21,
        username: "user",
        password: "secret",
        tlsMode: "explicit",
        allowInvalidCertificate: true,
        roots: ["/Media"],
      }),
    ).toThrow("Profile not found");
  });

  it("throws when rotating install token for a missing profile", () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);

    expect(() => service.rotateInstallToken(404)).toThrow("Profile not found");
  });
});
