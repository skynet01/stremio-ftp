import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FtpClientFactory } from "../src/server/ftp/ftpTypes";
import { limitFtpClientFactory } from "../src/server/ftp/ftpConnectionLimiter";

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
