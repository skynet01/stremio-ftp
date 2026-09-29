import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
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

  it("delivers every byte of a range to a slow consumer", async () => {
    const file = patternedBuffer(256 * 1024);
    const server = await startFakeFtpServer({ files: { "/video.mkv": file } });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    const stream = await client.openReadStream("/video.mkv", { start: 1000, end: 200_000 });
    const received = await readSlowly(stream);

    expect(received.length).toBe(199_001);
    expect(received.equals(file.subarray(1000, 200_001))).toBe(true);
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

    const stream = await client.openReadStream("/video.mkv", { start: 0, end: Number.MAX_SAFE_INTEGER });

    await expect(readSlowly(stream)).rejects.toThrow();
  });

  it("closes the FTP connection when the consumer destroys the stream", async () => {
    const server = await startFakeFtpServer({ files: { "/video.mkv": patternedBuffer(1024 * 1024) } });
    const client = await createBasicFtpClientFactory(5000)(ftpConfig(server.port));

    const stream = await client.openReadStream("/video.mkv", { start: 0, end: 1024 * 1024 - 1 });
    await new Promise<void>((resolve) => stream.once("data", () => resolve()));
    (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();

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
  close(): Promise<void>;
};

async function startFakeFtpServer(options: {
  files: Record<string, Buffer>;
  abortAfterBytes?: number;
  login?: "accept" | "reject" | "stall";
}): Promise<FakeFtpServer> {
  const sockets = new Set<Socket>();
  const passiveServers = new Set<Server>();
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
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const passive of passiveServers) passive.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = createServer((control) => {
    fake.connections += 1;
    track(control);
    control.once("close", () => {
      fake.closedControlConnections += 1;
    });
    control.setEncoding("utf8");
    const reply = (line: string) => {
      if (!control.destroyed) control.write(`${line}\r\n`);
    };

    let restOffset = 0;
    let dataSocket: Promise<Socket> | null = null;
    let pending = "";
    control.on("data", (chunk: string) => {
      pending += chunk;
      let index = pending.indexOf("\r\n");
      while (index >= 0) {
        handle(pending.slice(0, index));
        pending = pending.slice(index + 2);
        index = pending.indexOf("\r\n");
      }
    });

    const handle = (line: string) => {
      const [command = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (command.toUpperCase()) {
        case "USER":
          reply("331 Password required");
          return;
        case "PASS":
          fake.passwordAttempts += 1;
          if (options.login === "stall") return;
          reply(options.login === "reject" ? "530 Login incorrect" : "230 Logged in");
          return;
        case "TYPE":
          reply("200 Type set");
          return;
        case "EPSV": {
          const passive = createServer();
          passiveServers.add(passive);
          dataSocket = new Promise<Socket>((resolve) => {
            passive.once("connection", (socket) => {
              track(socket);
              passive.close();
              resolve(socket);
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
        case "RETR": {
          const file = options.files[arg];
          if (!file || !dataSocket) {
            reply("550 Not found");
            return;
          }
          reply("150 Opening data connection");
          void dataSocket.then((socket) => {
            if (options.abortAfterBytes !== undefined) {
              socket.end(file.subarray(restOffset, restOffset + options.abortAfterBytes), () => reply("426 Transfer aborted"));
              return;
            }
            socket.end(file.subarray(restOffset), () => reply("226 Transfer complete"));
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
