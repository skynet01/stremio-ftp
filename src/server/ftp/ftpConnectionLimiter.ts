import type { FtpClient, FtpClientFactory } from "./ftpTypes.js";

type QueueWaiter = {
  resolve: (release: () => void) => void;
};

export function limitFtpClientFactory(factory: FtpClientFactory, maxConnections: number): FtpClientFactory {
  let activeConnections = 0;
  const queue: QueueWaiter[] = [];

  async function acquire() {
    if (activeConnections < maxConnections) {
      activeConnections += 1;
      return releaseOnce();
    }

    return new Promise<() => void>((resolve) => {
      queue.push({ resolve });
    });
  }

  function releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) {
        next.resolve(releaseOnce());
        return;
      }
      activeConnections -= 1;
    };
  }

  return async (config) => {
    const release = await acquire();
    try {
      const client = await factory(config);
      return releaseClientSlotOnClose(client, release);
    } catch (error) {
      release();
      throw error;
    }
  };
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
