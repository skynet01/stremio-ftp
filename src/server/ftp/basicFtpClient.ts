import { Client, FileType, FTPError, type AccessOptions } from "basic-ftp";
import { PassThrough, Writable } from "node:stream";
import { TLSSocket, type ConnectionOptions } from "node:tls";
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
  private readonly tlsSessions = new Map<string, Buffer>();

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

  tlsSession(sessionKey: string) {
    return this.tlsSessions.get(sessionKey);
  }

  rememberTlsSession(sessionKey: string, session: Buffer) {
    setBounded(this.tlsSessions, sessionKey, session, this.maxEntries);
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
      if (playback) await leanLogin(client, target, hosts, hostKey, tlsSessionKey(config, target));
      else await fullLogin(client, target, hosts, hostKey);
    } catch (error) {
      await closeBasicFtpClient(client);
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
    }

    let idle = true;
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
        const { start, end } = input;
        const bounded = !input.openEnded && end < Number.MAX_SAFE_INTEGER;
        const byteRange = bounded && hosts.supportsByteRanges(hostKey)
          ? await requestByteRange(client, start, end, () => hosts.rejectByteRanges(hostKey))
          : false;
        return openLimitedDownloadStream(client, path, {
          start,
          end,
          byteRange,
          onComplete: () => {
            idle = true;
          },
          onRangeOverrun: () => hosts.rejectByteRanges(hostKey),
        });
      },
      isReusable: () => idle && !client.closed,
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

// A TLS session is only resumed by a later connection with the same host and certificate policy.
function tlsSessionKey(config: FtpConfig, target: LoginTarget) {
  if (config.tlsMode === "none") return null;
  return [config.tlsMode, target.host.toLowerCase(), target.port, config.allowInvalidCertificate ? "any-certificate" : "verified"].join("\0");
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
async function leanLogin(client: Client, target: LoginTarget, hosts: FtpHostMemory, hostKey: string, sessionKey: string | null) {
  const tlsOptions: ConnectionOptions = { ...target.secureOptions, session: sessionKey ? hosts.tlsSession(sessionKey) : undefined };
  if (target.secure === "implicit") {
    await client.connectImplicitTLS(target.host, target.port, tlsOptions);
  } else {
    await client.connect(target.host, target.port);
    if (target.secure === true) await client.useTLS({ ...tlsOptions, host: target.host });
  }
  if (sessionKey) rememberTlsSessions(client, hosts, sessionKey);
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

// Offering the last session of a host lets the next control connection skip part of the TLS handshake. A server
// that does not know the session any more simply runs a full handshake.
function rememberTlsSessions(client: Client, hosts: FtpHostMemory, sessionKey: string) {
  const socket = client.ftp.socket;
  if (!(socket instanceof TLSSocket)) return;
  const current = socket.getSession();
  if (current) hosts.rememberTlsSession(sessionKey, current);
  // TLS 1.3 hands out session tickets after the handshake.
  socket.on("session", (session: Buffer) => hosts.rememberTlsSession(sessionKey, session));
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
  // The transfer finished with 226 and the login is idle again.
  onComplete: () => void;
  onRangeOverrun: () => void;
};

// Resolves once the first byte arrives (or the transfer ends without data), so a transfer that cannot start rejects
// instead of surfacing later as a broken stream. The output only ends once the transfer is settled: confirmed by the
// server (the login stays open for reuse) or cut off because the server kept sending past the range.
function openLimitedDownloadStream(client: Client, remotePath: string, download: LimitedDownload) {
  return new Promise<PassThrough>((resolve, reject) => {
    const output = new PassThrough();
    let remaining = Math.max(0, download.end - download.start + 1);
    let opened = false;
    let closeRequested = false;
    let completed = false;
    let outputEnded = false;
    let confirmTimer: NodeJS.Timeout | null = null;

    const markOpened = () => {
      if (opened) return;
      opened = true;
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
      if (!opened) {
        opened = true;
        output.destroy();
        reject(error);
        return;
      }
      if (!outputEnded) output.destroy(error);
    };

    const stopAtRangeEnd = () => {
      if (download.byteRange) download.onRangeOverrun();
      endOutput();
      closeClient();
    };

    const awaitConfirmation = () => {
      confirmTimer = setTimeout(() => {
        endOutput();
        closeClient();
      }, TRANSFER_CONFIRM_GRACE_MS);
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

        const afterWrite = () => {
          if (overrun) stopAtRangeEnd();
          else if (remaining <= 0) awaitConfirmation();
          callback();
        };

        const flowing = output.write(slice);
        markOpened();
        if (!flowing) {
          client.ftp.dataSocket?.setTimeout(PAUSED_DATA_SOCKET_TIMEOUT_MS);
          output.once("drain", () => {
            client.ftp.dataSocket?.setTimeout(client.ftp.timeout);
            afterWrite();
          });
        } else {
          afterWrite();
        }
      },
      destroy(error, callback) {
        if (error) {
          closeClient();
          finishOutput(error);
        }
        callback(error);
      },
    });

    output.once("close", () => {
      if (!completed) closeClient();
    });
    client.downloadTo(sink, remotePath, download.byteRange ? 0 : download.start).then(
      () => {
        stopConfirmTimer();
        if (!closeRequested) {
          completed = true;
          download.onComplete();
        }
        endOutput();
      },
      (error: unknown) => {
        stopConfirmTimer();
        closeClient();
        finishOutput(error instanceof Error ? error : new Error("FTP download failed"));
      },
    );
  });
}
