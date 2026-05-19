import { performance } from "node:perf_hooks";
import type { FtpClient, FtpClientFactory } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { FtpConfig } from "../profiles/profileService.js";
import type { ProfileService } from "../profiles/profileService.js";
import { serverMatchesSharedIndexGroup } from "../shared/sharedIndex.js";

const WARM_CLIENT_TTL_MS = 10_000;

type WarmClient = {
  promise: Promise<FtpClient>;
  timeout: NodeJS.Timeout;
};

type OpenFtpClientResult = {
  client: FtpClient;
  warmed: boolean;
  clientReadyMs: number;
};

export function createFtpProxyResolver(
  profiles: ProfileService,
  mediaRepository: MediaRepository,
  ftpClientFactory: FtpClientFactory,
) {
  const warmClients = new Map<string, WarmClient>();

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

    const warmKey = ftpWarmKey(profileId, file.ftpServerId, file.ftpPath, ftpConfig);

    return {
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      warmReadStream: () => {
        warmFtpClient(warmClients, warmKey, ftpConfig, ftpClientFactory);
      },
      openReadStream: async ({ start, end, signal }: { start: number; end: number; signal?: AbortSignal }) => {
        const openStartedAt = performance.now();
        const { client, warmed, clientReadyMs } = await openFtpClient(warmClients, warmKey, ftpConfig, ftpClientFactory);
        let closeRequested = false;
        const closeClient = () => {
          closeRequested = true;
          void client.close();
        };
        signal?.addEventListener("abort", closeClient, { once: true });
        try {
          if (signal?.aborted) throw new Error("Proxy request aborted");
          const streamStartedAt = performance.now();
          const stream = await client.openReadStream(file.ftpPath, { start, end });
          logFtpProxyTiming("stream_opened", {
            warmed,
            clientReadyMs,
            streamOpenMs: elapsedMs(streamStartedAt),
            totalOpenMs: elapsedMs(openStartedAt),
            profileId,
            serverId: file.ftpServerId,
            host: ftpConfig.host,
            port: ftpConfig.port,
            tlsMode: ftpConfig.tlsMode,
            rangeStart: start,
            rangeEnd: end === Number.MAX_SAFE_INTEGER ? null : end,
          });
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
          logFtpProxyTiming("stream_open_failed", {
            warmed,
            clientReadyMs,
            totalOpenMs: elapsedMs(openStartedAt),
            profileId,
            serverId: file.ftpServerId,
            host: ftpConfig.host,
            port: ftpConfig.port,
            tlsMode: ftpConfig.tlsMode,
          });
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
): Promise<OpenFtpClientResult> {
  const startedAt = performance.now();
  const warmClient = takeWarmFtpClient(warmClients, warmKey);
  if (!warmClient) {
    return { client: await ftpClientFactory(ftpConfig), warmed: false, clientReadyMs: elapsedMs(startedAt) };
  }

  try {
    return { client: await warmClient, warmed: true, clientReadyMs: elapsedMs(startedAt) };
  } catch {
    const fallbackStartedAt = performance.now();
    return { client: await ftpClientFactory(ftpConfig), warmed: false, clientReadyMs: elapsedMs(fallbackStartedAt) };
  }
}

function warmFtpClient(
  warmClients: Map<string, WarmClient>,
  warmKey: string,
  ftpConfig: FtpConfig,
  ftpClientFactory: FtpClientFactory,
) {
  if (warmClients.has(warmKey)) return;

  const startedAt = performance.now();
  const promise = ftpClientFactory(ftpConfig);
  void promise
    .then(() => {
      logFtpProxyTiming("warm_ready", {
        warmMs: elapsedMs(startedAt),
        host: ftpConfig.host,
        port: ftpConfig.port,
        tlsMode: ftpConfig.tlsMode,
      });
    })
    .catch(() => {
      logFtpProxyTiming("warm_failed", {
        warmMs: elapsedMs(startedAt),
        host: ftpConfig.host,
        port: ftpConfig.port,
        tlsMode: ftpConfig.tlsMode,
      });
    });
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

function logFtpProxyTiming(event: string, payload: Record<string, unknown>) {
  console.info("[proxy-ftp-timing]", JSON.stringify({ event, ...payload }));
}

function elapsedMs(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}
