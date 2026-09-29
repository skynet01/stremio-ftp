const FTP_SCHEME = /^(?:ftps?|ftpes):\/\//i;

// Users paste hosts like "ftp://example.com:2121/Movies"; keep only the hostname and any explicit port.
export function splitFtpHost(value: string): { host: string; port: number | null } {
  let host = value.trim().replace(FTP_SCHEME, "");
  const slash = host.indexOf("/");
  if (slash >= 0) host = host.slice(0, slash);

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) return { host: bracketed[1], port: validPort(bracketed[2]) };

  const withPort = /^([^:]+):(\d+)$/.exec(host);
  if (withPort && validPort(withPort[2]) !== null) return { host: withPort[1], port: validPort(withPort[2]) };
  return { host, port: null };
}

export function isPrivateNetworkHost(value: string) {
  const host = splitFtpHost(value).host.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const octets = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
  if (octets) {
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (/^[0-9a-f:]+$/.test(host) && host.includes(":")) return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

function validPort(value: string | undefined) {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
