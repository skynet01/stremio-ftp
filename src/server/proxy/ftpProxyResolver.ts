import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { ProfileService } from "../profiles/profileService.js";
import { serverMatchesSharedIndexGroup } from "../shared/sharedIndex.js";

export function createFtpProxyResolver(
  profiles: ProfileService,
  mediaRepository: MediaRepository,
  ftpClientFactory: FtpClientFactory,
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
      const group = profiles.getSharedIndexGroup(file.sharedIndexGroupId);
      if (!server.sharedIndex || server.sharedIndex.id !== file.sharedIndexGroupId || !group || !server.ftpConfig) return null;
      if (!serverMatchesSharedIndexGroup(server.ftpConfig, group)) return null;
    }

    return {
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      openReadStream: async ({ start, end, signal }: { start: number; end: number; signal?: AbortSignal }) => {
        const client = await ftpClientFactory(ftpConfig);
        let closeRequested = false;
        const closeClient = () => {
          closeRequested = true;
          void client.close();
        };
        signal?.addEventListener("abort", closeClient, { once: true });
        try {
          if (signal?.aborted) throw new Error("Proxy request aborted");
          const stream = await client.openReadStream(file.ftpPath, { start, end });
          signal?.removeEventListener("abort", closeClient);
          if (signal?.aborted) {
            destroyStream(stream);
            if (!closeRequested) await client.close();
            throw new Error("Proxy request aborted");
          }
          return stream;
        } catch (error) {
          signal?.removeEventListener("abort", closeClient);
          if (!closeRequested) await client.close();
          if (signal?.aborted) throw new Error("Proxy request aborted");
          throw error;
        }
      },
    };
  };
}

function destroyStream(stream: NodeJS.ReadableStream) {
  if ("destroy" in stream && typeof stream.destroy === "function") {
    stream.destroy();
  }
}
