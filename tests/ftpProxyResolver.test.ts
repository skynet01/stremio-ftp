import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFtpProxyResolver } from "../src/server/proxy/ftpProxyResolver";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("createFtpProxyResolver", () => {
  it("reuses a warmed FTP client for the next stream open", async () => {
    let factoryCalls = 0;
    let openedPath = "";
    const resolver = createFtpProxyResolver(
      {
        profileIdForInstallToken: () => 12,
        getFtpServerConfig: () => ({
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "secret",
          tlsMode: "none",
          allowInvalidCertificate: false,
          roots: ["/"],
        }),
        getFtpConfig: () => null,
      } as never,
      {
        getFileForProfile: () => ({
          id: 44,
          ftpServerId: 5,
          filename: "video.mkv",
          ftpPath: "/video.mkv",
          sizeBytes: 10,
        }),
      } as never,
      async () => {
        factoryCalls += 1;
        return {
          list: async () => [],
          openReadStream: async (path) => {
            openedPath = path;
            return Readable.from("ok");
          },
          close: async () => undefined,
        };
      },
    );

    const file = await resolver({ installToken: "token", fileId: 44 });
    file?.warmReadStream();
    const stream = await file?.openReadStream({ start: 0, end: 1 });

    expect(stream).toBeDefined();
    expect(factoryCalls).toBe(1);
    expect(openedPath).toBe("/video.mkv");
  });

  it("closes the FTP client when a pending stream open is aborted", async () => {
    const streamReady = deferred<NodeJS.ReadableStream>();
    let closed = 0;
    const resolver = createFtpProxyResolver(
      {
        profileIdForInstallToken: () => 12,
        getFtpServerConfig: () => ({
          host: "ftp.example.test",
          port: 21,
          username: "user",
          password: "secret",
          tlsMode: "none",
          allowInvalidCertificate: false,
          roots: ["/"],
        }),
        getFtpConfig: () => null,
      } as never,
      {
        getFileForProfile: () => ({
          id: 44,
          ftpServerId: 5,
          filename: "video.mkv",
          ftpPath: "/video.mkv",
          sizeBytes: 10,
        }),
      } as never,
      async () => ({
        list: async () => [],
        openReadStream: async () => streamReady.promise,
        close: async () => {
          closed += 1;
        },
      }),
    );

    const file = await resolver({ installToken: "token", fileId: 44 });
    const controller = new AbortController();
    const openPromise = file?.openReadStream({ start: 0, end: 1, signal: controller.signal } as never);

    controller.abort();
    streamReady.resolve(Readable.from("ok"));

    await expect(openPromise).rejects.toThrow("Proxy request aborted");
    expect(closed).toBe(1);
  });
});
