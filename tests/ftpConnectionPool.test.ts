import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFtpConnectionPool, type FtpConnectionPool } from "../src/server/ftp/ftpConnectionPool";
import { limitFtpClientFactoryByKey, type FtpClientRequestOptions } from "../src/server/ftp/ftpConnectionLimiter";
import type { FtpClient, FtpReadStreamOptions } from "../src/server/ftp/ftpTypes";
import type { FtpConfig } from "../src/server/profiles/profileService";

const pools: FtpConnectionPool[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("createFtpConnectionPool", () => {
  it("reuses a finished login for another file of the same account", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp);

    const first = await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 });
    await drain(first.stream);
    const second = await pool.openReadStream(config(), "/b.mkv", { start: 5, end: 9 });
    await drain(second.stream);

    expect(ftp.logins).toBe(1);
    expect(ftp.opened).toEqual(["1:/a.mkv", "1:/b.mkv"]);
    expect(first.source).toBe("new");
    expect(second.source).toBe("idle");
  });

  it("never hands one account's login to another", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp);

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    await drain((await pool.openReadStream(config({ password: "changed" }), "/a.mkv", { start: 0, end: 9 })).stream);
    await drain((await pool.openReadStream(config({ username: "someone-else" }), "/a.mkv", { start: 0, end: 9 })).stream);
    await drain((await pool.openReadStream(config({ tlsMode: "explicit" }), "/a.mkv", { start: 0, end: 9 })).stream);

    expect(ftp.logins).toBe(4);
    expect(ftp.loginPasswords).toEqual(["secret", "changed", "secret", "secret"]);
  });

  it("closes a login whose transfer did not finish cleanly", async () => {
    const ftp = fakeFtp({ maxConnections: 1, reusableAfterTransfer: false });
    const pool = createPool(ftp);

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    await drain((await pool.openReadStream(config(), "/b.mkv", { start: 0, end: 9 })).stream);

    expect(ftp.logins).toBe(2);
    await waitFor(() => ftp.closed.length === 2);
  });

  it("logs idle clients out after the idle time and releases their slots", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp, { idleMs: 40 });

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    expect(ftp.closed).toEqual([]);
    await waitFor(() => ftp.closed.length === 1);

    expect(ftp.active()).toBe(0);
    await drain((await pool.openReadStream(config(), "/b.mkv", { start: 0, end: 9 })).stream);
    expect(ftp.logins).toBe(2);
  });

  it("does not keep logins when pooling is off", async () => {
    const ftp = fakeFtp({ maxConnections: 3 });
    const pool = createPool(ftp, { idleMs: 0 });

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    await drain((await pool.openReadStream(config(), "/b.mkv", { start: 0, end: 9 })).stream);
    pool.warm(config());

    expect(ftp.logins).toBe(2);
    await waitFor(() => ftp.closed.length === 2);
  });

  it("gives an idle login's slot to a request that has to wait for the same FTP user", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp);

    await drain((await pool.openReadStream(config({ password: "old" }), "/a.mkv", { start: 0, end: 9 })).stream);
    const next = await settleWithin(pool.openReadStream(config({ password: "new" }), "/a.mkv", { start: 0, end: 9 }));

    expect(next.status).toBe("fulfilled");
    expect(ftp.closed).toEqual([1]);
    expect(ftp.loginPasswords).toEqual(["old", "new"]);
  });

  it("gives an idle login's slot to a scan that has to wait", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp);

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    const scan = await settleWithin(ftp.factory(config()));

    expect(scan.status).toBe("fulfilled");
    expect(ftp.closed).toEqual([1]);
  });

  it("hands a finished login straight to a request that is waiting for a slot", async () => {
    const ftp = fakeFtp({ maxConnections: 1, manualStreams: true });
    const pool = createPool(ftp);

    const playing = await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 });
    const waiting = pool.openReadStream(config(), "/b.mkv", { start: 0, end: 9 });
    expect((await settleWithin(waiting)).status).toBe("pending");
    ftp.finishStream(0);
    await drain(playing.stream);

    const next = await waiting;
    expect(next.source).toBe("handoff");
    expect(ftp.logins).toBe(1);
    expect(ftp.opened).toEqual(["1:/a.mkv", "1:/b.mkv"]);
  });

  it("logs in again once when a pooled login fails before the first byte", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp);

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    ftp.failNextOpen("Client is closed because Server sent FIN packet unexpectedly");
    const retried = await pool.openReadStream(config(), "/b.mkv", { start: 0, end: 9 });
    await drain(retried.stream);

    expect(retried.retriedFresh).toBe(true);
    expect(ftp.logins).toBe(2);
    expect(ftp.opened).toEqual(["1:/a.mkv", "2:/b.mkv"]);
  });

  it("does not log in again after a pooled login stalled instead of failing at once", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp);

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    ftp.failNextOpen("Timeout (control socket)", () => {
      now += 15_000;
    });

    await expect(pool.openReadStream(config(), "/b.mkv", { start: 0, end: 9 })).rejects.toThrow("Timeout");
    expect(ftp.logins).toBe(1);
  });

  it("does not retry a fresh login that fails before the first byte", async () => {
    const ftp = fakeFtp({ maxConnections: 1 });
    const pool = createPool(ftp);

    ftp.failNextOpen("550 Not found");
    await expect(pool.openReadStream(config(), "/missing.mkv", { start: 0, end: 9 })).rejects.toThrow("550");

    expect(ftp.logins).toBe(1);
  });

  it("closes idle and warming logins on shutdown", async () => {
    const ftp = fakeFtp({ maxConnections: 3 });
    const pool = createPool(ftp);

    await drain((await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).stream);
    pool.warm(config({ username: "other" }));
    await pool.close();

    await waitFor(() => ftp.active() === 0);
  });

  it("stops a warm login when the request waiting on it is cancelled", async () => {
    const ftp = fakeFtp({ maxConnections: 3, stallLogins: true });
    const pool = createPool(ftp);
    pool.warm(config());
    await waitFor(() => ftp.loginAttempts === 1);
    const controller = new AbortController();

    const pending = pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 }, controller.signal);
    controller.abort();

    expect(await settleWithin(pending)).toEqual({ status: "rejected", message: expect.stringMatching(/abort/i) });
    await waitFor(() => ftp.abortedLogins >= 1);
  });
});

describe("createFtpConnectionPool warm-ups", () => {
  it("serves the next request from a warm login", async () => {
    const ftp = fakeFtp({ maxConnections: 3 });
    const pool = createPool(ftp);

    pool.warm(config());
    await waitFor(() => ftp.logins === 1);
    const opened = await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 });

    expect(["warm", "idle"]).toContain(opened.source);
    expect(ftp.opened).toEqual(["1:/a.mkv"]);
  });

  it("keeps one spare login ready after a request takes the last idle one", async () => {
    const ftp = fakeFtp({ maxConnections: 3, manualStreams: true });
    const pool = createPool(ftp);

    const first = await pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 });
    await waitFor(() => ftp.logins === 2);
    const second = await pool.openReadStream(config(), "/b.mkv", { start: 0, end: 9 });
    await waitFor(() => ftp.logins === 3);
    const third = await pool.openReadStream(config(), "/c.mkv", { start: 0, end: 9 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(first.source).toBe("new");
    expect(second.source).toBe("idle");
    expect(third.source).toBe("idle");
    expect(ftp.logins).toBe(3);
    expect(ftp.active()).toBe(3);
  });

  it("warms at most one spare per account", async () => {
    const ftp = fakeFtp({ maxConnections: 5 });
    const pool = createPool(ftp);

    pool.warm(config());
    pool.warm(config());
    pool.prewarm([config(), config(), config()], 3);
    await waitFor(() => ftp.logins === 1);
    pool.warm(config());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ftp.logins).toBe(1);
  });

  it("warms up to the requested number of distinct accounts", async () => {
    const ftp = fakeFtp({ maxConnections: 3 });
    const pool = createPool(ftp);

    pool.prewarm(
      [config({ username: "a" }), config({ username: "a" }), config({ username: "b" }), config({ username: "c" }), config({ username: "d" })],
      3,
    );
    await waitFor(() => ftp.logins === 3);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ftp.loginUsers.sort()).toEqual(["a", "b", "c"]);
  });

  it("gives a warming login's slot to a real request", async () => {
    const ftp = fakeFtp({ maxConnections: 1, stallLogins: true });
    const pool = createPool(ftp);

    pool.warm(config({ password: "other" }));
    await waitFor(() => ftp.loginAttempts === 1);
    ftp.stallLogins = false;
    const opened = await settleWithin(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 }));

    expect(opened.status).toBe("fulfilled");
    expect(ftp.abortedLogins).toBe(1);
  });
});

describe("createFtpConnectionPool rejected logins", () => {
  it("fails fast for a while after the server rejects the login", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ftp = fakeFtp({ maxConnections: 3, loginReply: { code: 530, message: "530 Login incorrect." } });
    const pool = createPool(ftp, { loginFailureMs: 60_000 });

    await expect(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("530");
    await expect(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("530");
    pool.warm(config());
    pool.prewarm([config()], 3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ftp.loginAttempts).toBe(1);

    await expect(pool.openReadStream(config({ password: "fixed" }), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("530");
    expect(ftp.loginAttempts).toBe(2);

    now += 60_001;
    await expect(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("530");
    expect(ftp.loginAttempts).toBe(3);
  });

  it("keeps retrying logins that failed for other reasons", async () => {
    const ftp = fakeFtp({ maxConnections: 3, loginReply: { message: "Timeout (control socket)" } });
    const pool = createPool(ftp);

    await expect(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("Timeout");
    await expect(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("Timeout");

    expect(ftp.loginAttempts).toBe(2);
  });

  it("does not treat a session-limit 530 as a bad password", async () => {
    const ftp = fakeFtp({
      maxConnections: 3,
      loginReply: { code: 530, message: "530 Sorry, the maximum number of clients (3) for this user are already connected." },
    });
    const pool = createPool(ftp);

    await expect(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("530");
    await expect(pool.openReadStream(config(), "/a.mkv", { start: 0, end: 9 })).rejects.toThrow("530");

    expect(ftp.loginAttempts).toBe(2);
  });
});

function createPool(ftp: ReturnType<typeof fakeFtp>, options: { idleMs?: number; loginFailureMs?: number } = {}) {
  const pool = createFtpConnectionPool(ftp.factory, { idleMs: options.idleMs ?? 45_000, loginFailureMs: options.loginFailureMs ?? 60_000 });
  pools.push(pool);
  return pool;
}

// A fake FTP account behind the real connection limiter. Streams emit their range and end; clients report
// themselves reusable after a clean transfer, like the basic-ftp client does.
function fakeFtp(options: {
  maxConnections: number;
  reusableAfterTransfer?: boolean;
  manualStreams?: boolean;
  stallLogins?: boolean;
  loginReply?: { code?: number; message: string };
}) {
  const state = {
    logins: 0,
    loginAttempts: 0,
    abortedLogins: 0,
    stallLogins: options.stallLogins ?? false,
    loginPasswords: [] as string[],
    loginUsers: [] as string[],
    opened: [] as string[],
    closed: [] as number[],
    openClients: new Set<number>(),
    pendingStreams: [] as Readable[],
    nextOpenFailure: null as { message: string; beforeFailing?: () => void } | null,
  };
  const login = async (ftpConfig: FtpConfig, requestOptions?: FtpClientRequestOptions): Promise<FtpClient> => {
    state.loginAttempts += 1;
    if (state.stallLogins) {
      await new Promise<void>((_resolve, reject) => {
        requestOptions?.signal?.addEventListener("abort", () => {
          state.abortedLogins += 1;
          reject(new Error("login aborted"));
        }, { once: true });
      });
    }
    if (options.loginReply) throw Object.assign(new Error(options.loginReply.message), { code: options.loginReply.code });
    state.logins += 1;
    state.loginPasswords.push(ftpConfig.password);
    state.loginUsers.push(ftpConfig.username);
    const id = state.logins;
    state.openClients.add(id);
    let idle = true;
    let closed = false;
    let transferDone = Promise.resolve(true);
    return {
      list: async () => [],
      openReadStream: async (path: string, range: FtpReadStreamOptions) => {
        if (closed) throw new Error("Client is closed");
        if (state.nextOpenFailure) {
          const failure = state.nextOpenFailure;
          state.nextOpenFailure = null;
          failure.beforeFailing?.();
          throw new Error(failure.message);
        }
        idle = false;
        state.opened.push(`${id}:${path}`);
        const body = Buffer.alloc(range.end - range.start + 1, id);
        const stream = new Readable({ read() {} });
        let settle!: (clean: boolean) => void;
        transferDone = new Promise((resolve) => {
          settle = resolve;
        });
        // A consumer that goes away first cuts the transfer off, like the basic-ftp client.
        stream.once("close", () => settle(false));
        const finish = () => {
          if (options.reusableAfterTransfer !== false) idle = true;
          settle(idle);
          stream.push(body);
          stream.push(null);
        };
        if (options.manualStreams) state.pendingStreams.push(Object.assign(stream, { finish }));
        else finish();
        return stream;
      },
      isReusable: () => idle && !closed,
      whenTransferDone: () => transferDone,
      close: async () => {
        if (closed) return;
        closed = true;
        state.openClients.delete(id);
        state.closed.push(id);
      },
    };
  };
  const factory = limitFtpClientFactoryByKey(login, options.maxConnections);
  return Object.assign(state, {
    factory,
    active: () => state.openClients.size,
    failNextOpen: (message: string, beforeFailing?: () => void) => {
      state.nextOpenFailure = { message, beforeFailing };
    },
    finishStream: (index: number) => {
      (state.pendingStreams[index] as Readable & { finish(): void }).finish();
    },
  });
}

function config(overrides: Partial<FtpConfig> = {}): FtpConfig {
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

async function drain(stream: NodeJS.ReadableStream) {
  for await (const _chunk of stream) {
    // Read to the end like a player that finishes its range.
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
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

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for predicate");
}
