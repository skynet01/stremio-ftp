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
  it("shares a provider login slot across password and TLS changes for the same account", async () => {
    let active = 0;
    let maxActive = 0;
    const limited = limitFtpClientFactoryByKey(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return fakeClient({ onClose: () => { active -= 1; } });
    }, 1);
    const first = await limited(ftpConfig({ password: "old-password" }));
    const replacement = limited(ftpConfig({ password: "new-password", tlsMode: "explicit" }));

    expect((await settleWithin(replacement)).status).toBe("pending");
    await first.close();
    const second = await replacement;
    await second.close();
    expect(maxActive).toBe(1);
  });

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

describe("limitFtpClientFactoryByKey slot accounting", () => {
  it("releases the slot when the login or the stream open fails", async () => {
    let attempt = 0;
    let closed = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("530 Login incorrect");
      return {
        ...fakeClient({ onClose: () => (closed += 1) }),
        openReadStream: async () => {
          throw new Error("550 Not found");
        },
      };
    }, 1);

    expect((await settleWithin(limitedFactory(ftpConfig()))).status).toBe("rejected");
    const client = await limitedFactory(ftpConfig());
    await expect(client.openReadStream("/missing.mkv", { start: 0, end: 1 })).rejects.toThrow("550");
    await client.close();

    expect(closed).toBe(1);
    expect((await settleWithin(limitedFactory(ftpConfig()))).status).toBe("fulfilled");
  });
});

describe("limitFtpClientFactoryByKey background requests", () => {
  it("does not queue a background request when every slot is busy", async () => {
    let opened = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => {
      opened += 1;
      return fakeClient();
    }, 1);

    const first = await limitedFactory(ftpConfig());
    const background = await settleWithin(limitedFactory(ftpConfig(), { background: true }));

    expect(background.status).toBe("rejected");
    await first.close();
    expect(opened).toBe(1);
    expect((await settleWithin(limitedFactory(ftpConfig()))).status).toBe("fulfilled");
  });

  it("gives an idle background client's slot to a waiting request", async () => {
    let closed = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => fakeClient({ onClose: () => (closed += 1) }), 1);

    const background = await limitedFactory(ftpConfig(), { background: true });
    const foreground = await settleWithin(limitedFactory(ftpConfig()));

    expect(foreground.status).toBe("fulfilled");
    expect(closed).toBe(1);
    expect(background.claim?.()).toBe(false);
  });

  it("keeps a claimed background client until it is closed", async () => {
    const limitedFactory = limitFtpClientFactoryByKey(async () => fakeClient(), 1);

    const background = await limitedFactory(ftpConfig(), { background: true });
    expect(background.claim?.()).toBe(true);
    const foreground = limitedFactory(ftpConfig());

    expect((await settleWithin(foreground)).status).toBe("pending");
    await background.close();
    expect((await settleWithin(foreground)).status).toBe("fulfilled");
  });

  it("cancels a background login when a request needs its slot", async () => {
    let opened = 0;
    const limitedFactory = limitFtpClientFactoryByKey((_config, options) => {
      opened += 1;
      if (opened > 1) return Promise.resolve(fakeClient());
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("login aborted")), { once: true });
      });
    }, 1);

    const background = limitedFactory(ftpConfig(), { background: true });
    await Promise.resolve();
    const foreground = limitedFactory(ftpConfig());

    expect((await settleWithin(background)).status).toBe("rejected");
    expect((await settleWithin(foreground)).status).toBe("fulfilled");
    expect(opened).toBe(2);
  });
});

describe("limitFtpClientFactoryByKey idle clients", () => {
  it("passes the playback flag through to the login", async () => {
    const seen: unknown[] = [];
    const limitedFactory = limitFtpClientFactoryByKey(async (_config, options) => {
      seen.push(options?.playback);
      return fakeClient();
    }, 2);

    await limitedFactory(ftpConfig(), { playback: true });
    await limitedFactory(ftpConfig());

    expect(seen).toEqual([true, undefined]);
  });

  it("reports when a queued request stops waiting and starts its login", async () => {
    const limitedFactory = limitFtpClientFactoryByKey(async () => fakeClient(), 1);
    const first = await limitedFactory(ftpConfig());
    let started = 0;

    const queued = limitedFactory(ftpConfig(), { onLoginStart: () => (started += 1) });
    await settleWithin(queued, 20);
    expect(started).toBe(0);
    await first.close();
    await queued;

    expect(started).toBe(1);
  });

  it("hands a cleanly finished client back instead of closing it", async () => {
    let closed = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => reusableClient({ onClose: () => (closed += 1) }), 1);
    const client = await limitedFactory(ftpConfig());
    let reusable = 0;

    const stream = await client.openReadStream("/a.mkv", { start: 0, end: 1, onReusable: () => (reusable += 1) });
    stream.resume();
    await new Promise((resolve) => stream.once("close", resolve));

    expect(reusable).toBe(1);
    expect(closed).toBe(0);
    expect((await settleWithin(limitedFactory(ftpConfig()))).status).toBe("pending");
  });

  it("closes a client after its stream when nobody takes it back or the transfer did not finish cleanly", async () => {
    let closed = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => reusableClient({ onClose: () => (closed += 1), reusable: false }), 2);
    const unfinished = await limitedFactory(ftpConfig());
    const unclaimed = limitFtpClientFactoryByKey(async () => reusableClient({ onClose: () => (closed += 1) }), 1);

    const first = await unfinished.openReadStream("/a.mkv", { start: 0, end: 1, onReusable: () => undefined });
    const second = await (await unclaimed(ftpConfig())).openReadStream("/a.mkv", { start: 0, end: 1 });
    first.resume();
    second.resume();
    await Promise.all([new Promise((resolve) => first.once("close", resolve)), new Promise((resolve) => second.once("close", resolve))]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closed).toBe(2);
  });

  it("gives a parked client's slot to a request that has to wait", async () => {
    let closed = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => fakeClient({ onClose: () => (closed += 1) }), 1);
    const idle = await limitedFactory(ftpConfig());
    let yielded = 0;

    expect(idle.park?.(() => (yielded += 1))).toBe(true);
    const waiting = await settleWithin(limitedFactory(ftpConfig()));

    expect(waiting.status).toBe("fulfilled");
    expect(yielded).toBe(1);
    expect(closed).toBe(1);
    expect(idle.claim?.()).toBe(false);
  });

  it("gives the slot away at once when a request is already waiting as the client is parked", async () => {
    let closed = 0;
    const limitedFactory = limitFtpClientFactoryByKey(async () => fakeClient({ onClose: () => (closed += 1) }), 1);
    const busy = await limitedFactory(ftpConfig());
    const waiting = limitedFactory(ftpConfig());

    expect(busy.park?.(() => undefined)).toBe(false);

    expect((await settleWithin(waiting)).status).toBe("fulfilled");
    expect(closed).toBe(1);
  });

  it("keeps a parked client once it is claimed again", async () => {
    const limitedFactory = limitFtpClientFactoryByKey(async () => fakeClient(), 1);
    const client = await limitedFactory(ftpConfig());

    client.park?.(() => undefined);
    expect(client.claim?.()).toBe(true);

    expect((await settleWithin(limitedFactory(ftpConfig()))).status).toBe("pending");
  });
});

function reusableClient(options: { onClose?: () => void; reusable?: boolean } = {}) {
  return {
    ...fakeClient(options),
    isReusable: () => options.reusable ?? true,
  };
}

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
