import type { FtpConfig } from "../profiles/profileService.js";

export type FtpEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
};

export type FtpClient = {
  list(path: string): Promise<FtpEntry[]>;
  close(): Promise<void>;
};

export type FtpClientFactory = (config: FtpConfig) => Promise<FtpClient>;
