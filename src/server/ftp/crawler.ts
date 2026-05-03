import type { MediaRepository } from "../media/mediaRepository.js";
import { parseMediaPath, type ParseMediaOptions } from "../media/parser.js";
import type { FtpConfig } from "../profiles/profileService.js";
import type { FtpClientFactory } from "./ftpTypes.js";

const MAX_CRAWL_DEPTH = 64;
const MAX_CRAWL_ENTRIES = 100000;

export type CrawlProfileRootInput = {
  profileId: number;
  rootPath: string;
  ftpConfig: FtpConfig;
  factory: FtpClientFactory;
  repo: MediaRepository;
  parserOptions?: ParseMediaOptions;
  onProgress?: (progress: CrawlProgress) => void;
};

export type CrawlProgress = {
  entriesSeen: number;
  filesSeen: number;
  directoriesSeen: number;
  currentPath: string;
};

export async function crawlProfileRoot(input: CrawlProfileRootInput) {
  const client = await input.factory(input.ftpConfig);
  const crawlStartedAt = new Date().toISOString();
  const visitedDirectories = new Set<string>();
  let filesSeen = 0;
  let entriesSeen = 0;
  let directoriesSeen = 0;

  function report(currentPath: string) {
    input.onProgress?.({ entriesSeen, filesSeen, directoriesSeen, currentPath });
  }

  async function walk(path: string, depth: number) {
    if (depth > MAX_CRAWL_DEPTH) throw new Error(`Maximum FTP crawl depth exceeded at ${path}`);

    const normalizedPath = normalizeFtpPath(path);
    if (visitedDirectories.has(normalizedPath)) return;
    visitedDirectories.add(normalizedPath);
    directoriesSeen += 1;
    report(normalizedPath);

    const entries = await client.list(normalizedPath);
    for (const entry of entries) {
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
    input.repo.deleteStaleUnderRoot(input.profileId, input.rootPath, crawlStartedAt);
    return { filesSeen };
  } finally {
    await client.close();
  }
}

function normalizeFtpPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
