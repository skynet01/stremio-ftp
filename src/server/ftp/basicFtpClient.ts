import { Client, FileType } from "basic-ftp";
import type { FtpConfig } from "../profiles/profileService.js";
import type { FtpClient, FtpClientFactory } from "./ftpTypes.js";

export const createBasicFtpClient: FtpClientFactory = async (config: FtpConfig): Promise<FtpClient> => {
  const client = new Client();
  await client.access({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    secure: config.tlsMode === "explicit",
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
    async close() {
      client.close();
    },
  };
};
