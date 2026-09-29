import type { FtpClient } from "./ftpTypes.js";
import type { FtpConfig } from "../profiles/profileService.js";

export type FtpClientRequestOptions = {
  signal?: AbortSignal;
};

export type AbortableFtpClientFactory = (config: FtpConfig, options?: FtpClientRequestOptions) => Promise<FtpClient>;

type QueueWaiter = {
  resolve: (release: () => void) => void;
};

type LimiterState = {
  activeConnections: number;
  queue: QueueWaiter[];
};

export function limitFtpClientFactory(factory: AbortableFtpClientFactory, maxConnections: number): AbortableFtpClientFactory {
  return limitFtpClientFactoryByKey(factory, maxConnections, () => "global");
}

export function limitFtpClientFactoryByKey(
  factory: AbortableFtpClientFactory,
  maxConnectionsPerKey: number,
  keyForConfig: (config: FtpConfig) => string = ftpConfigConnectionKey,
): AbortableFtpClientFactory {
  const connectionLimit = Math.max(1, Math.floor(maxConnectionsPerKey));
  const states = new Map<string, LimiterState>();

  function acquire(key: string, signal: AbortSignal | undefined) {
    if (signal?.aborted) return Promise.reject(abortError());
    let state = states.get(key);
    if (!state) {
      state = { activeConnections: 0, queue: [] };
      states.set(key, state);
    }

    if (state.activeConnections < connectionLimit) {
      state.activeConnections += 1;
      return Promise.resolve(releaseOnce(key, state));
    }

    const queue = state.queue;
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index === -1) return;
        queue.splice(index, 1);
        reject(abortError());
      };
      const waiter: QueueWaiter = {
        resolve: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function releaseOnce(key: string, state: LimiterState) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.queue.shift();
      if (next) {
        next.resolve(releaseOnce(key, state));
        return;
      }
      state.activeConnections -= 1;
      if (state.activeConnections === 0 && state.queue.length === 0) {
        states.delete(key);
      }
    };
  }

  return async (config, options = {}) => {
    const { signal } = options;
    const release = await acquire(keyForConfig(config), signal);
    let client: FtpClient;
    try {
      if (signal?.aborted) throw abortError();
      client = await factory(config, { signal });
    } catch (error) {
      release();
      throw error;
    }

    const limitedClient = releaseClientSlotOnClose(client, release);
    if (signal?.aborted) {
      await limitedClient.close().catch(() => undefined);
      throw abortError();
    }
    return limitedClient;
  };
}

function abortError() {
  const error = new Error("FTP connection request aborted");
  error.name = "AbortError";
  return error;
}

function ftpConfigConnectionKey(config: FtpConfig) {
  return [
    config.host.trim().toLowerCase(),
    config.port,
    config.username,
    config.password,
    config.tlsMode,
    config.allowInvalidCertificate ? "invalid-cert-ok" : "valid-cert",
  ].join("\0");
}

function releaseClientSlotOnClose(client: FtpClient, release: () => void): FtpClient {
  const closeAndRelease = async () => {
    try {
      await client.close();
    } finally {
      release();
    }
  };

  return {
    list: (path) => client.list(path),
    openReadStream: async (path, input) => {
      let stream: NodeJS.ReadableStream;
      try {
        stream = await client.openReadStream(path, input);
      } catch (error) {
        await closeAndRelease();
        throw error;
      }

      const releaseAfterStream = () => {
        void closeAndRelease();
      };
      stream.once("close", releaseAfterStream);
      stream.once("end", releaseAfterStream);
      stream.once("error", releaseAfterStream);
      return stream;
    },
    close: closeAndRelease,
  };
}
