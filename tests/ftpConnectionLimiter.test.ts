import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FtpConfig } from "../src/server/profiles/profileService";
import type { FtpClientFactory } from "../src/server/ftp/ftpTypes";
import { limitFtpClientFactory, limitFtpClientFactoryByKey } from "../src/server/ftp/ftpConnectionLimiter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("limitFtpClientFactory", () => {
  it("queues FTP clients when the active connection limit is reached", async () => {
    let opened = 0;
    let active = 0;
    let maxActive = 0;
    const releaseFirst = deferred<void>();

    const factory: FtpClientFactory = async () => {
      opened += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return {
        list: async () => [],
        openReadStream: async () => Readable.from("not used"),
        close: async () => {
          if (opened === 1) await releaseFirst.promise;
          active -= 1;
        },
      };
    };

    const limitedFactory = limitFtpClientFactory(factory, 1);
    const first = await limitedFactory({
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/"],
    });
    const secondPromise = limitedFactory({
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/"],
    });

    await Promise.resolve();
    expect(opened).toBe(1);

    const closeFirst = first.close();
    await Promise.resolve();
    expect(opened).toBe(1);

    releaseFirst.resolve();
    await closeFirst;
    const second = await secondPromise;
    await second.close();

    expect(opened).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("releases queued FTP clients when a read stream closes", async () => {
    let opened = 0;
    const releaseStream = deferred<void>();

    const factory: FtpClientFactory = async () => {
      opened += 1;
      return {
        list: async () => [],
        openReadStream: async () =>
          new Readable({
            read() {
              void releaseStream.promise.then(() => this.push(null));
            },
          }),
        close: async () => undefined,
      };
    };

    const limitedFactory = limitFtpClientFactory(factory, 1);
    const first = await limitedFactory({
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/"],
    });
    const stream = await first.openReadStream("/Movie.mkv", { start: 0, end: 10 });
    const secondPromise = limitedFactory({
      host: "ftp.example.test",
      port: 21,
      username: "user",
      password: "secret",
      tlsMode: "none",
      allowInvalidCertificate: false,
      roots: ["/"],
    });

    stream.resume();
    await Promise.resolve();
    expect(opened).toBe(1);

    releaseStream.resolve();
    await new Promise<void>((resolve) => stream.once("end", resolve));
    const second = await secondPromise;
    await second.close();

    expect(opened).toBe(2);
  });
});

describe("limitFtpClientFactoryByKey", () => {
  it("allows one active connection per FTP credential key", async () => {
    let active = 0;
    let maxActive = 0;
    const factory: FtpClientFactory = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return {
        list: async () => [],
        openReadStream: async () => Readable.from("not used"),
        close: async () => {
          active -= 1;
        },
      };
    };

    const limitedFactory = limitFtpClientFactoryByKey(factory, 1);
    const first = await limitedFactory(ftpConfig({ username: "profile-a" }));
    const second = await limitedFactory(ftpConfig({ username: "profile-b" }));

    await second.close();
    await first.close();

    expect(maxActive).toBe(2);
  });

  it("queues additional connections for the same FTP credential key", async () => {
    let opened = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => {
      opened += 1;
      return {
        list: async () => [],
        openReadStream: async () => Readable.from("not used"),
        close: async () => undefined,
      };
    }, 1);
    const config = ftpConfig({ username: "same-profile" });

    const first = await limitedFactory(config);
    const secondPromise = limitedFactory(config);

    await Promise.resolve();
    expect(opened).toBe(1);

    await first.close();
    const second = await secondPromise;
    await second.close();

    expect(opened).toBe(2);
  });
});

describe("limitFtpClientFactoryByKey cancellation", () => {
  it("drops a queued request when its signal aborts so it never connects", async () => {
    let opened = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => {
      opened += 1;
      return fakeClient();
    }, 1);
    const config = ftpConfig();

    const first = await limitedFactory(config);
    const controller = new AbortController();
    const abandoned = limitedFactory(config, { signal: controller.signal });
    const live = limitedFactory(config);

    controller.abort();
    expect(await settleWithin(abandoned)).toEqual({ status: "rejected", message: expect.stringMatching(/aborted/i) });

    await first.close();
    const liveClient = await live;
    expect(opened).toBe(2);

    await liveClient.close();
    const next = await settleWithin(limitedFactory(config));
    expect(next.status).toBe("fulfilled");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    let opened = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => {
      opened += 1;
      return fakeClient();
    }, 1);

    const result = await settleWithin(limitedFactory(ftpConfig(), { signal: AbortSignal.abort() }));

    expect(result.status).toBe("rejected");
    expect(opened).toBe(0);
    const client = await settleWithin(limitedFactory(ftpConfig()));
    expect(client.status).toBe("fulfilled");
  });

  it("passes the signal to the login and releases the slot when the login is aborted", async () => {
    let loginSignal: AbortSignal | undefined;
    const limitedFactory = limitFtpClientFactoryByKey(
      (_config, options) =>
        new Promise((_resolve, reject) => {
          loginSignal = options?.signal;
          loginSignal?.addEventListener("abort", () => reject(new Error("login aborted")), { once: true });
        }),
      1,
    );
    const controller = new AbortController();

    const pending = limitedFactory(ftpConfig(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    expect((await settleWithin(pending)).status).toBe("rejected");
    expect(loginSignal?.aborted).toBe(true);
  });

  it("closes a client whose login finishes after the request aborted and frees its slot", async () => {
    const login = deferred<void>();
    let opened = 0;
    let closed = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => {
      opened += 1;
      if (opened === 1) await login.promise;
      return fakeClient({ onClose: () => (closed += 1) });
    }, 1);
    const controller = new AbortController();

    const pending = limitedFactory(ftpConfig(), { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    login.resolve();

    expect((await settleWithin(pending)).status).toBe("rejected");
    expect(closed).toBe(1);
    expect((await settleWithin(limitedFactory(ftpConfig()))).status).toBe("fulfilled");
  });
});

function fakeClient(options: { onClose?: () => void } = {}) {
  return {
    list: async () => [],
    openReadStream: async () => Readable.from("not used"),
    close: async () => {
      options.onClose?.();
    },
  };
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

function ftpConfig(overrides: Partial<FtpConfig> = {}): FtpConfig {
  return {
    host: "ftp.example.test",
    port: 21,
    username: "user",
    password: "secret",
    tlsMode: "none",
    allowInvalidCertificate: false,
    roots: ["/"],
    ...overrides,
  };
}
