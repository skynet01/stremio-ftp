import type { FtpClient, FtpClientFactory } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { FtpConfig } from "../profiles/profileService.js";
import type { ProfileService } from "../profiles/profileService.js";

const WARM_CLIENT_TTL_MS = 10_000;

type WarmClient = {
  promise: Promise<FtpClient>;
  timeout: NodeJS.Timeout;
};

export function createFtpProxyResolver(
  profiles: ProfileService,
  mediaRepository: MediaRepository,
  ftpClientFactory: FtpClientFactory,
) {
  const warmClients = new Map<string, WarmClient>();

  return async ({ installToken, fileId }: { installToken: string; fileId: number }) => {
    const profileId = profiles.profileIdForInstallToken(installToken);
    if (!profileId) return null;

    const file = mediaRepository.getFileForProfile(profileId, fileId);
    if (!file) return null;

    const ftpConfig =
      file.ftpServerId === null ? profiles.getFtpConfig(profileId) : profiles.getFtpServerConfig(profileId, file.ftpServerId);
    if (!ftpConfig) return null;

    const warmKey = ftpWarmKey(profileId, file.ftpServerId, file.ftpPath, ftpConfig);

    return {
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      warmReadStream: () => {
        warmFtpClient(warmClients, warmKey, ftpConfig, ftpClientFactory);
      },
      openReadStream: async ({ start, end, signal }: { start: number; end: number; signal?: AbortSignal }) => {
        const client = await openFtpClient(warmClients, warmKey, ftpConfig, ftpClientFactory);
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

async function openFtpClient(
  warmClients: Map<string, WarmClient>,
  warmKey: string,
  ftpConfig: FtpConfig,
  ftpClientFactory: FtpClientFactory,
) {
  const warmClient = takeWarmFtpClient(warmClients, warmKey);
  if (!warmClient) return ftpClientFactory(ftpConfig);

  try {
    return await warmClient;
  } catch {
    return ftpClientFactory(ftpConfig);
  }
}

function warmFtpClient(
  warmClients: Map<string, WarmClient>,
  warmKey: string,
  ftpConfig: FtpConfig,
  ftpClientFactory: FtpClientFactory,
) {
  if (warmClients.has(warmKey)) return;

  const promise = ftpClientFactory(ftpConfig);
  const timeout = setTimeout(() => {
    warmClients.delete(warmKey);
    void promise.then((client) => client.close()).catch(() => undefined);
  }, WARM_CLIENT_TTL_MS);
  timeout.unref?.();

  warmClients.set(warmKey, { promise, timeout });
  void promise.catch(() => {
    const warmClient = warmClients.get(warmKey);
    if (warmClient?.promise === promise) {
      warmClients.delete(warmKey);
      clearTimeout(timeout);
    }
  });
}

function takeWarmFtpClient(warmClients: Map<string, WarmClient>, warmKey: string) {
  const warmClient = warmClients.get(warmKey);
  if (!warmClient) return null;

  warmClients.delete(warmKey);
  clearTimeout(warmClient.timeout);
  return warmClient.promise;
}

function ftpWarmKey(profileId: number, serverId: number | null, ftpPath: string, ftpConfig: FtpConfig) {
  return [
    profileId,
    serverId ?? "default",
    ftpConfig.host,
    ftpConfig.port,
    ftpConfig.username,
    ftpConfig.tlsMode,
    ftpConfig.allowInvalidCertificate ? "invalid-cert-ok" : "valid-cert",
    ftpPath,
  ].join("\0");
}

function destroyStream(stream: NodeJS.ReadableStream) {
  if ("destroy" in stream && typeof stream.destroy === "function") {
    stream.destroy();
  }
}
