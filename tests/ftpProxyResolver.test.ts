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

  it("opens shared media with the requesting profile server credentials", async () => {
    let openedPath = "";
    const resolver = createFtpProxyResolver(
      {
        profileIdForInstallToken: () => 12,
        getFtpServerConfig: () => ({
          host: "sputnik.whatbox.ca",
          port: 21,
          username: "requesting-user",
          password: "requesting-secret",
          tlsMode: "explicit",
          allowInvalidCertificate: false,
          roots: ["/media"],
        }),
        getFtpConfig: () => null,
        getFtpServer: () => ({
          id: 5,
          profileId: 12,
          ftpConfig: {
            host: "sputnik.whatbox.ca",
            port: 21,
            username: "requesting-user",
            password: "requesting-secret",
            tlsMode: "explicit",
            allowInvalidCertificate: false,
            roots: ["/media"],
          },
          sharedIndex: { id: 3, name: "Sputnik Main", keyHint: "sputnik-main" },
        }),
        getSharedIndexGroup: () => ({
          id: 3,
          host: "sputnik.whatbox.ca",
          port: 21,
          tlsMode: "explicit",
          allowInvalidCertificate: false,
          rootPaths: ["/media"],
        }),
      } as never,
      {
        getSharedFileForProfile: () => ({
          id: 44,
          source: "shared",
          ftpServerId: 5,
          sharedIndexGroupId: 3,
          filename: "video.mkv",
          ftpPath: "/media/video.mkv",
          sizeBytes: 10,
        }),
      } as never,
      async (config) => ({
        list: async () => [],
        openReadStream: async (path) => {
          openedPath = `${config.username}:${path}`;
          return Readable.from("ok");
        },
        close: async () => undefined,
      }),
    );

    const file = await resolver({ installToken: "token", serverId: 5, sharedMediaId: 44 });
    const stream = await file?.openReadStream({ start: 0, end: 1 });

    expect(stream).toBeDefined();
    expect(openedPath).toBe("requesting-user:/media/video.mkv");
  });
});
