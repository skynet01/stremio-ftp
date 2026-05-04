import type { FtpClientFactory } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { ProfileService } from "../profiles/profileService.js";

export function createFtpProxyResolver(
  profiles: ProfileService,
  mediaRepository: MediaRepository,
  ftpClientFactory: FtpClientFactory,
) {
  return async ({ installToken, fileId }: { installToken: string; fileId: number }) => {
    const profileId = profiles.profileIdForInstallToken(installToken);
    if (!profileId) return null;

    const file = mediaRepository.getFileForProfile(profileId, fileId);
    if (!file) return null;

    const ftpConfig =
      file.ftpServerId === null ? profiles.getFtpConfig(profileId) : profiles.getFtpServerConfig(profileId, file.ftpServerId);
    if (!ftpConfig) return null;

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
