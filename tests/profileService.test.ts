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

  it("uses profile TMDB keys before server TMDB keys", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const created = await service.createProfile("browser-uid", "passphrase");
    const serverId = service.defaultFtpServerId(created.profileId);

    service.saveFtpServerCustomization(created.profileId, serverId, {
      catalogEnabled: true,
      catalogTmdbApiKey: "server-key",
      catalogContentTypes: { movies: true, series: true, anime: false, uncategorized: true },
    });

    expect(service.getFtpServerCustomization(created.profileId, serverId).catalogTmdbApiKey).toBe("server-key");

    db.prepare("update profiles set catalog_tmdb_api_key = ? where id = ?").run("profile-key", created.profileId);

    expect(service.getFtpServerCustomization(created.profileId, serverId).catalogTmdbApiKey).toBe("profile-key");
  });

  it("stores catalog order per FTP server and normalizes invalid stored values", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const created = await service.createProfile("browser-sort", "passphrase");
    const firstServerId = service.defaultFtpServerId(created.profileId);
    const second = service.createFtpServer(created.profileId, { customization: { catalogSort: "newest" } });

    expect(service.getFtpServerCustomization(created.profileId, firstServerId).catalogSort).toBe("alphabetical");
    expect(service.getFtpServerCustomization(created.profileId, second.id).catalogSort).toBe("newest");

    service.saveFtpServerCustomization(created.profileId, firstServerId, { catalogSort: "newest" });
    expect(service.getFtpServer(created.profileId, firstServerId).customization.catalogSort).toBe("newest");
    expect(service.getFtpServer(created.profileId, second.id).customization.catalogSort).toBe("newest");

    db.prepare("update profile_ftp_servers set catalog_sort = 'recent' where id = ?").run(second.id);
    expect(service.getFtpServerCustomization(created.profileId, second.id).catalogSort).toBe("alphabetical");
  });

  it("uses enrichment results for per-server catalog counts when available", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const service = new ProfileService(db, key);
    const created = await service.createProfile("browser-uid", "passphrase");
    const serverId = service.defaultFtpServerId(created.profileId);
    const now = "2026-05-24T00:00:00.000Z";

    db.prepare(
      `
      insert into catalog_enrichment (
        profile_id, ftp_server_id, item_key, media_kind, catalog_kind, parsed_title, status,
        meta_id, meta_type, meta_name, algorithm_version, attempts, last_seen_at, created_at, updated_at
      ) values
        (?, ?, 'movie||waterworld|1995', 'movie', 'movie', 'waterworld', 'matched', 'tt0114898', 'movie', 'Waterworld', 3, 1, ?, ?, ?),
        (?, ?, 'series||prisoner of beauty|', 'series', 'series', 'prisoner of beauty', 'unmatched', null, null, null, 3, 1, ?, ?, ?),
        (?, ?, 'series||anime show|', 'series', 'anime', 'anime show', 'matched', 'tt1234567', 'series', 'Anime Show', 3, 1, ?, ?, ?)
    `,
    ).run(created.profileId, serverId, now, now, now, created.profileId, serverId, now, now, now, created.profileId, serverId, now, now, now);

    expect(service.ftpServerCatalogItemCounts(created.profileId, serverId)).toEqual({
      movies: 1,
      series: 0,
      anime: 1,
      uncategorized: 1,
    });
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
