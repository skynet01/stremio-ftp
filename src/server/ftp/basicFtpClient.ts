import { Client, FileType } from "basic-ftp";
import { PassThrough, Writable } from "node:stream";
import type { FtpConfig } from "../profiles/profileService.js";
import type { FtpClient, FtpClientFactory } from "./ftpTypes.js";

export const createBasicFtpClient: FtpClientFactory = async (config: FtpConfig): Promise<FtpClient> => {
  const client = new Client();
  await client.access({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    secure: config.tlsMode === "implicit" ? "implicit" : config.tlsMode === "explicit",
    secureOptions: config.allowInvalidCertificate ? { rejectUnauthorized: false } : undefined,
  });

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
      client.close();
    },
  };
};

function openLimitedDownloadStream(client: Client, remotePath: string, start: number, end: number) {
  const output = new PassThrough();
  let remaining = Math.max(0, end - start + 1);
  let finished = false;

  const closeClient = () => {
    if (finished) return;
    finished = true;
    client.close();
  };

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (remaining <= 0) {
        closeClient();
        callback();
        return;
      }

      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      remaining -= slice.length;

      const afterWrite = () => {
        if (remaining <= 0) {
          output.end();
          closeClient();
        }
        callback();
      };

      if (!output.write(slice)) {
        output.once("drain", afterWrite);
      } else {
        afterWrite();
      }
    },
    final(callback) {
      output.end();
      closeClient();
      callback();
    },
    destroy(error, callback) {
      closeClient();
      output.destroy(error ?? undefined);
      callback(error);
    },
  });

  output.once("close", closeClient);
  void client.downloadTo(sink, remotePath, start).catch((error) => {
    closeClient();
    output.destroy(error instanceof Error ? error : new Error("FTP download failed"));
  });

  return output;
}
