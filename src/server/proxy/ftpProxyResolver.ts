import { performance } from "node:perf_hooks";
import { isFtpSlotUnavailableError, type AbortableFtpClientFactory, type ClaimableFtpClient } from "../ftp/ftpConnectionLimiter.js";
import type { FtpClient } from "../ftp/ftpTypes.js";
import type { MediaRepository } from "../media/mediaRepository.js";
import type { FtpConfig } from "../profiles/profileService.js";
import type { ProfileService } from "../profiles/profileService.js";
import { serverMatchesSharedIndexGroup } from "../shared/sharedIndex.js";

const WARM_CLIENT_TTL_MS = 10_000;

type WarmClient = {
  promise: Promise<ClaimableFtpClient>;
  timeout: NodeJS.Timeout;
  controller: AbortController;
};

type OpenFtpClientResult = {
  client: FtpClient;
  warmed: boolean;
  clientReadyMs: number;
};

export function createFtpProxyResolver(
  profiles: ProfileService,
  mediaRepository: MediaRepository,
  ftpClientFactory: AbortableFtpClientFactory,
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
      const group = profiles.getSharedIndexGroupIdentity(file.sharedIndexGroupId);
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
        let openedClient: OpenFtpClientResult;
        try {
          openedClient = await openFtpClient(warmClients, warmKey, ftpConfig, ftpClientFactory, signal);
        } catch (error) {
          if (signal?.aborted) throw new Error("Proxy request aborted");
          throw error;
        }
        const { client, warmed, clientReadyMs } = openedClient;
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
  ftpClientFactory: AbortableFtpClientFactory,
  signal: AbortSignal | undefined,
): Promise<OpenFtpClientResult> {
  const startedAt = performance.now();
  const warmClient = takeWarmFtpClient(warmClients, warmKey);
  if (warmClient) {
    try {
      const client = await awaitWarmFtpClient(warmClient, signal);
      if (client.claim?.() !== false) return { client, warmed: true, clientReadyMs: elapsedMs(startedAt) };
    } catch {
      // The warm-up failed or gave its slot away; open a fresh connection instead.
    }
  }

  if (signal?.aborted) throw new Error("Proxy request aborted");
  const connectStartedAt = performance.now();
  return { client: await ftpClientFactory(ftpConfig, { signal }), warmed: false, clientReadyMs: elapsedMs(connectStartedAt) };
}

function awaitWarmFtpClient(warmClient: WarmClient, signal: AbortSignal | undefined): Promise<ClaimableFtpClient> {
  if (!signal) return warmClient.promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      warmClient.controller.abort();
      reject(new Error("Proxy request aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void warmClient.promise.then(
      (client) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          void client.close().catch(() => undefined);
          reject(new Error("Proxy request aborted"));
        } else resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function warmFtpClient(
  warmClients: Map<string, WarmClient>,
  warmKey: string,
  ftpConfig: FtpConfig,
  ftpClientFactory: AbortableFtpClientFactory,
) {
  if (warmClients.has(warmKey)) return;

  const startedAt = performance.now();
  const controller = new AbortController();
  const promise = ftpClientFactory(ftpConfig, { background: true, signal: controller.signal });
  void promise
    .then(() => {
      logFtpProxyTiming("warm_ready", {
        warmMs: elapsedMs(startedAt),
        host: ftpConfig.host,
        port: ftpConfig.port,
        tlsMode: ftpConfig.tlsMode,
      });
    })
    .catch((error: unknown) => {
      logFtpProxyTiming(isFtpSlotUnavailableError(error) ? "warm_skipped" : "warm_failed", {
        warmMs: elapsedMs(startedAt),
        host: ftpConfig.host,
        port: ftpConfig.port,
        tlsMode: ftpConfig.tlsMode,
      });
    });
  const timeout = setTimeout(() => {
    warmClients.delete(warmKey);
    controller.abort();
    void promise.then((client) => client.close()).catch(() => undefined);
  }, WARM_CLIENT_TTL_MS);
  timeout.unref?.();

  warmClients.set(warmKey, { promise, timeout, controller });
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
  return warmClient;
}

function ftpWarmKey(profileId: number, serverId: number | null, ftpPath: string, ftpConfig: FtpConfig) {
  return [
    profileId,
    serverId ?? "default",
    ftpConfig.host,
    ftpConfig.port,
    ftpConfig.username,
    ftpConfig.password,
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
