import { Client, FileType, FTPError, type AccessOptions } from "basic-ftp";
import { PassThrough, Writable } from "node:stream";
import type { ConnectionOptions } from "node:tls";
import { splitFtpHost } from "../../shared/ftpHost.js";
import type { FtpConfig } from "../profiles/profileService.js";
import type { FtpClient, FtpClientFactory, FtpReadStreamOptions } from "./ftpTypes.js";

const SOCKET_CLOSE_TIMEOUT_MS = 3_000;
// A paused player stops reading, which idles the FTP data socket; only a real stall should time it out.
const PAUSED_DATA_SOCKET_TIMEOUT_MS = 30 * 60_000;
// Once every requested byte has arrived, how long the server may take to confirm the transfer (226) before the
// login is closed instead of being kept for another transfer.
const TRANSFER_CONFIRM_GRACE_MS = 2_000;
const MAX_REMEMBERED_HOSTS = 256;

export type BasicFtpClientOptions = {
  signal?: AbortSignal;
  // Playback logins only download, so they skip the directory-listing setup that scans need (see leanLogin).
  playback?: boolean;
};

type LoginTarget = AccessOptions & { host: string; port: number };

type RememberedHost = {
  features: Map<string, string>;
  byteRangesRejected: boolean;
};

// Per-host facts learned from earlier logins, bounded so a long-running server cannot grow them without limit.
class FtpHostMemory {
  private readonly hosts = new Map<string, RememberedHost>();

  constructor(private readonly maxEntries: number) {}

  features(hostKey: string) {
    return this.hosts.get(hostKey)?.features;
  }

  rememberFeatures(hostKey: string, features: Map<string, string>) {
    const byteRangesRejected = this.hosts.get(hostKey)?.byteRangesRejected ?? false;
    setBounded(this.hosts, hostKey, { features, byteRangesRejected }, this.maxEntries);
  }

  supportsByteRanges(hostKey: string) {
    const host = this.hosts.get(hostKey);
    return Boolean(host?.features.has("RANG") && !host.byteRangesRejected);
  }

  rejectByteRanges(hostKey: string) {
    const host = this.hosts.get(hostKey);
    if (host) host.byteRangesRejected = true;
  }
}

function setBounded<T>(map: Map<string, T>, key: string, value: T, maxEntries: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > maxEntries) map.delete(map.keys().next().value!);
}

export function createBasicFtpClientFactory(
  timeoutMs = 30000,
): (config: FtpConfig, options?: BasicFtpClientOptions) => Promise<FtpClient> {
  const hosts = new FtpHostMemory(MAX_REMEMBERED_HOSTS);
  return async (config, options = {}) => {
    const { signal, playback = false } = options;
    if (signal?.aborted) throw new Error("FTP login aborted");
    const client = new Client(timeoutMs);
    const closeOnAbort = () => client.close();
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    const target = loginTarget(config);
    const hostKey = `${target.host.toLowerCase()}:${target.port}`;
    try {
      if (playback) await leanLogin(client, target, hosts, hostKey);
      else await fullLogin(client, target, hosts, hostKey);
    } catch (error) {
      await closeBasicFtpClient(client);
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
    }

    let idle = true;
    let transferDone = Promise.resolve(true);
    return {
      async list(path: string) {
        const entries = await client.list(path);
        return entries.map((entry) => ({
          name: entry.name,
          path: `${path.replace(/\/+$/, "")}/${entry.name}`,
          type: entry.type === FileType.Directory ? "directory" : "file",
          size: entry.size,
          modifiedAt: entry.modifiedAt?.toISOString(),
        }));
      },
      async openReadStream(path: string, input: FtpReadStreamOptions) {
        idle = false;
        transferDone = Promise.resolve(false);
        const { start, end } = input;
        const bounded = !input.openEnded && end < Number.MAX_SAFE_INTEGER;
        const byteRange = bounded && hosts.supportsByteRanges(hostKey)
          ? await requestByteRange(client, start, end, () => hosts.rejectByteRanges(hostKey))
          : false;
        const download = openLimitedDownloadStream(client, path, {
          start,
          end,
          byteRange,
          onRangeOverrun: () => hosts.rejectByteRanges(hostKey),
        });
        transferDone = download.done.then((clean) => {
          idle = clean && !client.closed;
          return idle;
        });
        return await download.opened;
      },
      isReusable: () => idle && !client.closed,
      whenTransferDone: () => transferDone,
      async close() {
        await closeBasicFtpClient(client);
      },
    };
  };
}

export const createBasicFtpClient: FtpClientFactory = createBasicFtpClientFactory();

function loginTarget(config: FtpConfig): LoginTarget {
  const target = splitFtpHost(config.host);
  return {
    host: target.host,
    port: target.port ?? config.port,
    user: config.username,
    password: config.password,
    secure: config.tlsMode === "implicit" ? "implicit" : config.tlsMode === "explicit",
    secureOptions: config.allowInvalidCertificate ? { rejectUnauthorized: false } : undefined,
  };
}

// Client.access(): the full setup scans need for directory listings. Its FEAT answer is kept for playback logins.
async function fullLogin(client: Client, target: LoginTarget, hosts: FtpHostMemory, hostKey: string) {
  const readFeatures = client.features.bind(client);
  client.features = async () => {
    const features = await readFeatures();
    hosts.rememberFeatures(hostKey, features);
    return features;
  };
  await client.access(target);
}

// A playback login only sets up what a download uses: the session, binary mode and, over TLS, a protected data
// channel. It skips STRU F and OPTS MLST, sends OPTS UTF8 only to servers that advertise UTF8, and reads FEAT once
// per host. Each skipped command is a round trip before the first byte can flow.
async function leanLogin(client: Client, target: LoginTarget, hosts: FtpHostMemory, hostKey: string) {
  const tlsOptions: ConnectionOptions = { ...target.secureOptions };
  if (target.secure === "implicit") {
    await client.connectImplicitTLS(target.host, target.port, tlsOptions);
  } else {
    await client.connect(target.host, target.port);
    if (target.secure === true) await client.useTLS({ ...tlsOptions, host: target.host });
  }
  await client.login(target.user, target.password);
  let features = hosts.features(hostKey);
  if (!features) {
    features = await client.features();
    hosts.rememberFeatures(hostKey, features);
  }
  if (features.has("UTF8")) await client.sendIgnoringError("OPTS UTF8 ON");
  await client.send("TYPE I");
  if (client.ftp.hasTLS) {
    await client.sendIgnoringError("PBSZ 0");
    await client.sendIgnoringError("PROT P");
  }
}

// RANG (draft-bryan-ftp-range) makes the server stop after `end`, so a bounded transfer ends with 226 and the login
// stays usable. A server that refuses it gets REST from then on.
async function requestByteRange(client: Client, start: number, end: number, rejectByteRanges: () => void) {
  let reply;
  try {
    reply = await client.send(`RANG ${start} ${end}`);
  } catch (error) {
    if (!(error instanceof FTPError)) throw error;
    if (error.code >= 500) rejectByteRanges();
    return false;
  }
  if (reply.code === 350) return true;
  rejectByteRanges();
  throw new Error(`Unexpected reply to RANG: ${reply.message.slice(0, 200)}`);
}

async function closeBasicFtpClient(client: Client) {
  const socket = client.ftp.socket;
  const alreadyClosed = socket.closed;
  client.close();
  if (!alreadyClosed) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, SOCKET_CLOSE_TIMEOUT_MS);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  // The provider can retire the login shortly after the local socket closes.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

type LimitedDownload = {
  start: number;
  end: number;
  // RANG already limits the transfer to [start, end], so it starts without REST.
  byteRange: boolean;
  onRangeOverrun: () => void;
};

// `opened` resolves once the first byte arrives (or the transfer ends without data), so a transfer that cannot start
// rejects instead of surfacing later as a broken stream. The output ends as soon as the last requested byte is out, so
// the HTTP response completes right away. `done` settles once the FTP side is over: true when the server confirmed the
// transfer (226) and the login can serve another one, false when the client was closed (aborted, failed, or cut off
// because the server kept sending past the range).
function openLimitedDownloadStream(client: Client, remotePath: string, download: LimitedDownload) {
  const output = new PassThrough();
  let settleDone!: (clean: boolean) => void;
  const done = new Promise<boolean>((resolve) => {
    settleDone = resolve;
  });
  const opened = new Promise<PassThrough>((resolve, reject) => {
    let remaining = Math.max(0, download.end - download.start + 1);
    let isOpen = false;
    let closeRequested = false;
    let completed = false;
    let outputEnded = false;
    let confirmTimer: NodeJS.Timeout | null = null;

    const markOpened = () => {
      if (isOpen) return;
      isOpen = true;
      resolve(output);
    };

    const stopConfirmTimer = () => {
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = null;
    };

    const closeClient = () => {
      if (closeRequested || completed) return;
      closeRequested = true;
      stopConfirmTimer();
      client.close();
    };

    // Once the output is ended deliberately, closing the FTP client must not discard bytes the consumer has not read yet.
    const endOutput = () => {
      if (outputEnded) return;
      outputEnded = true;
      markOpened();
      output.end();
    };

    // Every requested byte was delivered, so a late failure only costs the login, not the response.
    const finishOutput = (error: Error) => {
      if (remaining <= 0) {
        endOutput();
        return;
      }
      if (!isOpen) {
        isOpen = true;
        output.destroy();
        reject(error);
        return;
      }
      if (!outputEnded) output.destroy(error);
    };

    // More bytes than requested: a REST transfer still running mid-file, or a server that did not honor RANG.
    const stopAtRangeEnd = () => {
      if (download.byteRange) download.onRangeOverrun();
      endOutput();
      closeClient();
    };

    const awaitConfirmation = () => {
      confirmTimer = setTimeout(closeClient, TRANSFER_CONFIRM_GRACE_MS);
      confirmTimer.unref?.();
    };

    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (remaining <= 0) {
          stopAtRangeEnd();
          callback();
          return;
        }

        const overrun = chunk.length > remaining;
        const slice = overrun ? chunk.subarray(0, remaining) : chunk;
        remaining -= slice.length;
        const flowing = output.write(slice);
        markOpened();

        if (remaining <= 0) {
          // The response is complete; the FTP side only has to confirm the transfer, so stop applying backpressure.
          endOutput();
          if (overrun) stopAtRangeEnd();
          else awaitConfirmation();
          callback();
          return;
        }
        if (flowing) {
          callback();
          return;
        }
        client.ftp.dataSocket?.setTimeout(PAUSED_DATA_SOCKET_TIMEOUT_MS);
        output.once("drain", () => {
          client.ftp.dataSocket?.setTimeout(client.ftp.timeout);
          callback();
        });
      },
      destroy(error, callback) {
        if (error) {
          closeClient();
          finishOutput(error);
        }
        callback(error);
      },
    });

    // A consumer that goes away before the range is complete (a seek) ends the transfer; once every byte is out, the
    // transfer is left to confirm so the login can be reused.
    output.once("close", () => {
      if (remaining > 0) closeClient();
    });
    client.downloadTo(sink, remotePath, download.byteRange ? 0 : download.start).then(
      () => {
        stopConfirmTimer();
        if (!closeRequested) completed = true;
        endOutput();
        settleDone(completed);
      },
      (error: unknown) => {
        stopConfirmTimer();
        closeClient();
        finishOutput(error instanceof Error ? error : new Error("FTP download failed"));
        settleDone(false);
      },
    );
  });
  return { opened, done };
}
