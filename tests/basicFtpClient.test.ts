import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { createBasicFtpClientFactory } from "../src/server/ftp/basicFtpClient";
import type { FtpConfig } from "../src/server/profiles/profileService";

const servers: FakeFtpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("createBasicFtpClientFactory", () => {
  it("does not release a login slot until its control socket closes", async () => {
    const server = await startFakeFtpServer({ files: {} });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    await client.close();

    expect(server.closedControlConnections).toBe(1);
  });

  it("connects to hosts saved as FTP URLs before hosts were normalized", async () => {
    const file = patternedBuffer(1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file } });
    const client = await createBasicFtpClientFactory(5000)({ ...ftpConfig(1), host: `ftp://127.0.0.1:${server.port}/` });

    const received = await readSlowly(await client.openReadStream("/video.mkv", { start: 0, end: 1023 }));

    expect(received.equals(file)).toBe(true);
    await client.close();
  });

  it("delivers every byte of a range to a slow consumer", async () => {
    const file = patternedBuffer(256 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file } });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    const stream = await client.openReadStream("/video.mkv", { start: 1000, end: 200_000 });
    const received = await readSlowly(stream);

    expect(received.length).toBe(199_001);
    expect(received.equals(file.subarray(1000, 200_001))).toBe(true);
  });

  it("keeps a range open while the player is paused longer than the FTP timeout", async () => {
    const file = patternedBuffer(48 * 1024 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file } });
    const client = await createBasicFtpClientFactory(300)(ftpConfig(server.port));

    const stream = await client.openReadStream("/video.mkv", { start: 0, end: file.length - 1 });
    const chunks: Buffer[] = [];
    let failure: unknown = null;
    let settled = false;
    stream.on("error", (error) => {
      failure = error;
    });
    stream.once("close", () => {
      settled = true;
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    await waitFor(() => chunks.length > 0);
    stream.pause();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    stream.resume();
    await waitFor(() => settled);

    expect(String(failure ?? "")).toBe("");
    expect(Buffer.concat(chunks).equals(file)).toBe(true);
  });

  it("delivers every byte to a slow consumer when the range runs to end of file", async () => {
    const file = patternedBuffer(256 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file } });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    const stream = await client.openReadStream("/video.mkv", { start: 0, end: Number.MAX_SAFE_INTEGER });
    const received = await readSlowly(stream);

    expect(received.length).toBe(file.length);
    expect(received.equals(file)).toBe(true);
  });

  it("fails the stream when the server aborts the transfer before the range is complete", async () => {
    const file = patternedBuffer(256 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file }, abortAfterBytes: 64 * 1024 });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    // The abort can reach the client before or after the first byte, so the open or the read fails.
    const read = async () => readSlowly(await client.openReadStream("/video.mkv", { start: 0, end: Number.MAX_SAFE_INTEGER }));

    await expect(read()).rejects.toThrow();
  });

  it("closes the FTP connection when the consumer destroys the stream", async () => {
    const server = await startFakeFtpServer({ files: { "/video.mkv": patternedBuffer(1024 * 1024) } });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    const stream = await client.openReadStream("/video.mkv", { start: 0, end: 1024 * 1024 - 1 });
    await new Promise<void>((resolve) => stream.once("data", () => resolve()));
    (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();

    await waitFor(() => server.closedControlConnections === 1);
  });

  it("rejects the stream open when the transfer fails before the first byte", async () => {
    const server = await startFakeFtpServer({ files: {} });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    await expect(client.openReadStream("/missing.mkv", { start: 0, end: 9 })).rejects.toThrow("550");
  });
});

describe("createBasicFtpClientFactory playback login", () => {
  it("logs in for playback without the directory-listing setup and caches the host features", async () => {
    const server = await startFakeFtpServer({ files: {}, features: ["SIZE", "REST STREAM"] });
    const factory = createBasicFtpClientFactory(5000);

    await (await factory(ftpConfig(server.port), { playback: true })).close();
    await (await factory(ftpConfig(server.port), { playback: true })).close();

    expect(server.sessions).toEqual([
      ["USER user", "PASS ***", "FEAT", "TYPE I"],
      ["USER user", "PASS ***", "TYPE I"],
    ]);
  });

  it("turns UTF-8 on for playback only when the server advertises it", async () => {
    const server = await startFakeFtpServer({ files: {}, features: ["UTF8", "SIZE"] });
    const factory = createBasicFtpClientFactory(5000);

    await (await factory(ftpConfig(server.port), { playback: true })).close();
    await (await factory(ftpConfig(server.port), { playback: true })).close();

    expect(server.sessions).toEqual([
      ["USER user", "PASS ***", "FEAT", "OPTS UTF8 ON", "TYPE I"],
      ["USER user", "PASS ***", "OPTS UTF8 ON", "TYPE I"],
    ]);
  });

  it("reuses the features a full scan login read for later playback logins to the same host", async () => {
    const server = await startFakeFtpServer({ files: {}, features: ["MLST type*;size*;modify*;", "SIZE"] });
    const factory = createBasicFtpClientFactory(5000);

    await (await factory(ftpConfig(server.port))).close();
    await (await factory({ ...ftpConfig(server.port), username: "other" }, { playback: true })).close();

    expect(server.sessions[0]).toEqual(expect.arrayContaining(["FEAT", "STRU F", "OPTS UTF8 ON"]));
    expect(server.sessions[1]).toEqual(["USER other", "PASS ***", "TYPE I"]);
  });

  it("protects the data channel of an explicit TLS playback login without resuming TLS sessions", async () => {
    const file = patternedBuffer(64 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file }, features: ["SIZE"], tls: true });
    const factory = createBasicFtpClientFactory(5000);
    const config: FtpConfig = { ...ftpConfig(server.port), tlsMode: "explicit", allowInvalidCertificate: true };

    const first = await factory(config, { playback: true });
    const received = await readSlowly(await first.openReadStream("/video.mkv", { start: 100, end: 60_000 }));
    await first.close();
    await (await factory(config, { playback: true })).close();

    expect(received.equals(file.subarray(100, 60_001))).toBe(true);
    expect(server.sessions[1]).toEqual(["AUTH TLS", "USER user", "PASS ***", "TYPE I", "PBSZ 0", "PROT P"]);
    expect(server.resumedTlsSessions).toBe(0);
  });
});

describe("createBasicFtpClientFactory byte ranges", () => {
  it("serves a bounded range with RANG and keeps the login for the next transfer", async () => {
    const movie = patternedBuffer(256 * 1024);
    const trailer = patternedBuffer(64 * 1024).reverse();
    const server = await startFakeFtpServer({ files: { "/movie.mkv": movie, "/trailer.mkv": trailer }, features: ["RANG STREAM", "REST STREAM"] });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port), { playback: true });

    const first = await readSlowly(await client.openReadStream("/movie.mkv", { start: 1000, end: 99_999 }));
    expect(await client.whenTransferDone?.()).toBe(true);
    const second = await readSlowly(await client.openReadStream("/trailer.mkv", { start: 0, end: 4095 }));
    expect(await client.whenTransferDone?.()).toBe(true);

    expect(first.equals(movie.subarray(1000, 100_000))).toBe(true);
    expect(second.equals(trailer.subarray(0, 4096))).toBe(true);
    expect(server.connections).toBe(1);
    expect(server.sessions[0].slice(4)).toEqual(["RANG 1000 99999", "EPSV", "RETR /movie.mkv", "RANG 0 4095", "EPSV", "RETR /trailer.mkv"]);
    expect(client.isReusable?.()).toBe(true);
    await client.close();
  });

  it("ends the stream as soon as the range is delivered, before the server confirms the transfer", async () => {
    const file = patternedBuffer(64 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file }, features: ["RANG STREAM"], confirmDelayMs: 400 });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port), { playback: true });

    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    for await (const chunk of await client.openReadStream("/video.mkv", { start: 0, end: 1023 })) chunks.push(chunk as Buffer);
    const streamMs = Date.now() - startedAt;

    expect(Buffer.concat(chunks).equals(file.subarray(0, 1024))).toBe(true);
    // An HTTP response left open after its last byte makes keep-alive players queue their next request behind it.
    expect(streamMs).toBeLessThan(300);
    expect(await client.whenTransferDone?.()).toBe(true);
    expect(client.isReusable?.()).toBe(true);
  });

  it("uses REST for open-ended ranges even when the server supports RANG", async () => {
    const file = patternedBuffer(256 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file }, features: ["RANG STREAM"] });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port), { playback: true });

    const received = await readSlowly(await client.openReadStream("/video.mkv", { start: 5000, end: file.length - 1, openEnded: true }));

    expect(received.equals(file.subarray(5000))).toBe(true);
    expect(server.sessions[0]).not.toContain("RANG 5000 262143");
    expect(server.sessions[0]).toContain("REST 5000");
    expect(await client.whenTransferDone?.()).toBe(true);
  });

  it("falls back to REST when the server rejects RANG and stops asking that host", async () => {
    const file = patternedBuffer(256 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file }, features: ["RANG STREAM"], rang: "reject" });
    const factory = createBasicFtpClientFactory(5000);

    const first = await readSlowly(await (await factory(ftpConfig(server.port), { playback: true })).openReadStream("/video.mkv", { start: 10, end: 20_009 }));
    const second = await readSlowly(await (await factory(ftpConfig(server.port), { playback: true })).openReadStream("/video.mkv", { start: 40, end: 1039 }));

    expect(first.equals(file.subarray(10, 20_010))).toBe(true);
    expect(second.equals(file.subarray(40, 1040))).toBe(true);
    expect(server.sessions[0].slice(4)).toEqual(["RANG 10 20009", "EPSV", "REST 10", "RETR /video.mkv"]);
    expect(server.sessions[1].slice(3)).toEqual(["EPSV", "REST 40", "RETR /video.mkv"]);
  });

  it("drops the login and stops using RANG when the server sends more than the requested range", async () => {
    const file = patternedBuffer(1024 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file }, features: ["RANG STREAM"], rang: "ignore-end" });
    const factory = createBasicFtpClientFactory(5000);
    const client = await factory(ftpConfig(server.port), { playback: true });

    const received = await readSlowly(await client.openReadStream("/video.mkv", { start: 100, end: 4195 }));
    await waitFor(() => server.closedControlConnections === 1);
    const next = await factory(ftpConfig(server.port), { playback: true });
    await readSlowly(await next.openReadStream("/video.mkv", { start: 0, end: 99 }));

    expect(received.equals(file.subarray(100, 4196))).toBe(true);
    expect(await client.whenTransferDone?.()).toBe(false);
    expect(client.isReusable?.()).toBe(false);
    expect(server.sessions[1]).not.toContain("RANG 0 99");
  });

  it("keeps a REST transfer reusable when it reaches end of file cleanly", async () => {
    const file = patternedBuffer(128 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file } });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port), { playback: true });

    const received = await readSlowly(await client.openReadStream("/video.mkv", { start: 1024, end: file.length - 1 }));

    expect(received.equals(file.subarray(1024))).toBe(true);
    expect(await client.whenTransferDone?.()).toBe(true);
    expect(client.isReusable?.()).toBe(true);
    expect(server.closedControlConnections).toBe(0);
  });

  it("closes a REST transfer that stops before end of file", async () => {
    const file = patternedBuffer(1024 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file } });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port), { playback: true });

    const received = await readSlowly(await client.openReadStream("/video.mkv", { start: 0, end: 9999 }));

    expect(received.equals(file.subarray(0, 10_000))).toBe(true);
    expect(await client.whenTransferDone?.()).toBe(false);
    expect(client.isReusable?.()).toBe(false);
    await waitFor(() => server.closedControlConnections === 1);
  });
});

describe("createBasicFtpClientFactory login cleanup", () => {
  it("closes the control connection when the login is rejected", async () => {
    const server = await startFakeFtpServer({ files: {}, login: "reject" });

    await expect(createBasicFtpClientFactory(5000)(ftpConfig(server.port))).rejects.toThrow();

    expect(server.closedControlConnections).toBe(1);
  });

  it("aborts a login in progress and closes the control connection", async () => {
    const server = await startFakeFtpServer({ files: {}, login: "stall" });
    const controller = new AbortController();

    const pending = createBasicFtpClientFactory(5000)(ftpConfig(server.port), { signal: controller.signal });
    await waitFor(() => server.passwordAttempts === 1);
    controller.abort();

    await expect(pending).rejects.toThrow();
    await waitFor(() => server.closedControlConnections === 1);
  });

  it("does not connect when the signal is already aborted", async () => {
    const server = await startFakeFtpServer({ files: {} });

    await expect(createBasicFtpClientFactory(5000)(ftpConfig(server.port), { signal: AbortSignal.abort() })).rejects.toThrow();

    expect(server.connections).toBe(0);
  });
});

type FakeFtpServer = {
  port: number;
  connections: number;
  passwordAttempts: number;
  closedControlConnections: number;
  resumedTlsSessions: number;
  // Commands received, one list per control connection (passwords masked).
  sessions: string[][];
  close(): Promise<void>;
};

// Self-signed certificate for 127.0.0.1/localhost, only used by the fake FTPS server below.
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoV2rm2WPnF8Z6dzd
QI1DTee1Vz+VXOf2T0rX1AgnKTqhRANCAATp0twnsagH+thYwrB6mE4bqiDUgach
VAJO3LNzQe1Tx//gJq/ojta/ZRrcvJs92IuKmxysgfNyUQIZei2xW8+5
-----END PRIVATE KEY-----`;
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUaziHMZE7iCY4rrDfsWLc9MZKIpgwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkyOTE2MjgzNFoYDzIxMjYwOTA1
MTYyODM0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATp0twnsagH+thYwrB6mE4bqiDUgachVAJO3LNzQe1Tx//gJq/ojta/
ZRrcvJs92IuKmxysgfNyUQIZei2xW8+5o28wbTAdBgNVHQ4EFgQUGoLw9gQWMHfq
a9rPzt+iBXm6MN8wHwYDVR0jBBgwFoAUGoLw9gQWMHfqa9rPzt+iBXm6MN8wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgQWt6rFjsIQdmj8mPbmabUwMMqTJFMJTaK+5mUPRYluwCIDvm
wjn9oApIAvOg27+LMP6q1CSf1srVimyjt/z+FuEQ
-----END CERTIFICATE-----`;

async function startFakeFtpServer(options: {
  files: Record<string, Buffer>;
  abortAfterBytes?: number;
  login?: "accept" | "reject" | "stall";
  // FEAT lines; without them the server answers FEAT with 500 like a server that lacks the command.
  features?: string[];
  // How RANG is handled: honored, refused with 500, or accepted but ignored (the whole rest of the file is sent).
  rang?: "honor" | "reject" | "ignore-end";
  // Accept AUTH TLS and protect data connections after PROT P.
  tls?: boolean;
  // Hold back the 226 after a transfer's data, like a slow control connection.
  confirmDelayMs?: number;
}): Promise<FakeFtpServer> {
  const sockets = new Set<Socket>();
  const passiveServers = new Set<Server>();
  const secureContext = options.tls ? createSecureContext({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }) : null;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  };

  const fake: FakeFtpServer = {
    port: 0,
    connections: 0,
    passwordAttempts: 0,
    closedControlConnections: 0,
    resumedTlsSessions: 0,
    sessions: [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const passive of passiveServers) passive.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = createServer((rawControl) => {
    fake.connections += 1;
    const commands: string[] = [];
    fake.sessions.push(commands);
    track(rawControl);
    rawControl.once("close", () => {
      fake.closedControlConnections += 1;
    });
    let control: Socket = rawControl;
    const reply = (line: string) => {
      if (!control.destroyed) control.write(`${line}\r\n`);
    };

    let restOffset = 0;
    let range: { start: number; end: number } | null = null;
    let protectData = false;
    let resumedTls = false;
    let dataSocket: Promise<Socket> | null = null;
    let pending = "";
    const onData = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let index = pending.indexOf("\r\n");
      while (index >= 0) {
        handle(pending.slice(0, index));
        pending = pending.slice(index + 2);
        index = pending.indexOf("\r\n");
      }
    };
    control.on("data", onData);

    const handle = (line: string) => {
      const [command = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      // QUIT is left out: the client sends it while closing and may tear the socket down before it arrives.
      if (command.toUpperCase() !== "QUIT") commands.push(command.toUpperCase() === "PASS" ? "PASS ***" : line);
      switch (command.toUpperCase()) {
        case "AUTH": {
          if (!secureContext) {
            reply("500 AUTH not understood");
            return;
          }
          reply("234 AUTH TLS successful");
          rawControl.off("data", onData);
          const secure = new TLSSocket(rawControl, { isServer: true, secureContext });
          secure.on("error", () => undefined);
          secure.once("secure", () => {
            if (!secure.isSessionReused()) return;
            fake.resumedTlsSessions += 1;
            resumedTls = true;
          });
          secure.on("data", onData);
          control = secure;
          return;
        }
        case "USER":
          reply("331 Password required");
          return;
        case "PASS":
          fake.passwordAttempts += 1;
          if (options.login === "stall") return;
          reply(options.login === "reject" ? "530 Login incorrect" : "230 Logged in");
          return;
        case "FEAT":
          if (!options.features) {
            reply("500 FEAT not understood");
            return;
          }
          control.write(`211-Features:\r\n${options.features.map((feature) => ` ${feature}\r\n`).join("")}211 End\r\n`);
          return;
        case "TYPE":
          reply("200 Type set");
          return;
        case "STRU":
          reply("200 Structure set");
          return;
        case "OPTS":
          reply("200 OK");
          return;
        case "PBSZ":
          reply("200 PBSZ 0 successful");
          return;
        case "PROT":
          protectData = arg.toUpperCase() === "P";
          reply("200 Protection set");
          return;
        case "EPSV": {
          const passive = createServer();
          passiveServers.add(passive);
          dataSocket = new Promise<Socket>((resolve) => {
            passive.once("connection", (socket) => {
              track(socket);
              passive.close();
              if (!protectData || !secureContext) {
                resolve(socket);
                return;
              }
              const secure = new TLSSocket(socket, { isServer: true, secureContext });
              secure.on("error", () => undefined);
              secure.once("secure", () => resolve(secure));
            });
          });
          passive.listen(0, "127.0.0.1", () => {
            reply(`229 Entering Extended Passive Mode (|||${(passive.address() as AddressInfo).port}|)`);
          });
          return;
        }
        case "REST":
          restOffset = Number(arg);
          reply("350 Restarting");
          return;
        case "RANG": {
          if (options.rang === "reject") {
            reply("500 RANG not understood");
            return;
          }
          const [start, end] = arg.split(" ").map(Number);
          range = { start, end };
          reply(`350 Transferring byte range of ${end - start + 1} bytes starting from ${start}`);
          return;
        }
        case "RETR": {
          const file = options.files[arg];
          const transferSocket = dataSocket;
          dataSocket = null;
          if (!file || !transferSocket) {
            reply("550 Not found");
            return;
          }
          const start = range ? range.start : restOffset;
          const end = range && options.rang !== "ignore-end" ? range.end + 1 : file.length;
          range = null;
          restOffset = 0;
          reply("150 Opening data connection");
          void transferSocket.then((socket) => {
            if (options.abortAfterBytes !== undefined) {
              socket.end(file.subarray(start, start + options.abortAfterBytes), () => reply("426 Transfer aborted"));
              return;
            }
            socket.end(file.subarray(start, end), () => setTimeout(() => reply("226 Transfer complete"), options.confirmDelayMs ?? 0));
          });
          return;
        }
        case "QUIT":
          reply("221 Bye");
          control.end();
          return;
        default:
          reply("500 Unknown command");
      }
    };

    reply("220 Fake FTP ready");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.port = (server.address() as AddressInfo).port;
  servers.push(fake);
  return fake;
}

async function readSlowly(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Buffer.concat(chunks);
}

function patternedBuffer(size: number) {
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 31 + (index >> 8)) & 0xff;
  return buffer;
}

function ftpConfig(port: number): FtpConfig {
  return {
    host: "127.0.0.1",
    port,
    username: "user",
    password: "secret",
    tlsMode: "none",
    allowInvalidCertificate: false,
    roots: ["/"],
  };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate");
}
