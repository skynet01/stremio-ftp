import type { MediaRepository } from "../media/mediaRepository.js";
import { parseMediaPath, type ParseMediaOptions } from "../media/parser.js";
import type { FtpConfig } from "../profiles/profileService.js";
import type { FtpClientFactory } from "./ftpTypes.js";

const MAX_CRAWL_DEPTH = 64;
const MAX_CRAWL_ENTRIES = 100000;

export type CrawlProfileRootInput = {
  profileId: number;
  ftpServerId?: number | null;
  rootPath: string;
  ftpConfig: FtpConfig;
  factory: FtpClientFactory;
  repo: MediaRepository;
  parserOptions?: ParseMediaOptions;
  onProgress?: (progress: CrawlProgress) => void;
  signal?: AbortSignal;
};

export type CrawlProgress = {
  entriesSeen: number;
  filesSeen: number;
  directoriesSeen: number;
  currentPath: string;
};

export async function crawlProfileRoot(input: CrawlProfileRootInput) {
  const client = await input.factory(input.ftpConfig);
  const closeClientOnAbort = () => {
    void client.close();
  };
  input.signal?.addEventListener("abort", closeClientOnAbort, { once: true });
  const crawlStartedAt = new Date().toISOString();
  const visitedDirectories = new Set<string>();
  let filesSeen = 0;
  let entriesSeen = 0;
  let directoriesSeen = 0;

  function report(currentPath: string) {
    input.onProgress?.({ entriesSeen, filesSeen, directoriesSeen, currentPath });
  }

  async function walk(path: string, depth: number) {
    throwIfScanCancelled(input.signal);
    if (depth > MAX_CRAWL_DEPTH) throw new Error(`Maximum FTP crawl depth exceeded at ${path}`);

    const normalizedPath = normalizeFtpPath(path);
    if (visitedDirectories.has(normalizedPath)) return;
    visitedDirectories.add(normalizedPath);
    directoriesSeen += 1;
    report(normalizedPath);

    let entries;
    try {
      entries = await client.list(normalizedPath);
    } catch (error) {
      if (input.signal?.aborted) throw new ScanCancelledError();
      throw error;
    }
    for (const entry of entries) {
      throwIfScanCancelled(input.signal);
      entriesSeen += 1;
      if (entriesSeen > MAX_CRAWL_ENTRIES) throw new Error(`Maximum FTP crawl entries exceeded at ${entry.path}`);
      if (entry.name === "." || entry.name === "..") continue;

      if (entry.type === "directory") {
        await walk(entry.path, depth + 1);
      } else {
        const parsed = parseMediaPath(entry.path, input.parserOptions);
        if (parsed) {
          filesSeen += 1;
          input.repo.upsertParsedFile(input.profileId, {
            ...parsed,
            ftpServerId: input.ftpServerId ?? null,
            sizeBytes: entry.size ?? null,
            modifiedAt: entry.modifiedAt ?? null,
            lastSeenAt: crawlStartedAt,
          });
        }
        report(entry.path);
      }
    }
  }

  try {
    await walk(input.rootPath, 0);
    input.repo.deleteStaleUnderRoot(input.profileId, input.rootPath, crawlStartedAt, input.ftpServerId ?? null);
    return { filesSeen };
  } finally {
    input.signal?.removeEventListener("abort", closeClientOnAbort);
    await client.close();
  }
}

export class ScanCancelledError extends Error {
  constructor() {
    super("Scan halted.");
  }
}

export function isScanCancelledError(error: unknown): error is ScanCancelledError {
  return error instanceof ScanCancelledError;
}

function throwIfScanCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCancelledError();
}

function normalizeFtpPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
