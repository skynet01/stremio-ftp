import { Client, FileType } from "basic-ftp";
import { PassThrough, Writable } from "node:stream";
import { splitFtpHost } from "../../shared/ftpHost.js";
import type { FtpConfig } from "../profiles/profileService.js";
import type { FtpClient, FtpClientFactory } from "./ftpTypes.js";

const SOCKET_CLOSE_TIMEOUT_MS = 3_000;
// A paused player stops reading, which idles the FTP data socket; only a real stall should time it out.
const PAUSED_DATA_SOCKET_TIMEOUT_MS = 30 * 60_000;

export function createBasicFtpClientFactory(
  timeoutMs = 30000,
): (config: FtpConfig, options?: { signal?: AbortSignal }) => Promise<FtpClient> {
  return async (config, options = {}) => {
    const { signal } = options;
    if (signal?.aborted) throw new Error("FTP login aborted");
    const client = new Client(timeoutMs);
    const closeOnAbort = () => client.close();
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      const target = splitFtpHost(config.host);
      await client.access({
        host: target.host,
        port: target.port ?? config.port,
        user: config.username,
        password: config.password,
        secure: config.tlsMode === "implicit" ? "implicit" : config.tlsMode === "explicit",
        secureOptions: config.allowInvalidCertificate ? { rejectUnauthorized: false } : undefined,
      });
    } catch (error) {
      await closeBasicFtpClient(client);
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
    }
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
      async openReadStream(path: string, input: { start: number; end: number }) {
        return openLimitedDownloadStream(client, path, input.start, input.end);
      },
      async close() {
        await closeBasicFtpClient(client);
      },
    };
  };
}

export const createBasicFtpClient: FtpClientFactory = createBasicFtpClientFactory();

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

function openLimitedDownloadStream(client: Client, remotePath: string, start: number, end: number) {
  const output = new PassThrough();
  let remaining = Math.max(0, end - start + 1);
  let closeRequested = false;
  let outputEnded = false;

  const closeClient = () => {
    if (closeRequested) return;
    closeRequested = true;
    client.close();
  };

  // Once the output is ended deliberately, closing the FTP client must not discard bytes the consumer has not read yet.
  const endOutput = () => {
    if (outputEnded) return;
    outputEnded = true;
    output.end();
  };

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (remaining <= 0) {
        endOutput();
        closeClient();
        callback();
        return;
      }

      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      remaining -= slice.length;

      const afterWrite = () => {
        if (remaining <= 0) {
          endOutput();
          closeClient();
        }
        callback();
      };

      if (!output.write(slice)) {
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
        if (!outputEnded) output.destroy(error);
      }
      callback(error);
    },
  });

  output.once("close", closeClient);
  client.downloadTo(sink, remotePath, start).then(
    () => {
      endOutput();
      closeClient();
    },
    (error) => {
      closeClient();
      if (outputEnded) return;
      output.destroy(error instanceof Error ? error : new Error("FTP download failed"));
    },
  );

  return output;
}
