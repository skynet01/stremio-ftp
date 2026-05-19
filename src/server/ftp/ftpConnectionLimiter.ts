import type { FtpClient, FtpClientFactory } from "./ftpTypes.js";
import type { FtpConfig } from "../profiles/profileService.js";

type QueueWaiter = {
  resolve: (release: () => void) => void;
};

type LimiterState = {
  activeConnections: number;
  queue: QueueWaiter[];
};

export function limitFtpClientFactory(factory: FtpClientFactory, maxConnections: number): FtpClientFactory {
  return limitFtpClientFactoryByKey(factory, maxConnections, () => "global");
}

export function limitFtpClientFactoryByKey(
  factory: FtpClientFactory,
  maxConnectionsPerKey: number,
  keyForConfig: (config: FtpConfig) => string = ftpConfigConnectionKey,
): FtpClientFactory {
  const connectionLimit = Math.max(1, Math.floor(maxConnectionsPerKey));
  const states = new Map<string, LimiterState>();

  async function acquire(key: string) {
    let state = states.get(key);
    if (!state) {
      state = { activeConnections: 0, queue: [] };
      states.set(key, state);
    }

    if (state.activeConnections < connectionLimit) {
      state.activeConnections += 1;
      return releaseOnce(key, state);
    }

    return new Promise<() => void>((resolve) => {
      state.queue.push({ resolve });
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

  return async (config) => {
    const release = await acquire(keyForConfig(config));
    try {
      const client = await factory(config);
      return releaseClientSlotOnClose(client, release);
    } catch (error) {
      release();
      throw error;
    }
  };
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
