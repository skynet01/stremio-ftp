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

    const ftpConfig = profiles.getFtpConfig(profileId);
    if (!ftpConfig) return null;

    return {
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      openReadStream: async ({ start, end }: { start: number; end: number }) => {
        const client = await ftpClientFactory(ftpConfig);
        return client.openReadStream(file.ftpPath, { start, end });
      },
    };
  };
}
