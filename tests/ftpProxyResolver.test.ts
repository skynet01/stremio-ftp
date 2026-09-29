import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFtpConnectionPool, type FtpConnectionPool } from "../src/server/ftp/ftpConnectionPool";
import { limitFtpClientFactoryByKey, type AbortableFtpClientFactory } from "../src/server/ftp/ftpConnectionLimiter";
import { createFtpProxyResolver } from "../src/server/proxy/ftpProxyResolver";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const pools: FtpConnectionPool[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function pooled(factory: AbortableFtpClientFactory) {
  const pool = createFtpConnectionPool(factory, { idleMs: 45_000, loginFailureMs: 60_000 });
  pools.push(pool);
  return pool;
}

describe("createFtpProxyResolver", () => {
  it("aborts a claimed warm login when its playback request is cancelled", async () => {
    let aborted = false;
    let logins = 0;
    const resolver = createFtpProxyResolver(profileStub(), mediaStub(), pooled((_config, options) => {
      logins += 1;
      if (logins > 1) return Promise.resolve({
        list: async () => [],
        openReadStream: async () => Readable.from("ok"),
        close: async () => undefined,
      });
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("login aborted"));
        }, { once: true });
      });
    }));
    const file = await resolver({ installToken: "token", fileId: 44 });
    file!.warmReadStream();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const controller = new AbortController();
    const pending = file!.openReadStream({ start: 0, end: 9, signal: controller.signal });
    controller.abort();

    expect(await settleWithin(pending)).toEqual({ status: "rejected", message: "Proxy request aborted" });
    expect(aborted).toBe(true);
    expect((await settleWithin(file!.openReadStream({ start: 0, end: 9 }))).status).toBe("fulfilled");
  });

  it("does not reuse a warmed login after the FTP password changes", async () => {
    let password = "old-password";
    const usedPasswords: string[] = [];
    const resolver = createFtpProxyResolver(
      profileStub({ getFtpServerConfig: () => ({
        host: "ftp.example.test", port: 21, username: "user", password,
        tlsMode: "none", allowInvalidCertificate: false, roots: ["/"],
      }) }),
      mediaStub(),
      pooled(async (config) => ({
        list: async () => [],
        openReadStream: async () => {
          usedPasswords.push(config.password);
          return Readable.from("ok");
        },
        close: async () => undefined,
      })),
    );
    (await resolver({ installToken: "token", fileId: 44 }))!.warmReadStream();
    password = "new-password";
    const file = await resolver({ installToken: "token", fileId: 44 });
    await file!.openReadStream({ start: 0, end: 9 });

    expect(usedPasswords).toEqual(["new-password"]);
  });

  it("opens the stream on the warmed FTP login", async () => {
    const openedBy: number[] = [];
    let logins = 0;
    const resolver = createFtpProxyResolver(profileStub(), mediaStub(), pooled(async () => {
      const id = ++logins;
      return {
        list: async () => [],
        openReadStream: async () => {
          openedBy.push(id);
          return Readable.from("ok");
        },
        close: async () => undefined,
      };
    }));

    const file = await resolver({ installToken: "token", fileId: 44 });
    file?.warmReadStream();
    const stream = await file?.openReadStream({ start: 0, end: 1 });

    expect(stream).toBeDefined();
    expect(openedBy).toEqual([1]);
  });

  it("closes the FTP client when a pending stream open is aborted", async () => {
    const streamReady = deferred<NodeJS.ReadableStream>();
    let closed = 0;
    const resolver = createFtpProxyResolver(
      profileStub(),
      mediaStub(),
      pooled(async () => ({
        list: async () => [],
        openReadStream: async () => streamReady.promise,
        close: async () => {
          closed += 1;
        },
      })),
    );

    const file = await resolver({ installToken: "token", fileId: 44 });
    const controller = new AbortController();
    const openPromise = file?.openReadStream({ start: 0, end: 1, signal: controller.signal } as never);

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    streamReady.resolve(Readable.from("ok"));

    await expect(openPromise).rejects.toThrow("Proxy request aborted");
    expect(closed).toBe(1);
  });

  it("abandons a stream open that is still waiting for an FTP connection slot", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub(), pooled(connections.factory));
    const file = await resolver({ installToken: "token", fileId: 44 });
    const playing = await file!.openReadStream({ start: 0, end: 9 });

    const controller = new AbortController();
    const abandoned = file!.openReadStream({ start: 5, end: 9, signal: controller.signal });
    controller.abort();

    expect(await settleWithin(abandoned)).toEqual({ status: "rejected", message: "Proxy request aborted" });

    const live = file!.openReadStream({ start: 7, end: 9 });
    (playing as Readable).destroy();
    expect((await settleWithin(live)).status).toBe("fulfilled");
    expect(connections.created).toBe(2);
  });

  it("serves any file of the account from a warm login", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv" }), pooled(connections.factory));

    const fileA = await resolver({ installToken: "token", fileId: 44 });
    fileA!.warmReadStream();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fileB = await resolver({ installToken: "token", fileId: 45 });

    expect((await settleWithin(fileB!.openReadStream({ start: 0, end: 9 }))).status).toBe("fulfilled");
    expect(connections.created).toBe(1);
    expect(connections.opened).toEqual(["1:/b.mkv"]);
  });

  it("does not queue warm-ups ahead of playback requests", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv", 46: "/c.mkv" }), pooled(connections.factory));

    const playingA = await (await resolver({ installToken: "token", fileId: 44 }))!.openReadStream({ start: 0, end: 9 });
    (await resolver({ installToken: "token", fileId: 45 }))!.warmReadStream();
    const playingC = (await resolver({ installToken: "token", fileId: 46 }))!.openReadStream({ start: 0, end: 9 });

    (playingA as Readable).destroy();

    expect((await settleWithin(playingC)).status).toBe("fulfilled");
    expect(connections.created).toBe(2);
  });

  it("keeps using a warmed client once playback has claimed it", async () => {
    const connections = limitedConnections(1);
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv" }), pooled(connections.factory));

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

  it("logs pooled reuse without credentials", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const connections = limitedConnections(1, { finishStreams: true });
    const resolver = createFtpProxyResolver(profileStub(), mediaStub({ 44: "/a.mkv", 45: "/b.mkv" }), pooled(connections.factory));

    await drain(await (await resolver({ installToken: "token", fileId: 44 }))!.openReadStream({ start: 0, end: 9 }));
    await drain(await (await resolver({ installToken: "token", fileId: 45 }))!.openReadStream({ start: 0, end: 9 }));

    const opened = info.mock.calls
      .filter(([label, payload]) => label === "[proxy-ftp-timing]" && String(payload).includes("stream_opened"))
      .map(([, payload]) => String(payload));
    expect(opened.map((payload) => JSON.parse(payload).pooled)).toEqual([false, true]);
    expect(connections.created).toBe(1);
    expect(opened.join("\n")).not.toMatch(/secret|"user"/);
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
        getSharedIndexGroupIdentity: () => ({
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
      pooled(async (config) => ({
        list: async () => [],
        openReadStream: async (path) => {
          openedPath = `${config.username}:${path}`;
          return Readable.from("ok");
        },
        close: async () => undefined,
      })),
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

async function drain(stream: NodeJS.ReadableStream) {
  for await (const _chunk of stream) {
    // Read the whole range like a player that finishes it.
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function limitedConnections(maxConnections: number, options: { finishStreams?: boolean } = {}) {
  const state = { created: 0, closed: [] as number[], opened: [] as string[] };
  const factory = limitFtpClientFactoryByKey(async () => {
    state.created += 1;
    const id = state.created;
    let closed = false;
    let idle = true;
    let transferDone = Promise.resolve(true);
    return {
      list: async () => [],
      openReadStream: async (path: string) => {
        if (closed) throw new Error("Client is closed");
        state.opened.push(`${id}:${path}`);
        idle = false;
        let settle!: (clean: boolean) => void;
        transferDone = new Promise((resolve) => {
          settle = resolve;
        });
        const stream = options.finishStreams
          ? new Readable({
              read() {
                idle = true;
                settle(true);
                this.push("0123456789");
                this.push(null);
              },
            })
          : new Readable({ read() {} });
        // A consumer that goes away first cuts the transfer off, like the basic-ftp client.
        stream.once("close", () => settle(false));
        return stream;
      },
      isReusable: () => idle && !closed,
      whenTransferDone: () => transferDone,
      close: async () => {
        if (closed) return;
        closed = true;
        state.closed.push(id);
      },
    };
  }, maxConnections);
  return Object.assign(state, { factory });
}
