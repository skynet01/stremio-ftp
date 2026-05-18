import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db/schema";
import { ProfileService } from "../src/server/profiles/profileService";
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

    const listed = service.listSharedIndexGroups();
    expect(listed[0]).toMatchObject({ id: created.group.id, name: "Sputnik Main", linkedServers: 1 });
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

  it("clears the master reference when a linked master server is deleted", async () => {
    const { service, profileId, serverId } = await serviceWithServer();
    service.createFtpServer(profileId, { name: "Replacement" });
    const created = service.createSharedIndexGroupFromServer(profileId, serverId, {
      name: "Sputnik Main",
      keyHint: "sputnik-main",
    });

    service.deleteFtpServer(profileId, serverId);

    expect(service.getSharedIndexGroup(created.group.id)?.masterProfileFtpServerId).toBeNull();
  });
});
