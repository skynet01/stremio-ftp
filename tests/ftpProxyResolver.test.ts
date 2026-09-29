import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { limitFtpClientFactoryByKey } from "../src/server/ftp/ftpConnectionLimiter";
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

  it("abandons a stream open that is still waiting for an FTP connection slot", async () => {
    let factoryCalls = 0;
    const resolver = createFtpProxyResolver(
      profileStub(),
      mediaStub(),
      limitFtpClientFactoryByKey(async () => {
        factoryCalls += 1;
        return {
          list: async () => [],
          openReadStream: async () => new Readable({ read() {} }),
          close: async () => undefined,
        };
      }, 1),
    );
    const file = await resolver({ installToken: "token", fileId: 44 });
    const playing = await file!.openReadStream({ start: 0, end: 9 });

    const controller = new AbortController();
    const abandoned = file!.openReadStream({ start: 5, end: 9, signal: controller.signal });
    controller.abort();

    expect(await settleWithin(abandoned)).toEqual({ status: "rejected", message: "Proxy request aborted" });

    const live = file!.openReadStream({ start: 7, end: 9 });
    (playing as Readable).destroy();
    expect((await settleWithin(live)).status).toBe("fulfilled");
    expect(factoryCalls).toBe(2);
  });

  it("releases an idle warm-up connection when playback of another file needs the slot", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv" }), connections.factory);

    const fileA = await resolver({ installToken: "token", fileId: 44 });
    fileA!.warmReadStream();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fileB = await resolver({ installToken: "token", fileId: 45 });

    expect((await settleWithin(fileB!.openReadStream({ start: 0, end: 9 }))).status).toBe("fulfilled");
    expect(connections.closed).toEqual([1]);
    expect(connections.opened).toEqual(["/b.mkv"]);
  });

  it("does not queue warm-ups ahead of playback requests", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv", 46: "/c.mkv" }), connections.factory);

    const playingA = await (await resolver({ installToken: "token", fileId: 44 }))!.openReadStream({ start: 0, end: 9 });
    (await resolver({ installToken: "token", fileId: 45 }))!.warmReadStream();
    const playingC = (await resolver({ installToken: "token", fileId: 46 }))!.openReadStream({ start: 0, end: 9 });

    (playingA as Readable).destroy();

    expect((await settleWithin(playingC)).status).toBe("fulfilled");
    expect(connections.created).toBe(2);
  });

  it("keeps using a warmed client once playback has claimed it", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv" }), connections.factory);

    const fileA = await resolver({ installToken: "token", fileId: 44 });
    fileA!.warmReadStream();
    const playingA = await fileA!.openReadStream({ start: 0, end: 9 });
    const playingB = (await resolver({ installToken: "token", fileId: 45 }))!.openReadStream({ start: 0, end: 9 });

    expect((await settleWithin(playingB)).status).toBe("pending");
    expect(connections.created).toBe(1);
    expect(connections.closed).toEqual([]);

    (playingA as Readable).destroy();
    expect((await settleWithin(playingB)).status).toBe("fulfilled");
  });

  it("opens a fresh connection when its warm client was released to another request", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv" }), connections.factory);

    const fileA = await resolver({ installToken: "token", fileId: 44 });
    fileA!.warmReadStream();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const playingB = await (await resolver({ installToken: "token", fileId: 45 }))!.openReadStream({ start: 0, end: 9 });
    const playingA = fileA!.openReadStream({ start: 0, end: 9 });

    expect((await settleWithin(playingA)).status).toBe("pending");
    (playingB as Readable).destroy();
    expect((await settleWithin(playingA)).status).toBe("fulfilled");
    expect(connections.opened).toEqual(["/b.mkv", "/a.mkv"]);
    expect(connections.created).toBe(3);
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

function profileStub(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  } as never;
}

function mediaStub(files: Record<number, string> = { 44: "/video.mkv" }) {
  return {
    getFileForProfile: (_profileId: number, fileId: number) =>
      files[fileId]
        ? { id: fileId, ftpServerId: 5, filename: files[fileId]!.slice(1), ftpPath: files[fileId], sizeBytes: 10 }
        : null,
  } as never;
}

async function settleWithin<T>(promise: Promise<T>, ms = 100) {
  const timeout = new Promise<{ status: "pending" }>((resolve) => setTimeout(() => resolve({ status: "pending" }), ms));
  return Promise.race([
    promise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, message: error instanceof Error ? error.message : String(error) }),
    ),
    timeout,
  ]);
}

function limitedConnections(maxConnections: number) {
  const state = { created: 0, closed: [] as number[], opened: [] as string[] };
  const factory = limitFtpClientFactoryByKey(async () => {
    state.created += 1;
    const id = state.created;
    let closed = false;
    return {
      list: async () => [],
      openReadStream: async (path: string) => {
        if (closed) throw new Error("Client is closed");
        state.opened.push(path);
        return new Readable({ read() {} });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        state.closed.push(id);
      },
    };
  }, maxConnections);
  return Object.assign(state, { factory });
}
