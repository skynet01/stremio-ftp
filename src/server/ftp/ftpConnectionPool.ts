import { performance } from "node:perf_hooks";
import { splitFtpHost } from "../../shared/ftpHost.js";
import type { FtpConfig } from "../profiles/profileService.js";
import { isFtpSlotUnavailableError, type AbortableFtpClientFactory, type ClaimableFtpClient } from "./ftpConnectionLimiter.js";
import type { FtpReadStreamOptions } from "./ftpTypes.js";

// Playback connections, kept per login account (host, port, username, password and TLS settings). A login whose
// transfer completed cleanly waits idle for the next request on that account instead of logging out. Idle and
// warming logins still hold limiter slots, but give them up as soon as a real request would have to wait.
// The factory is the connection limiter (limitFtpClientFactoryByKey): it closes each client after its stream unless the
// transfer completed cleanly, in which case it hands the client back here through onReusable.

const MAX_REMEMBERED_LOGIN_FAILURES = 1_000;
// A login the server dropped while it sat idle fails on its first command within a round trip or two. A slower
// failure is a real stall; trying another login after it would only double how long the player waits.
const QUICK_FAILURE_MS = 3_000;
// ProFTPD and others also answer 530 when an account is over its session limit; that is not a bad password.
const SESSION_LIMIT_REPLY = /too many|maximum|limit|already connected/i;

export type FtpConnectionPoolOptions = {
  // How long a logged-in client may wait for its next transfer. 0 turns pooling and warm-ups off.
  idleMs: number;
  // How long a login refused with 530 makes further playback logins and warm-ups for that account fail without
  // contacting the server. 0 turns it off.
  loginFailureMs: number;
};

// Where a stream's login came from: a new login, an idle pooled one, a warm-up, or one handed over by a transfer that
// finished while this request waited for a slot.
export type FtpClientSource = "new" | "idle" | "warm" | "handoff";

export type PooledReadStream = {
  stream: NodeJS.ReadableStream;
  source: FtpClientSource;
  clientReadyMs: number;
  streamOpenMs: number;
  // A reused login failed before the first byte, so the stream came from a fresh login instead.
  retriedFresh: boolean;
};

export type FtpReadRange = Pick<FtpReadStreamOptions, "start" | "end" | "openEnded">;

export type FtpConnectionPool = {
  openReadStream(config: FtpConfig, path: string, range: FtpReadRange, signal?: AbortSignal): Promise<PooledReadStream>;
  // Logs in ahead of a likely request unless the account already has an idle or warming login.
  warm(config: FtpConfig): void;
  // Warms the first `maxAccounts` distinct accounts among `configs`.
  prewarm(configs: FtpConfig[], maxAccounts: number): void;
  close(): Promise<void>;
};

type IdleClient = { client: ClaimableFtpClient; timer: NodeJS.Timeout | null };

// A background login; a request that finds it claims it and waits for it instead of logging in itself.
type WarmLogin = { promise: Promise<ClaimableFtpClient>; controller: AbortController; claimed: boolean };

// A request waiting in the limiter queue for a new login; a login that becomes idle first is handed to it instead.
type LoginWaiter = { accepts(): boolean; deliver(client: ClaimableFtpClient): void };

type Account = {
  idle: IdleClient[];
  warming: WarmLogin | null;
  waiters: Set<LoginWaiter>;
};

export function ftpAccountKey(config: FtpConfig) {
  const target = splitFtpHost(config.host);
  return [
    target.host.toLowerCase(),
    target.port ?? config.port,
    config.username,
    config.password,
    config.tlsMode,
    config.allowInvalidCertificate ? "any-certificate" : "verified",
  ].join("\0");
}

export function createFtpConnectionPool(factory: AbortableFtpClientFactory, options: FtpConnectionPoolOptions): FtpConnectionPool {
  const pooling = options.idleMs > 0;
  const accounts = new Map<string, Account>();
  // Players of a dead account retry over and over; a burst of failed logins from one IP can upset the provider.
  const loginFailures = new Map<string, { until: number; message: string }>();
  let stopped = false;

  function accountFor(key: string) {
    let account = accounts.get(key);
    if (!account) {
      account = { idle: [], warming: null, waiters: new Set() };
      accounts.set(key, account);
    }
    return account;
  }

  function forgetIfUnused(key: string) {
    const account = accounts.get(key);
    if (account && !account.idle.length && !account.warming && !account.waiters.size) accounts.delete(key);
  }

  function takeIdle(key: string) {
    const account = accounts.get(key);
    // Oldest first: rotating through the idle logins keeps all of them fresh instead of letting spares expire.
    while (account?.idle.length) {
      const entry = account.idle.shift()!;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.client.isReusable?.() !== false && entry.client.claim?.() !== false) return entry.client;
      void entry.client.close().catch(() => undefined);
    }
    return null;
  }

  function takeWarm(key: string) {
    const account = accounts.get(key);
    const warm = account?.warming ?? null;
    if (!account || !warm) return null;
    account.warming = null;
    warm.claimed = true;
    return warm;
  }

  function dropIdle(key: string, entry: IdleClient) {
    const account = accounts.get(key);
    const index = account?.idle.indexOf(entry) ?? -1;
    if (index >= 0) account!.idle.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    forgetIfUnused(key);
  }

  // A login whose transfer completed cleanly (or a finished warm-up): hand it to a waiting request, or keep it idle.
  function returnClient(key: string, client: ClaimableFtpClient) {
    if (stopped || !pooling || client.isReusable?.() === false) {
      void client.close().catch(() => undefined);
      return;
    }
    const account = accountFor(key);
    const waiter = [...account.waiters].find((candidate) => candidate.accepts());
    if (waiter) {
      if (client.claim?.() !== false) waiter.deliver(client);
      return;
    }
    const entry: IdleClient = { client, timer: null };
    if (client.park && !client.park(() => dropIdle(key, entry))) {
      forgetIfUnused(key);
      return;
    }
    entry.timer = setTimeout(() => {
      dropIdle(key, entry);
      void client.close().catch(() => undefined);
    }, options.idleMs);
    entry.timer.unref?.();
    account.idle.push(entry);
  }

  function rememberLoginFailure(key: string, error: unknown) {
    if (options.loginFailureMs <= 0 || !isRefusedLogin(error)) return;
    loginFailures.delete(key);
    loginFailures.set(key, { until: Date.now() + options.loginFailureMs, message: (error as Error).message.slice(0, 200) });
    if (loginFailures.size > MAX_REMEMBERED_LOGIN_FAILURES) loginFailures.delete(loginFailures.keys().next().value!);
  }

  function recentLoginFailure(key: string) {
    const failure = loginFailures.get(key);
    if (!failure) return null;
    if (failure.until <= Date.now()) {
      loginFailures.delete(key);
      return null;
    }
    const error = new Error(`${failure.message} (refused within the last ${Math.round(options.loginFailureMs / 1000)} s; not retried yet)`);
    error.name = "FtpLoginRefusedError";
    return error;
  }

  function warm(config: FtpConfig) {
    if (!pooling || stopped) return;
    const key = ftpAccountKey(config);
    if (recentLoginFailure(key)) return;
    const account = accountFor(key);
    if (account.idle.length || account.warming) return;

    const startedAt = performance.now();
    const controller = new AbortController();
    const warmLogin: WarmLogin = {
      promise: factory(config, { background: true, signal: controller.signal, playback: true }),
      controller,
      claimed: false,
    };
    account.warming = warmLogin;
    const clearWarming = () => {
      const current = accounts.get(key);
      if (current?.warming === warmLogin) current.warming = null;
    };
    warmLogin.promise.then(
      (client) => {
        logFtpTiming("warm_ready", { warmMs: elapsedMs(startedAt), ...target(config) });
        if (warmLogin.claimed) return;
        // Nobody claimed it while it logged in, so it waits in the pool like any other idle login.
        clearWarming();
        returnClient(key, client);
      },
      (error: unknown) => {
        clearWarming();
        rememberLoginFailure(key, error);
        const event = isFtpSlotUnavailableError(error) ? "warm_skipped" : error instanceof Error && error.name === "AbortError" ? "warm_cancelled" : "warm_failed";
        logFtpTiming(event, { warmMs: elapsedMs(startedAt), ...target(config) });
        forgetIfUnused(key);
      },
    );
  }

  // Hot spare: once a request uses an account's last idle login, log another one in the background (if the account
  // has a free slot) so the next seek does not wait for a login.
  function replenish(config: FtpConfig) {
    warm(config);
  }

  function loginForRequest(config: FtpConfig, key: string, signal: AbortSignal | undefined) {
    const failure = recentLoginFailure(key);
    if (failure) {
      logFtpTiming("login_refused_recently", target(config));
      return Promise.reject(failure);
    }
    return new Promise<{ client: ClaimableFtpClient; source: FtpClientSource }>((resolve, reject) => {
      const handoff = new AbortController();
      let settled = false;
      let loggingIn = false;
      const waiter: LoginWaiter = {
        accepts: () => !settled && !loggingIn && !signal?.aborted,
        deliver: (client) => {
          settled = true;
          accounts.get(key)?.waiters.delete(waiter);
          handoff.abort();
          resolve({ client, source: "handoff" });
        },
      };
      if (pooling) accountFor(key).waiters.add(waiter);
      const stopWaiting = () => {
        accounts.get(key)?.waiters.delete(waiter);
        forgetIfUnused(key);
      };
      factory(config, {
        signal: signal ? AbortSignal.any([signal, handoff.signal]) : handoff.signal,
        playback: true,
        onLoginStart: () => {
          loggingIn = true;
        },
      }).then(
        (client) => {
          stopWaiting();
          if (settled) {
            returnClient(key, client);
            return;
          }
          settled = true;
          resolve({ client, source: "new" });
          replenish(config);
        },
        (error: unknown) => {
          stopWaiting();
          rememberLoginFailure(key, error);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  }

  async function acquire(config: FtpConfig, key: string, signal: AbortSignal | undefined) {
    const idle = takeIdle(key);
    if (idle) {
      replenish(config);
      return { client: idle, source: "idle" as const };
    }
    const warmLogin = takeWarm(key);
    if (warmLogin) {
      replenish(config);
      const waitStartedAt = performance.now();
      const client = await awaitWarmLogin(warmLogin, signal).catch((error: unknown) => {
        if (signal?.aborted) throw abortError();
        if (!isFtpSlotUnavailableError(error) && elapsedMs(waitStartedAt) > QUICK_FAILURE_MS) throw error;
        return null;
      });
      if (client && client.claim?.() !== false) return { client, source: "warm" as const };
      // The warm-up gave its slot away or failed quickly; log in for this request instead.
    }
    return loginForRequest(config, key, signal);
  }

  async function openOn(client: ClaimableFtpClient, key: string, path: string, range: FtpReadRange, signal: AbortSignal | undefined) {
    let closeRequested = false;
    const closeClient = () => {
      closeRequested = true;
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", closeClient, { once: true });
    try {
      if (signal?.aborted) throw abortError();
      const stream = await client.openReadStream(path, { ...range, onReusable: () => returnClient(key, client) });
      signal?.removeEventListener("abort", closeClient);
      if (signal?.aborted) {
        destroyStream(stream);
        if (!closeRequested) await client.close();
        throw abortError();
      }
      return stream;
    } catch (error) {
      signal?.removeEventListener("abort", closeClient);
      if (!closeRequested) await client.close().catch(() => undefined);
      throw signal?.aborted ? abortError() : error;
    }
  }

  return {
    async openReadStream(config, path, range, signal) {
      if (signal?.aborted) throw abortError();
      const key = ftpAccountKey(config);
      const startedAt = performance.now();
      const acquired = await acquire(config, key, signal);
      const clientReadyMs = elapsedMs(startedAt);
      const streamStartedAt = performance.now();
      try {
        const stream = await openOn(acquired.client, key, path, range, signal);
        return { stream, source: acquired.source, clientReadyMs, streamOpenMs: elapsedMs(streamStartedAt), retriedFresh: false };
      } catch (error) {
        if (signal?.aborted || acquired.source === "new" || elapsedMs(streamStartedAt) > QUICK_FAILURE_MS) throw error;
        // An idle login can have been dropped by the server; that costs one fresh login, not the request.
        logFtpTiming("reused_login_failed", { source: acquired.source, ...target(config) });
      }
      const retryStartedAt = performance.now();
      const fresh = await loginForRequest(config, key, signal);
      const retryReadyMs = elapsedMs(retryStartedAt);
      const retryStreamStartedAt = performance.now();
      const stream = await openOn(fresh.client, key, path, range, signal);
      return {
        stream,
        source: fresh.source,
        clientReadyMs: clientReadyMs + retryReadyMs,
        streamOpenMs: elapsedMs(retryStreamStartedAt),
        retriedFresh: true,
      };
    },
    warm,
    prewarm(configs, maxAccounts) {
      const seen = new Set<string>();
      for (const config of configs) {
        if (seen.size >= maxAccounts) break;
        const key = ftpAccountKey(config);
        if (seen.has(key)) continue;
        seen.add(key);
        warm(config);
      }
    },
    async close() {
      stopped = true;
      const closing: Array<Promise<void>> = [];
      for (const account of accounts.values()) {
        account.warming?.controller.abort();
        account.warming = null;
        for (const entry of account.idle.splice(0)) {
          if (entry.timer) clearTimeout(entry.timer);
          closing.push(entry.client.close().catch(() => undefined));
        }
      }
      accounts.clear();
      await Promise.all(closing);
    },
  };
}

function awaitWarmLogin(warmLogin: WarmLogin, signal: AbortSignal | undefined): Promise<ClaimableFtpClient> {
  if (!signal) return warmLogin.promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      warmLogin.controller.abort();
      reject(abortError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void warmLogin.promise.then(
      (client) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          void client.close().catch(() => undefined);
          reject(abortError());
        } else resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// A 530 reply to the login means bad credentials or a disabled account, unless it is about a session limit.
function isRefusedLogin(error: unknown) {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== 530) return false;
  return !SESSION_LIMIT_REPLY.test(error.message);
}

function target(config: FtpConfig) {
  return { host: config.host, port: config.port, tlsMode: config.tlsMode };
}

function abortError() {
  const error = new Error("Proxy request aborted");
  error.name = "AbortError";
  return error;
}

function destroyStream(stream: NodeJS.ReadableStream) {
  if ("destroy" in stream && typeof stream.destroy === "function") {
    stream.destroy();
  }
}

export function logFtpTiming(event: string, payload: Record<string, unknown>) {
  console.info("[proxy-ftp-timing]", JSON.stringify({ event, ...payload }));
}

function elapsedMs(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}
