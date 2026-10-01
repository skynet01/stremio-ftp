import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createProxyRouter } from "../src/server/proxy/proxyRoutes";

describe("proxy routes", () => {
  it("returns partial content for range requests", async () => {
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 10,
        openReadStream: async ({ start, end }) => Readable.from(Buffer.from("0123456789").subarray(start, end + 1)),
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    const response = await request(app).get("/proxy/token/1").set("Range", "bytes=2-5").expect(206);
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(responseBodyText(response)).toBe("2345");
  });

  it("logs first-byte time and bytes streamed from FTP", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const router = createProxyRouter({
        resolve: async () => ({
          filename: "video.mkv",
          sizeBytes: 10,
          openReadStream: async ({ start, end }) => Readable.from([Buffer.from("0123456789").subarray(start, end + 1)]),
        }),
      });

      const express = (await import("express")).default;
      const app = express().use(router);

      await request(app).get("/proxy/token/1").set("Range", "bytes=2-5").expect(206);
      await waitFor(() => info.mock.calls.some(([label]) => label === "[proxy-timing]"));

      const [, payload] = info.mock.calls.find(([label]) => label === "[proxy-timing]")!;
      const timing = JSON.parse(payload as string);
      expect(timing.bytesFromFtp).toBe(4);
      expect(timing.firstByteMs).toEqual(expect.any(Number));
    } finally {
      info.mockRestore();
    }
  });

  it("logs the FTP error message when a stream fails", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const router = createProxyRouter({
        resolve: async () => ({
          filename: "video.mkv",
          sizeBytes: 10,
          openReadStream: async () =>
            new Readable({
              read() {
                this.destroy(new Error("425 Unable to build data connection"));
              },
            }),
        }),
      });

      const express = (await import("express")).default;
      const app = express().use(router);

      await request(app).get("/proxy/token/1").set("Range", "bytes=0-").catch(() => undefined);
      await waitFor(() => info.mock.calls.some(([label, payload]) => label === "[proxy-timing]" && String(payload).includes("stream_error")));

      const [, payload] = info.mock.calls.find(([label, entry]) => label === "[proxy-timing]" && String(entry).includes("stream_error"))!;
      expect(JSON.parse(payload as string).error).toBe("425 Unable to build data connection");
    } finally {
      info.mockRestore();
    }
  });

  it("logs who was streaming and how long the stream sat idle before the FTP side dropped it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const router = createProxyRouter({
        resolve: async () => ({
          filename: "video.mkv",
          sizeBytes: 10,
          profileId: 6,
          ftpServerId: 723,
          sharedIndexGroupId: 3,
          openReadStream: async () => {
            let sent = false;
            return new Readable({
              read() {
                if (sent) return;
                sent = true;
                this.push(Buffer.from("01234"));
                setTimeout(() => this.destroy(new Error("Premature close")), 60);
              },
            });
          },
        }),
      });

      const express = (await import("express")).default;
      const app = express().use(router);

      await request(app).get("/proxy/token/1").set("Range", "bytes=0-").catch(() => undefined);
      await waitFor(() => info.mock.calls.some(([label, payload]) => label === "[proxy-timing]" && String(payload).includes("stream_error")));

      const [, payload] = info.mock.calls.find(([label, entry]) => label === "[proxy-timing]" && String(entry).includes("stream_error"))!;
      expect(JSON.parse(payload as string)).toMatchObject({
        error: "Premature close",
        profileId: 6,
        serverId: 723,
        sharedIndexGroupId: 3,
        bytesFromFtp: 5,
        msSinceLastData: expect.any(Number),
      });
      expect(JSON.parse(payload as string).msSinceLastData).toBeGreaterThanOrEqual(40);
    } finally {
      info.mockRestore();
    }
  });

  it("ignores range requests when the file size is unknown", async () => {
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: null,
        openReadStream: async () => Readable.from("0123456789"),
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    const response = await request(app).get("/proxy/token/1").set("Range", "bytes=2-5").expect(200);
    expect(response.headers["content-range"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
    expect(responseBodyText(response)).toBe("0123456789");
  });

  it("sets content type from the filename", async () => {
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mp4",
        sizeBytes: 4,
        openReadStream: async () => Readable.from("test"),
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    const response = await request(app).get("/proxy/token/1").expect(200);
    expect(response.headers["content-type"]).toBe("video/mp4");
  });

  it("warms the stream on HEAD without opening playback", async () => {
    const warmReadStream = vi.fn();
    const openReadStream = vi.fn();
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 10,
        warmReadStream,
        openReadStream,
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    await request(app).head("/proxy/token/1").expect(200);

    expect(warmReadStream).toHaveBeenCalledTimes(1);
    expect(openReadStream).not.toHaveBeenCalled();
  });

  it("rejects invalid file ids before calling the resolver", async () => {
    const resolve = vi.fn();
    const router = createProxyRouter({ resolve });

    const express = (await import("express")).default;
    const app = express().use(router);

    for (const fileId of ["1e3", "+1", "-1", "0", "abc"]) {
      await request(app).get(`/proxy/token/${fileId}`).expect(404);
    }

    expect(resolve).not.toHaveBeenCalled();
  });

  it("routes shared proxy ids to the shared resolver input", async () => {
    const resolve = vi.fn(async () => ({
      filename: "video.mkv",
      sizeBytes: 4,
      openReadStream: async () => Readable.from("test"),
    }));
    const router = createProxyRouter({ resolve });

    const express = (await import("express")).default;
    const app = express().use(router);

    const response = await request(app).get("/proxy/token/shared/12/44").expect(200);
    expect(responseBodyText(response)).toBe("test");
    expect(resolve).toHaveBeenCalledWith({ installToken: "token", serverId: 12, sharedMediaId: 44 });
  });

  it("rejects invalid shared proxy ids before calling the resolver", async () => {
    const resolve = vi.fn();
    const router = createProxyRouter({ resolve });

    const express = (await import("express")).default;
    const app = express().use(router);

    for (const path of ["/proxy/token/shared/0/44", "/proxy/token/shared/12/0", "/proxy/token/shared/a/44", "/proxy/token/shared/12/b"]) {
      await request(app).get(path).expect(404);
    }

    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns zero-byte known-size files without opening a stream", async () => {
    const openReadStream = vi.fn();
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "empty.mkv",
        sizeBytes: 0,
        openReadStream,
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    const response = await request(app).get("/proxy/token/1").expect(200);
    expect(response.headers["content-length"]).toBe("0");
    expect(responseBodyText(response)).toBe("");
    expect(openReadStream).not.toHaveBeenCalled();
  });

  it("tells the FTP side which ranges are open-ended", async () => {
    const opened: Array<{ start: number; end: number; openEnded?: boolean }> = [];
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 10,
        openReadStream: async ({ start, end, openEnded }) => {
          opened.push({ start, end, openEnded });
          return Readable.from([Buffer.from("0123456789").subarray(start, end + 1)]);
        },
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    await request(app).get("/proxy/token/1").set("Range", "bytes=2-5").expect(206);
    await request(app).get("/proxy/token/1").set("Range", "bytes=6-").expect(206);
    await request(app).get("/proxy/token/1").set("Range", "bytes=-3").expect(206);
    await request(app).get("/proxy/token/1").expect(200);

    expect(opened).toEqual([
      { start: 2, end: 5, openEnded: false },
      { start: 6, end: 9, openEnded: true },
      { start: 7, end: 9, openEnded: false },
      { start: 0, end: 9, openEnded: true },
    ]);
  });

  it("does not destroy the stream during normal response completion", async () => {
    let destroyCalls = 0;
    const stream = new Readable({
      autoDestroy: false,
      read() {
        setTimeout(() => {
          this.push("0123456789");
          this.push(null);
        }, 10);
      },
      destroy(error, callback) {
        destroyCalls += 1;
        callback(error);
      },
    });

    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 10,
        openReadStream: async () => stream,
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);

    const response = await request(app).get("/proxy/token/1").expect(200);
    expect(responseBodyText(response)).toBe("0123456789");
    expect(destroyCalls).toBe(0);
  });

  it("destroys the stream once when the client aborts", async () => {
    let destroyCalls = 0;
    let sentChunk = false;
    const stream = new Readable({
      autoDestroy: false,
      read() {
        if (!sentChunk) {
          sentChunk = true;
          this.push("0");
        }
      },
      destroy(error, callback) {
        destroyCalls += 1;
        callback(error);
      },
    });

    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 100,
        openReadStream: async () => stream,
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);
    const server = await listenOnLoopback(app);

    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/proxy/token/1" }, (res) => {
          res.once("data", () => req.destroy());
          res.once("close", resolve);
        });
        req.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "ECONNRESET") {
            reject(error);
          }
        });
        req.end();
      });

      await waitFor(() => destroyCalls === 1);
      expect(destroyCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("aborts a pending stream open when the HTTP client disconnects", async () => {
    const openCalled = deferred<void>();
    const streamReady = deferred<Readable>();
    let signal: AbortSignal | undefined;

    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 10,
        openReadStream: async (input) => {
          signal = (input as { signal?: AbortSignal }).signal;
          openCalled.resolve();
          return streamReady.promise;
        },
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);
    const server = await listenOnLoopback(app);

    try {
      const port = (server.address() as AddressInfo).port;
      const req = httpRequest({ host: "127.0.0.1", port, path: "/proxy/token/1" });
      req.once("error", () => undefined);
      req.end();
      await openCalled.promise;

      req.destroy();
      await waitFor(() => signal?.aborted === true);
      expect(signal?.aborted).toBe(true);

      streamReady.resolve(Readable.from(""));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("sends range headers before a slow stream open completes", async () => {
    const streamReady = deferred<Readable>();
    const router = createProxyRouter({
      resolve: async () => ({
        filename: "video.mkv",
        sizeBytes: 10,
        openReadStream: async () => streamReady.promise,
      }),
    });

    const express = (await import("express")).default;
    const app = express().use(router);
    const server = await listenOnLoopback(app);

    try {
      const port = (server.address() as AddressInfo).port;
      const response = await new Promise<{ statusCode: number | undefined; contentRange: string | undefined }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/proxy/token/1", headers: { Range: "bytes=2-5" } }, (res) => {
          resolve({ statusCode: res.statusCode, contentRange: res.headers["content-range"] });
          res.resume();
        });
        req.once("error", reject);
        req.end();
      });

      expect(response).toEqual({ statusCode: 206, contentRange: "bytes 2-5/10" });
      streamReady.resolve(Readable.from("2345"));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

// Listen on 127.0.0.1 (not the `::` wildcard) so the port can't be shared with another
// process's 127.0.0.1 listener; see tests/setup/supertestLoopback.ts.
function listenOnLoopback(app: { listen(port: number, host: string, callback: () => void): Server }) {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for predicate");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function responseBodyText(response: request.Response) {
  return response.text ?? Buffer.from(response.body).toString("utf8");
}
