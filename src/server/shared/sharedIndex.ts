import { hashToken, randomToken } from "../security/crypto.js";
import type { FtpConfig } from "../profiles/profileService.js";

export function generateSharedIndexKey() {
  return randomToken(32);
}

export function hashSharedIndexKey(key: string) {
  return hashToken(key.trim());
}

export function canonicalRootPaths(roots: string[]) {
  return [...new Set(roots.map(canonicalRootPath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function canonicalRootPath(root: string) {
  const normalized = root.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalized || normalized === "/") return "/";
  return `/${normalized.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

export function serverMatchesSharedIndexGroup(
  config: FtpConfig,
  group: {
    host: string;
    port: number;
    tlsMode: FtpConfig["tlsMode"];
    allowInvalidCertificate: boolean;
    rootPaths: string[];
  },
) {
  return (
    config.host.trim().toLowerCase() === group.host.trim().toLowerCase() &&
    config.port === group.port &&
    config.tlsMode === group.tlsMode &&
    Boolean(config.allowInvalidCertificate) === Boolean(group.allowInvalidCertificate) &&
    JSON.stringify(canonicalRootPaths(config.roots)) === JSON.stringify(canonicalRootPaths(group.rootPaths))
  );
}

export function keyHintFromName(name: string) {
  const hint = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return hint || "shared-index";
}
