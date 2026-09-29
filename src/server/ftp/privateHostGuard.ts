import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateNetworkHost, splitFtpHost } from "../../shared/ftpHost.js";
import type { AbortableFtpClientFactory } from "./ftpConnectionLimiter.js";

export const PRIVATE_FTP_HOST_MESSAGE = "Private network addresses are not allowed on this server. Use the FTP server's public hostname.";

type HostLookup = (host: string) => Promise<string[]>;

const lookupAddresses: HostLookup = async (host) => (await dnsLookup(host, { all: true })).map((entry) => entry.address);

// Refuses logins to private, loopback, and link-local addresses, including hostnames that resolve to one.
export function blockPrivateFtpHosts(factory: AbortableFtpClientFactory, lookup: HostLookup = lookupAddresses): AbortableFtpClientFactory {
  return async (config, options) => {
    const { host } = splitFtpHost(config.host);
    if (isPrivateNetworkHost(host)) throw new Error(PRIVATE_FTP_HOST_MESSAGE);
    if (!isIP(host)) {
      // A failed lookup is left to the login itself, which reports it the usual way.
      const addresses = await lookup(host).catch(() => []);
      if (addresses.some((address) => isPrivateNetworkHost(address))) throw new Error(PRIVATE_FTP_HOST_MESSAGE);
    }
    return factory(config, options);
  };
}
