import type { FtpConfig } from "../profiles/profileService.js";

export type FtpEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
};

export type FtpReadStreamOptions = {
  start: number;
  end: number;
  // The HTTP range had no end (bytes=start-): players usually drop such a request on the next seek.
  openEnded?: boolean;
  // Honored by the connection limiter: called instead of closing the client when its transfer completed cleanly
  // and the login can serve another one.
  onReusable?: () => void;
};

export type FtpClient = {
  list(path: string): Promise<FtpEntry[]>;
  openReadStream(path: string, input: FtpReadStreamOptions): Promise<NodeJS.ReadableStream>;
  close(): Promise<void>;
  // True while the login is open and idle: no transfer is running and the last one completed cleanly.
  isReusable?(): boolean;
};

export type FtpClientFactory = (config: FtpConfig) => Promise<FtpClient>;
