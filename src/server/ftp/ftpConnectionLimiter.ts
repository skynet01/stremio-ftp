import type { FtpClient } from "./ftpTypes.js";
import type { FtpConfig } from "../profiles/profileService.js";

export type FtpClientRequestOptions = {
  signal?: AbortSignal;
  // Background requests only take a free slot and give it up to a waiting request until claimed.
  background?: boolean;
};

export type ClaimableFtpClient = FtpClient & {
  // Marks a background client as in use; returns false once it has been given up.
  claim?(): boolean;
};

export type AbortableFtpClientFactory = (config: FtpConfig, options?: FtpClientRequestOptions) => Promise<ClaimableFtpClient>;

type QueueWaiter = {
  resolve: (release: () => void) => void;
};

type LimiterState = {
  activeConnections: number;
  queue: QueueWaiter[];
  yieldable: Set<() => void>;
};

const SLOT_UNAVAILABLE_ERROR = "FtpSlotUnavailableError";

export function isFtpSlotUnavailableError(error: unknown) {
  return error instanceof Error && error.name === SLOT_UNAVAILABLE_ERROR;
}

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

  function acquire(key: string, { signal, background }: FtpClientRequestOptions) {
    if (signal?.aborted) return Promise.reject(abortError());
    let state = states.get(key);
    if (!state) {
      state = { activeConnections: 0, queue: [], yieldable: new Set() };
      states.set(key, state);
    }
    const acquiredState = state;

    if (state.activeConnections < connectionLimit) {
      state.activeConnections += 1;
      return Promise.resolve({ state, release: releaseOnce(key, state) });
    }
    if (background) return Promise.reject(slotUnavailableError());

    return new Promise<{ state: LimiterState; release: () => void }>((resolve, reject) => {
      const onAbort = () => {
        const index = acquiredState.queue.indexOf(waiter);
        if (index === -1) return;
        acquiredState.queue.splice(index, 1);
        reject(abortError());
      };
      const waiter: QueueWaiter = {
        resolve: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ state: acquiredState, release });
        },
      };
      acquiredState.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      const [yieldSlot] = acquiredState.yieldable;
      yieldSlot?.();
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
    const { signal, background = false } = options;
    const { state, release } = await acquire(keyForConfig(config), options);
    const yieldController = background ? new AbortController() : null;
    const yieldLogin = () => {
      state.yieldable.delete(yieldLogin);
      yieldController?.abort();
    };
    if (yieldController) state.yieldable.add(yieldLogin);
    const loginSignal = !yieldController
      ? signal
      : signal
        ? AbortSignal.any([signal, yieldController.signal])
        : yieldController.signal;
    const cancellationError = () => (signal?.aborted ? abortError() : slotUnavailableError());

    let client: ClaimableFtpClient;
    try {
      if (loginSignal?.aborted) throw cancellationError();
      client = await factory(config, { signal: loginSignal });
    } catch (error) {
      state.yieldable.delete(yieldLogin);
      release();
      throw loginSignal?.aborted ? cancellationError() : error;
    }
    state.yieldable.delete(yieldLogin);

    const limitedClient = releaseClientSlotOnClose(client, release, background ? state.yieldable : null);
    if (loginSignal?.aborted) {
      await limitedClient.close().catch(() => undefined);
      throw cancellationError();
    }
    return limitedClient;
  };
}

function abortError() {
  const error = new Error("FTP connection request aborted");
  error.name = "AbortError";
  return error;
}

function slotUnavailableError() {
  const error = new Error("No FTP connection slot available for a background request");
  error.name = SLOT_UNAVAILABLE_ERROR;
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

function releaseClientSlotOnClose(client: FtpClient, release: () => void, yieldable: Set<() => void> | null): ClaimableFtpClient {
  let closing: Promise<void> | null = null;
  const closeAndRelease = () => {
    if (!closing) {
      yieldable?.delete(yieldSlot);
      closing = (async () => {
        try {
          await client.close();
        } finally {
          release();
        }
      })();
    }
    return closing;
  };
  const yieldSlot = () => {
    void closeAndRelease().catch(() => undefined);
  };
  const claim = () => {
    if (closing) return false;
    yieldable?.delete(yieldSlot);
    return true;
  };
  yieldable?.add(yieldSlot);

  return {
    list: (path) => {
      claim();
      return client.list(path);
    },
    openReadStream: async (path, input) => {
      claim();
      let stream: NodeJS.ReadableStream;
      try {
        stream = await client.openReadStream(path, input);
      } catch (error) {
        await closeAndRelease();
        throw error;
      }

      const releaseAfterStream = () => {
        void closeAndRelease().catch(() => undefined);
      };
      stream.once("close", releaseAfterStream);
      stream.once("end", releaseAfterStream);
      stream.once("error", releaseAfterStream);
      return stream;
    },
    close: closeAndRelease,
    claim,
  };
}
