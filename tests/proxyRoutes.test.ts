import { request as httpRequest } from "node:http";
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
    const server = app.listen(0);

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
    const server = app.listen(0);

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
    const server = app.listen(0);

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

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
