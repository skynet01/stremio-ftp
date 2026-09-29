import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../src/server/db/schema";
import { MediaRepository } from "../src/server/media/mediaRepository";
import { ProfileService } from "../src/server/profiles/profileService";
import { createFtpProxyResolver } from "../src/server/proxy/ftpProxyResolver";
import { canonicalRootPaths, hashSharedIndexKey, serverMatchesSharedIndexGroup } from "../src/server/shared/sharedIndex";

const key = "0123456789abcdef0123456789abcdef";

async function serviceWithServer() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const service = new ProfileService(db, key);
  const created = await service.createProfile(`browser-${Math.random()}`, "passphrase");
  const serverId = service.defaultFtpServerId(created.profileId);
  service.saveFtpServerConfig(created.profileId, serverId, {
    host: "Sputnik.Whatbox.ca",
    port: 21,
    username: "user",
    password: "secret",
    tlsMode: "explicit",
    allowInvalidCertificate: false,
    roots: ["/media/", "/TV"],
  }, false);
  return { db, service, profileId: created.profileId, serverId };
}

function insertLocalIndexRows(db: Database.Database, profileId: number, serverId: number) {
  db.prepare(
    `
      insert into media_files (
        profile_id, ftp_server_id, ftp_path, filename, normalized_filename, extension, media_kind, catalog_kind,
        parsed_title, parsed_year, confidence, last_seen_at
      ) values (?, ?, '/media/Local.Movie.2020.mkv', 'Local.Movie.2020.mkv', 'local movie', 'mkv', 'movie', 'movie', 'local movie', 2020, 90, 'n')
    `,
  ).run(profileId, serverId);
  db.prepare(
    "insert into scan_directory_snapshots (profile_id, ftp_server_id, dir_path, entry_count, fingerprint, last_seen_at) values (?, ?, '/media', 1, 'f', 'n')",
  ).run(profileId, serverId);
  db.prepare(
    `
      insert into catalog_enrichment (
        profile_id, ftp_server_id, item_key, media_kind, catalog_kind, parsed_title, parsed_year,
        status, meta_id, meta_type, meta_name, algorithm_version, attempts, last_seen_at, created_at, updated_at
      ) values (?, ?, 'movie||local movie|2020', 'movie', 'movie', 'local movie', 2020, 'matched', 'tt7654321', 'movie', 'Local Movie', 3, 1, 'n', 'n', 'n')
    `,
  ).run(profileId, serverId);
}

function localIndexRowCounts(db: Database.Database, serverId: number) {
  const count = (table: string) => db.prepare(`select count(*) from ${table} where ftp_server_id = ?`).pluck().get(serverId) as number;
  return { mediaFiles: count("media_files"), snapshots: count("scan_directory_snapshots"), enrichment: count("catalog_enrichment") };
}

describe("shared index groups", () => {
  it("canonicalizes roots and hashes keys without storing raw values", () => {
    expect(canonicalRootPaths(["/media/", "TV", "/media"])).toEqual(["/media", "/TV"]);
    expect(hashSharedIndexKey("shared-key")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSharedIndexKey("shared-key")).toBe(hashSharedIndexKey("shared-key"));
  });

  it("creates groups with hashed keys and safe list output", async () => {
    const { db, service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });

    expect(created.sharedIndexKey).toHaveLength(43);
    expect(created.group.name).toBe("Sputnik Main");
    expect(created.group.keyHint).toBe("sputnik-main");

    const row = db.prepare("select shared_index_key_hash from shared_index_groups where id = ?").get(created.group.id) as {
      shared_index_key_hash: string;
    };
    expect(row.shared_index_key_hash).toBe(hashSharedIndexKey(created.sharedIndexKey));
    expect(row.shared_index_key_hash).not.toContain(created.sharedIndexKey);

    db.prepare(
      `
        insert into shared_media_files (
          shared_index_group_id, ftp_path, filename, normalized_filename, extension, size_bytes,
          media_kind, catalog_kind, parsed_title, parsed_year, imdb_id, confidence, last_seen_at
        ) values (?, ?, ?, ?, 'mkv', 1024, ?, ?, ?, ?, ?, ?, '2026-05-17T00:00:00.000Z')
      `,
    ).run(created.group.id, "/media/Movie.mkv", "Movie.mkv", "movie.mkv", "movie", "movie", "Movie", 2020, null, 90);
    db.prepare(
      `
        insert into shared_media_files (
          shared_index_group_id, ftp_path, filename, normalized_filename, extension, size_bytes,
          media_kind, catalog_kind, parsed_title, parsed_year, imdb_id, confidence, last_seen_at
        ) values (?, ?, ?, ?, 'mkv', 1024, ?, ?, ?, ?, ?, ?, '2026-05-17T00:00:00.000Z')
      `,
    ).run(created.group.id, "/media/Anime.mkv", "Anime.mkv", "anime.mkv", "series", "anime", "Anime", null, "tt1234567", 60);
    db.prepare(
      `
        insert into shared_media_files (
          shared_index_group_id, ftp_path, filename, normalized_filename, extension, size_bytes,
          media_kind, catalog_kind, parsed_title, parsed_year, imdb_id, confidence, last_seen_at
        ) values (?, ?, ?, ?, 'mkv', 1024, ?, ?, ?, ?, ?, ?, '2026-05-17T00:00:00.000Z')
      `,
    ).run(created.group.id, "/media/Maybe.mkv", "Maybe.mkv", "maybe.mkv", "movie", "movie", "Maybe", null, null, 70);

    const listed = service.listSharedIndexGroups();
    expect(listed[0]).toMatchObject({
      id: created.group.id,
      name: "Sputnik Main",
      linkedServers: 1,
      catalogItemCounts: { movies: 2, anime: 1, series: 0, uncategorized: 0 },
    });
    expect(JSON.stringify(listed)).not.toContain(created.sharedIndexKey);
    expect(JSON.stringify(listed)).not.toContain("secret");
  });

  it("auto-links only when key and server identity match", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });

    const linked = service.resolveApprovedSharedIndexKey(profileId, serverId, created.sharedIndexKey);
    expect(linked?.id).toBe(created.group.id);

    service.saveFtpServerConfig(profileId, serverId, {
      host: "other.whatbox.ca",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "explicit",
      allowInvalidCertificate: false,
      roots: ["/media", "/TV"],
    }, false);

    expect(service.resolveApprovedSharedIndexKey(profileId, serverId, created.sharedIndexKey)).toBeNull();
    expect(service.resolveApprovedSharedIndexKey(profileId, serverId, "wrong-key")).toBeNull();
  });

  it("links and unlinks profile servers without deleting credentials", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });

    service.linkServerToSharedGroup(profileId, serverId, created.group.id, created.sharedIndexKey);
    expect(service.getFtpServer(profileId, serverId).sharedIndex?.id).toBe(created.group.id);
    expect(service.getFtpServerConfig(profileId, serverId)?.password).toBe("secret");

    service.unlinkServerFromSharedGroup(profileId, serverId);
    expect(service.getFtpServer(profileId, serverId).sharedIndex).toBeNull();
    expect(service.getFtpServerConfig(profileId, serverId)?.password).toBe("secret");
  });

  it("syncs linked server catalog content from the shared group", async () => {
    const { db, service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Adult Sputnik",
      keyHint: "adult-sputnik",
    });
    db.prepare("update shared_index_groups set catalog_content_json = ? where id = ?").run(
      JSON.stringify({ movies: false, series: false, anime: false, uncategorized: true }),
      created.group.id,
    );
    const linked = await service.createProfile("linked-browser", "passphrase");
    const linkedServerId = service.defaultFtpServerId(linked.profileId);
    service.saveFtpServerConfig(linked.profileId, linkedServerId, service.getFtpServerConfig(profileId, serverId)!, false);

    service.linkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id, created.sharedIndexKey);

    expect(service.getFtpServer(linked.profileId, linkedServerId).customization.catalogContentTypes).toEqual({
      movies: false,
      series: false,
      anime: false,
      uncategorized: true,
    });
  });

  it("keeps catalog order independent between a shared master and linked server", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    service.saveFtpServerCustomization(profileId, serverId, { catalogSort: "newest" });
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });
    const linked = await service.createProfile("linked-sort-browser", "passphrase");
    const linkedServerId = service.defaultFtpServerId(linked.profileId);
    service.saveFtpServerConfig(linked.profileId, linkedServerId, service.getFtpServerConfig(profileId, serverId)!, false);

    service.linkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id, created.sharedIndexKey);
    expect(service.getFtpServer(linked.profileId, linkedServerId).customization.catalogSort).toBe("alphabetical");
    expect(service.getFtpServer(profileId, serverId).customization.catalogSort).toBe("newest");

    service.saveFtpServerCustomization(linked.profileId, linkedServerId, { catalogSort: "newest" });
    service.saveFtpServerCustomization(profileId, serverId, { catalogSort: "alphabetical" });
    expect(service.getFtpServer(linked.profileId, linkedServerId).customization.catalogSort).toBe("newest");
    expect(service.getFtpServer(profileId, serverId).customization.catalogSort).toBe("alphabetical");
  });

  it("force-links by replacing linked server roots with the shared group roots", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });
    const linked = await service.createProfile("force-linked-browser", "passphrase");
    const linkedServerId = service.defaultFtpServerId(linked.profileId);
    service.saveFtpServerConfig(linked.profileId, linkedServerId, {
      host: "sputnik.whatbox.ca",
      port: 21,
      username: "linked",
      password: "secret",
      tlsMode: "explicit",
      allowInvalidCertificate: false,
      roots: ["/JFC"],
    }, false);

    expect(() => service.linkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id)).toThrow(
      "FTP server does not match shared index group",
    );

    service.forceLinkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id);

    expect(service.getFtpServer(linked.profileId, linkedServerId).sharedIndex?.id).toBe(created.group.id);
    expect(service.getFtpServerConfig(linked.profileId, linkedServerId)?.roots).toEqual(["/media", "/TV"]);
    expect(service.getFtpServerConfig(linked.profileId, linkedServerId)?.username).toBe("linked");
  });

  it("syncs shared group catalog content when auto-linking with a shared index key", async () => {
    const { db, service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Adult Sputnik",
      keyHint: "adult-sputnik",
    });
    db.prepare("update shared_index_groups set catalog_content_json = ? where id = ?").run(
      JSON.stringify({ movies: false, series: false, anime: false, uncategorized: true }),
      created.group.id,
    );
    const linked = await service.createProfile("auto-linked-browser", "passphrase");
    const linkedServerId = service.defaultFtpServerId(linked.profileId);

    service.saveFtpServer(linked.profileId, linkedServerId, {
      sharedIndexKey: created.sharedIndexKey,
      ftpConfig: service.getFtpServerConfig(profileId, serverId)!,
      customization: {
        catalogEnabled: true,
        catalogContentTypes: { movies: true, series: true, anime: true, uncategorized: true },
      },
    });

    expect(service.getFtpServer(linked.profileId, linkedServerId).sharedIndex?.id).toBe(created.group.id);
    expect(service.getFtpServer(linked.profileId, linkedServerId).customization.catalogContentTypes).toEqual({
      movies: false,
      series: false,
      anime: false,
      uncategorized: true,
    });
  });

  it("uses master enrichment for shared group catalog counts", async () => {
    const { db, service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });
    const now = "2026-05-24T00:00:00.000Z";
    const insertShared = db.prepare(
      `
        insert into shared_media_files (
          shared_index_group_id, ftp_path, filename, normalized_filename, extension, size_bytes,
          media_kind, catalog_kind, parsed_title, parsed_year, imdb_id, confidence, last_seen_at
        ) values (?, ?, ?, ?, 'mkv', 1024, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    insertShared.run(created.group.id, "/media/Waterworld.1995.mkv", "Waterworld.1995.mkv", "waterworld.1995.mkv", "movie", "movie", "waterworld", 1995, null, 90, now);
    insertShared.run(created.group.id, "/media/Mystery.Show.S01E01.mkv", "Mystery.Show.S01E01.mkv", "mystery.show.s01e01.mkv", "series", "series", "mystery show", null, null, 95, now);

    db.prepare(
      `
        insert into catalog_enrichment (
          profile_id, ftp_server_id, item_key, media_kind, catalog_kind, parsed_title, parsed_year,
          status, meta_id, meta_type, meta_name, algorithm_version, attempts, last_seen_at, created_at, updated_at
        ) values
          (?, ?, 'movie||waterworld|1995', 'movie', 'movie', 'waterworld', 1995, 'matched', 'tt0114898', 'movie', 'Waterworld', 3, 1, ?, ?, ?),
          (?, ?, 'series||mystery show|', 'series', 'series', 'mystery show', null, 'unmatched', null, null, null, 3, 1, ?, ?, ?)
      `,
    ).run(profileId, serverId, now, now, now, profileId, serverId, now, now, now);

    expect(service.getSharedIndexGroup(created.group.id)?.catalogItemCounts).toEqual({
      movies: 1,
      series: 0,
      anime: 0,
      uncategorized: 1,
    });
  });

  it("syncs master server renames only when the shared group still uses the old server name", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    const serverName = service.getFtpServer(profileId, serverId).name;
    const synced = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: serverName,
      keyHint: "server-name",
    });

    service.saveFtpServer(profileId, serverId, { name: "Master Pool" });
    expect(service.getSharedIndexGroup(synced.group.id)?.name).toBe("Master Pool");

    service.updateSharedIndexGroup(synced.group.id, { name: "Custom Pool" });
    service.saveFtpServer(profileId, serverId, { name: "Display Name Only" });
    expect(service.getSharedIndexGroup(synced.group.id)?.name).toBe("Custom Pool");
  });

  it("prevents deleting a linked master server", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    service.createFtpServer(profileId, { name: "Replacement" });
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });

    expect(() => service.deleteFtpServer(profileId, serverId)).toThrow(/master source/);

    expect(service.getSharedIndexGroup(created.group.id)?.masterProfileFtpServerId).toBe(serverId);
  });

  it("clears local index rows when linking but keeps the master's shared enrichment", async () => {
    const { db, service, profileId, serverId } = await serviceWithServer();
    insertLocalIndexRows(db, profileId, serverId);
    const linked = await service.createProfile("stale-linked-browser", "passphrase");
    const linkedServerId = service.defaultFtpServerId(linked.profileId);
    service.saveFtpServerConfig(linked.profileId, linkedServerId, service.getFtpServerConfig(profileId, serverId)!, false);
    insertLocalIndexRows(db, linked.profileId, linkedServerId);
    const untouchedServerId = service.createFtpServer(linked.profileId, { name: "Untouched" }).id;
    insertLocalIndexRows(db, linked.profileId, untouchedServerId);

    const created = service.createSharedIndexGroupFromServer(profileId, serverId, { name: "Sputnik Main", keyHint: "sputnik-main" });
    expect(localIndexRowCounts(db, serverId)).toEqual({ mediaFiles: 0, snapshots: 0, enrichment: 1 });

    service.linkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id, created.sharedIndexKey);
    expect(localIndexRowCounts(db, linkedServerId)).toEqual({ mediaFiles: 0, snapshots: 0, enrichment: 0 });
    expect(localIndexRowCounts(db, untouchedServerId)).toEqual({ mediaFiles: 1, snapshots: 1, enrichment: 1 });

    service.setSharedIndexGroupMaster(created.group.id, profileId, serverId);
    expect(localIndexRowCounts(db, serverId)).toEqual({ mediaFiles: 0, snapshots: 0, enrichment: 1 });
  });

  it("schedules a prompt local rescan after unlinking a server", async () => {
    const { db, service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, { name: "Sputnik Main", keyHint: "sputnik-main" });
    const linked = await service.createProfile("unlink-rescan-browser", "passphrase");
    const linkedServerId = service.defaultFtpServerId(linked.profileId);
    const ftpConfig = service.getFtpServerConfig(profileId, serverId)!;
    service.saveFtpServerConfig(linked.profileId, linkedServerId, ftpConfig, false);
    service.linkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id, created.sharedIndexKey);
    expect(service.getFtpServer(linked.profileId, linkedServerId).pendingScanAfter).toBeNull();

    service.unlinkServerFromSharedGroup(linked.profileId, linkedServerId);
    const pendingAfterUnlink = service.getFtpServer(linked.profileId, linkedServerId).pendingScanAfter;
    expect(pendingAfterUnlink).toEqual(expect.any(String));
    expect(Date.parse(pendingAfterUnlink!)).toBeLessThanOrEqual(Date.now());
    expect(service.dueScheduledScanServerIds(new Date().toISOString())).toContainEqual({
      profileId: linked.profileId,
      serverId: linkedServerId,
      dueReason: "pending",
    });

    service.linkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id, created.sharedIndexKey);
    service.saveFtpServer(linked.profileId, linkedServerId, {
      ftpConfig: { ...ftpConfig, roots: ["/private"] },
      customization: { catalogEnabled: true },
      unlinkSharedIndex: true,
    });
    const pendingAfterSave = service.getFtpServer(linked.profileId, linkedServerId).pendingScanAfter;
    expect(service.getFtpServer(linked.profileId, linkedServerId).sharedIndex).toBeNull();
    expect(Date.parse(pendingAfterSave!)).toBeLessThanOrEqual(Date.now());
    expect(db.prepare("select pending_scan_after from profile_ftp_servers where id = ?").pluck().get(serverId)).toBeNull();
  });

  it("reads shared group identity without computing catalog counts", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, { name: "Sputnik Main", keyHint: "sputnik-main" });
    const counts = vi.spyOn(ProfileService.prototype as unknown as { sharedIndexGroupCatalogItemCounts: () => unknown }, "sharedIndexGroupCatalogItemCounts");

    const identity = service.getSharedIndexGroupIdentity(created.group.id);

    expect(identity).toMatchObject({
      id: created.group.id,
      name: "Sputnik Main",
      host: "sputnik.whatbox.ca",
      port: 21,
      tlsMode: "explicit",
      allowInvalidCertificate: false,
      rootPaths: ["/media", "/TV"],
      enabled: true,
      masterProfileFtpServerId: serverId,
      indexedMediaCount: 0,
      lastIndexedAt: null,
    });
    expect(identity).not.toHaveProperty("catalogItemCounts");
    expect(service.getSharedIndexGroupIdentity(9999)).toBeNull();
    expect(counts).not.toHaveBeenCalled();
    counts.mockRestore();
  });

  it("resolves shared proxy files without computing shared group catalog counts", async () => {
    const { db, service, profileId, serverId } = await serviceWithServer();
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, { name: "Sputnik Main", keyHint: "sputnik-main" });
    const linked = await service.createProfile("proxy-linked-browser", "passphrase");
    const linkedServerId = service.defaultFtpServerId(linked.profileId);
    service.saveFtpServerConfig(linked.profileId, linkedServerId, service.getFtpServerConfig(profileId, serverId)!, false);
    service.linkServerToSharedGroup(linked.profileId, linkedServerId, created.group.id, created.sharedIndexKey);
    const sharedMediaId = Number(
      db
        .prepare(
          `
            insert into shared_media_files (
              shared_index_group_id, ftp_path, filename, normalized_filename, extension, size_bytes,
              media_kind, catalog_kind, parsed_title, parsed_year, imdb_id, confidence, last_seen_at
            ) values (?, '/media/Movie.2020.mkv', 'Movie.2020.mkv', 'movie 2020', 'mkv', 1024, 'movie', 'movie', 'movie', 2020, null, 90, 'n')
          `,
        )
        .run(created.group.id).lastInsertRowid,
    );
    const counts = vi.spyOn(ProfileService.prototype as unknown as { sharedIndexGroupCatalogItemCounts: () => unknown }, "sharedIndexGroupCatalogItemCounts");
    const resolve = createFtpProxyResolver(service, new MediaRepository(db), async () => {
      throw new Error("not used");
    });

    const resolved = await resolve({ installToken: linked.installUrlToken, serverId: linkedServerId, sharedMediaId });

    expect(resolved).toMatchObject({ filename: "Movie.2020.mkv", sharedIndexGroupId: created.group.id, ftpServerId: linkedServerId });
    expect(counts).not.toHaveBeenCalled();
    counts.mockRestore();
  });
});
