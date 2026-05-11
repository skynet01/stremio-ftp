import type { ServerForm } from "./components/ServerAccordion.js";

export type PortableCustomization = {
  addonName?: string;
  addonLogoUrl?: string;
  addonDescription?: string;
  catalogTmdbApiKey?: string;
  streamNameTemplate?: string;
  streamDescriptionTemplate?: string;
};

export type PortableServer = {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  tlsMode?: "none" | "explicit" | "implicit";
  allowInvalidCertificate?: boolean;
  rootPaths?: string[];
  catalogEnabled?: boolean;
  catalogContentTypes?: { movies?: boolean; series?: boolean; anime?: boolean; uncategorized?: boolean };
  libraryLayout?: "auto" | "folders" | "flat";
  streamDeliveryMode?: "proxy" | "direct";
  scanIntervalMinutes?: number;
};

export type PortableSettings = {
  schemaVersion: 1;
  exportedAt: string;
  customization?: PortableCustomization;
  servers?: PortableServer[];
};

export type ExportContext = {
  addonName: string;
  addonLogoUrl: string;
  addonDescription: string;
  catalogTmdbApiKey: string;
  streamNameTemplate: string;
  streamDescriptionTemplate: string;
  servers: ServerForm[];
};

export type ImportLimits = {
  maxFtpServersPerProfile: number;
  proxyStreamsDisabled: boolean;
};

export type ImportSummary = {
  customization: PortableCustomization;
  servers: PortableServer[];
  totalServersInFile: number;
  droppedServerCount: number;
  proxyDowngradedCount: number;
};

export function serializePortableSettings(ctx: ExportContext, stripCredentials: boolean): PortableSettings {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    customization: {
      addonName: ctx.addonName || undefined,
      addonLogoUrl: ctx.addonLogoUrl || undefined,
      addonDescription: ctx.addonDescription || undefined,
      catalogTmdbApiKey: ctx.catalogTmdbApiKey || undefined,
      streamNameTemplate: ctx.streamNameTemplate || undefined,
      streamDescriptionTemplate: ctx.streamDescriptionTemplate || undefined,
    },
    servers: ctx.servers.map((server) => serverToPortable(server, stripCredentials)),
  };
}

function serverToPortable(server: ServerForm, stripCredentials: boolean): PortableServer {
  const rootPaths = server.rootPaths
    .split(/\r?\n|,/)
    .map((root) => root.trim())
    .filter(Boolean);
  return {
    name: server.name || undefined,
    host: server.host || undefined,
    port: Number.isFinite(Number(server.port)) ? Number(server.port) : undefined,
    username: stripCredentials ? undefined : server.username || undefined,
    password: stripCredentials ? undefined : server.password || undefined,
    tlsMode: server.tlsMode,
    allowInvalidCertificate: server.allowInvalidCertificate || undefined,
    rootPaths: rootPaths.length ? rootPaths : undefined,
    catalogEnabled: server.catalogEnabled || undefined,
    catalogContentTypes: server.catalogContentTypes,
    libraryLayout: server.libraryLayout,
    streamDeliveryMode: server.streamDeliveryMode,
    scanIntervalMinutes: server.scanSchedule?.intervalMinutes || undefined,
  };
}

export function parsePortableSettings(raw: unknown): PortableSettings {
  if (!raw || typeof raw !== "object") throw new Error("Settings file must contain a JSON object.");
  const value = raw as Record<string, unknown>;
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1) throw new Error("Unsupported settings schema version.");
  const exportedAt = typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString();
  return {
    schemaVersion: 1,
    exportedAt,
    customization: parseCustomization(value.customization),
    servers: Array.isArray(value.servers) ? value.servers.map(parseServer) : [],
  };
}

function parseCustomization(value: unknown): PortableCustomization {
  if (!value || typeof value !== "object") return {};
  const c = value as Record<string, unknown>;
  return {
    addonName: stringOrUndefined(c.addonName),
    addonLogoUrl: stringOrUndefined(c.addonLogoUrl),
    addonDescription: stringOrUndefined(c.addonDescription),
    catalogTmdbApiKey: stringOrUndefined(c.catalogTmdbApiKey),
    streamNameTemplate: stringOrUndefined(c.streamNameTemplate),
    streamDescriptionTemplate: stringOrUndefined(c.streamDescriptionTemplate),
  };
}

function parseServer(value: unknown): PortableServer {
  if (!value || typeof value !== "object") return {};
  const s = value as Record<string, unknown>;
  return {
    name: stringOrUndefined(s.name),
    host: stringOrUndefined(s.host),
    port: parsePortValue(s.port),
    username: stringOrUndefined(s.username),
    password: stringOrUndefined(s.password),
    tlsMode: s.tlsMode === "none" || s.tlsMode === "explicit" || s.tlsMode === "implicit" ? s.tlsMode : undefined,
    allowInvalidCertificate: typeof s.allowInvalidCertificate === "boolean" ? s.allowInvalidCertificate : undefined,
    rootPaths: Array.isArray(s.rootPaths)
      ? s.rootPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      : undefined,
    catalogEnabled: typeof s.catalogEnabled === "boolean" ? s.catalogEnabled : undefined,
    catalogContentTypes: parseContentTypes(s.catalogContentTypes),
    libraryLayout:
      s.libraryLayout === "auto" || s.libraryLayout === "folders" || s.libraryLayout === "flat" ? s.libraryLayout : undefined,
    streamDeliveryMode: s.streamDeliveryMode === "proxy" || s.streamDeliveryMode === "direct" ? s.streamDeliveryMode : undefined,
    scanIntervalMinutes:
      typeof s.scanIntervalMinutes === "number" && Number.isFinite(s.scanIntervalMinutes) && s.scanIntervalMinutes >= 0
        ? Math.floor(s.scanIntervalMinutes)
        : undefined,
  };
}

function parseContentTypes(value: unknown): PortableServer["catalogContentTypes"] {
  if (!value || typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  const out: PortableServer["catalogContentTypes"] = {};
  if (typeof c.movies === "boolean") out.movies = c.movies;
  if (typeof c.series === "boolean") out.series = c.series;
  if (typeof c.anime === "boolean") out.anime = c.anime;
  if (typeof c.uncategorized === "boolean") out.uncategorized = c.uncategorized;
  return Object.keys(out).length ? out : undefined;
}

function parsePortValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) return parsed;
    }
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function applyImportLimits(parsed: PortableSettings, limits: ImportLimits): ImportSummary {
  const allServers = parsed.servers ?? [];
  const cap = limits.maxFtpServersPerProfile > 0 ? limits.maxFtpServersPerProfile : Number.POSITIVE_INFINITY;
  const truncated = allServers.slice(0, cap);
  const droppedServerCount = allServers.length - truncated.length;

  let proxyDowngradedCount = 0;
  const servers = truncated.map((server) => {
    if (limits.proxyStreamsDisabled && server.streamDeliveryMode === "proxy") {
      proxyDowngradedCount += 1;
      return { ...server, streamDeliveryMode: "direct" as const };
    }
    return server;
  });

  return {
    customization: parsed.customization ?? {},
    servers,
    totalServersInFile: allServers.length,
    droppedServerCount,
    proxyDowngradedCount,
  };
}

export function downloadSettingsFile(payload: PortableSettings, filenamePrefix = "stremio-ftp-settings"): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  link.href = url;
  link.download = `${filenamePrefix}-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function hasCompleteFtpCreds(server: PortableServer): boolean {
  return Boolean(
    server.host?.trim() &&
      server.username?.trim() &&
      server.password &&
      (server.rootPaths?.length ?? 0) > 0,
  );
}
