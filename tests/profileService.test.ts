import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { ProfileService } from "../src/server/profiles/profileService";

const key = "0123456789abcdef0123456789abcdef";

describe("ProfileService", () => {
  it("creates, unlocks, and rotates install tokens", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);

    const created = await service.createProfile("browser-uid", "passphrase");
    expect(created.installUrlToken).toHaveLength(32);

    const unlocked = await service.unlockProfile("browser-uid", "passphrase");
    expect(unlocked.profileId).toBe(created.profileId);
    await expect(service.unlockProfile("browser-uid", "wrong")).rejects.toThrow("Invalid passphrase");

    const rotated = service.rotateInstallToken(created.profileId);
    expect(rotated.installUrlToken).not.toBe(created.installUrlToken);
  });

  it("stores encrypted ftp config", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const created = await service.createProfile("browser-uid", "passphrase");

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

  it("saves scan schedule settings and lists due profiles", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const created = await service.createProfile("browser-uid", "passphrase");
    service.saveFtpConfig(created.profileId, {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "explicit",
      allowInvalidCertificate: true,
      roots: ["/Media"],
    });

    service.saveScanSchedule(created.profileId, {
      intervalMinutes: 360,
      nextScheduledScanAt: "2026-05-03T06:00:00.000Z",
    });

    expect(service.getScanSchedule(created.profileId)).toEqual({
      intervalMinutes: 360,
      nextScheduledScanAt: "2026-05-03T06:00:00.000Z",
    });
    expect(service.dueScheduledScanProfileIds("2026-05-03T05:59:59.000Z")).toEqual([]);
    expect(service.dueScheduledScanProfileIds("2026-05-03T06:00:00.000Z")).toEqual([created.profileId]);
  });

  it("removes only profiles with no FTP-configured server older than the cutoff", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const empty = await service.createProfile("empty-uid", "passphrase");
    const recent = await service.createProfile("recent-uid", "passphrase");
    const configured = await service.createProfile("configured-uid", "passphrase");
    service.saveFtpConfig(configured.profileId, {
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "explicit",
      allowInvalidCertificate: true,
      roots: ["/"],
    });

    db.prepare("update profiles set created_at = ? where id in (?, ?)").run(
      "2026-01-01T00:00:00.000Z",
      empty.profileId,
      configured.profileId,
    );

    const removed = service.deleteEmptyProfilesOlderThan("2026-04-01T00:00:00.000Z");
    expect(removed).toBe(1);
    expect(db.prepare("select id from profiles where id = ?").get(empty.profileId)).toBeUndefined();
    expect(db.prepare("select id from profiles where id = ?").get(recent.profileId)).toBeDefined();
    expect(db.prepare("select id from profiles where id = ?").get(configured.profileId)).toBeDefined();
  });
});
