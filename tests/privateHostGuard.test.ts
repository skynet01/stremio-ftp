import { describe, expect, it, vi } from "vitest";
import { blockPrivateFtpHosts, PRIVATE_FTP_HOST_MESSAGE } from "../src/server/ftp/privateHostGuard";
import type { FtpConfig } from "../src/server/profiles/profileService";

function ftpConfig(host: string): FtpConfig {
  return { host, port: 21, username: "user", password: "secret", tlsMode: "none", allowInvalidCertificate: false, roots: ["/"] };
}

describe("blockPrivateFtpHosts", () => {
  const client = { list: async () => [], openReadStream: async () => { throw new Error("not used"); }, close: async () => undefined };

  it("refuses private addresses without logging in", async () => {
    const factory = vi.fn(async () => client);
    const lookup = vi.fn(async () => ["8.8.8.8"]);
    const guarded = blockPrivateFtpHosts(factory, lookup);

    await expect(guarded(ftpConfig("ftp://192.168.68.72:13017"))).rejects.toThrow(PRIVATE_FTP_HOST_MESSAGE);
    expect(factory).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses hostnames that resolve to a private address", async () => {
    const factory = vi.fn(async () => client);
    const guarded = blockPrivateFtpHosts(factory, async () => ["203.0.113.5", "10.0.0.8"]);

    await expect(guarded(ftpConfig("nas.example.test"))).rejects.toThrow(PRIVATE_FTP_HOST_MESSAGE);
    expect(factory).not.toHaveBeenCalled();
  });

  it("logs in to public hosts and leaves failed lookups to the login", async () => {
    const factory = vi.fn(async () => client);
    await expect(blockPrivateFtpHosts(factory, async () => ["203.0.113.5"])(ftpConfig("ftp.example.test"))).resolves.toBe(client);
    await expect(blockPrivateFtpHosts(factory, async () => { throw new Error("ENOTFOUND"); })(ftpConfig("missing.example.test"))).resolves.toBe(client);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
