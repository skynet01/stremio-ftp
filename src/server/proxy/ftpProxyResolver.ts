import { performance } from "node:perf_hooks";
import { logFtpTiming, type FtpConnectionPool } from "../ftp/ftpConnectionPool.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { ProfileService } from "../profiles/profileService.js";
import { serverMatchesSharedIndexGroup } from "../shared/sharedIndex.js";

export function createFtpProxyResolver(
  profiles: ProfileService,
  mediaRepository: MediaRepository,
  ftpPool: FtpConnectionPool,
) {
  return async (input: { installToken: string; fileId: number } | { installToken: string; serverId: number; sharedMediaId: number }) => {
    const { installToken } = input;
    const profileId = profiles.profileIdForInstallToken(installToken);
    if (!profileId) return null;

    const file =
      "sharedMediaId" in input
        ? mediaRepository.getSharedFileForProfile(profileId, input.serverId, input.sharedMediaId)
        : mediaRepository.getFileForProfile(profileId, input.fileId);
    if (!file) return null;

    const ftpConfig = file.ftpServerId === null ? profiles.getFtpConfig(profileId) : profiles.getFtpServerConfig(profileId, file.ftpServerId);
    if (!ftpConfig) return null;
    if ("sharedMediaId" in input) {
      if (!file.sharedIndexGroupId || file.ftpServerId !== input.serverId) return null;
      const server = profiles.getFtpServer(profileId, input.serverId);
      const group = profiles.getSharedIndexGroupIdentity(file.sharedIndexGroupId);
      if (!server.sharedIndex || server.sharedIndex.id !== file.sharedIndexGroupId || !group || !server.ftpConfig) return null;
      if (!serverMatchesSharedIndexGroup(server.ftpConfig, group)) return null;
    }

    const logTarget = {
      profileId,
      serverId: file.ftpServerId,
      host: ftpConfig.host,
      port: ftpConfig.port,
      tlsMode: ftpConfig.tlsMode,
    };

    return {
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      profileId,
      ftpServerId: file.ftpServerId,
      sharedIndexGroupId: file.sharedIndexGroupId,
      warmReadStream: () => {
        ftpPool.warm(ftpConfig);
      },
      openReadStream: async ({ start, end, openEnded, signal }: { start: number; end: number; openEnded?: boolean; signal?: AbortSignal }) => {
        const openStartedAt = performance.now();
        try {
          const opened = await ftpPool.openReadStream(ftpConfig, file.ftpPath, { start, end, openEnded }, signal);
          logFtpTiming("stream_opened", {
            pooled: opened.source === "idle" || opened.source === "handoff",
            warmed: opened.source === "warm",
            source: opened.source,
            retriedFresh: opened.retriedFresh,
            clientReadyMs: opened.clientReadyMs,
            streamOpenMs: opened.streamOpenMs,
            totalOpenMs: elapsedMs(openStartedAt),
            ...logTarget,
            rangeStart: start,
            rangeEnd: end === Number.MAX_SAFE_INTEGER ? null : end,
            openEnded: Boolean(openEnded),
          });
          return opened.stream;
        } catch (error) {
          if (signal?.aborted) throw new Error("Proxy request aborted");
          logFtpTiming("stream_open_failed", { totalOpenMs: elapsedMs(openStartedAt), ...logTarget });
          throw error;
        }
      },
    };
  };
}

function elapsedMs(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}
