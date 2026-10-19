import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { resumableReadStream, type StreamResume } from "../src/server/proxy/resumableStream";

const FILE = Buffer.from("0123456789abcdefghij");

// A source that sends `bytes` of the file from `offset`, then fails like a stalled FTP data socket (or ends).
function source(offset: number, bytes: number, outcome: "end" | "fail" | "close" = "end") {
  const stream = new Readable({ read() {} });
  setImmediate(() => {
    if (bytes > 0) stream.push(FILE.subarray(offset, offset + bytes));
    setImmediate(() => {
      if (outcome === "end") stream.push(null);
      else if (outcome === "fail") stream.destroy(new Error("Premature close"));
      else stream.destroy();
    });
  });
  return stream;
}

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe("resumableReadStream", () => {
  it("continues from the exact byte where a stalled transfer stopped", async () => {
    const reopened: number[] = [];
    const resumes: StreamResume[] = [];
    const stream = resumableReadStream({
      first: source(2, 5, "fail"),
      start: 2,
      end: 15,
      reopen: async (offset) => {
        reopened.push(offset);
        return reopened.length === 1 ? source(offset, 4, "close") : source(offset, 15 - offset + 1);
      },
      onResume: (resume) => resumes.push(resume),
    });

    expect(await readAll(stream)).toBe("23456789abcdef");
    expect(reopened).toEqual([7, 11]);
    expect(resumes.map((resume) => resume.error)).toEqual(["Premature close", "FTP stream closed early"]);
  });

  it("gives up after reopens that keep failing without data", async () => {
    let reopens = 0;
    const stream = resumableReadStream({
      first: source(0, 3, "fail"),
      start: 0,
      end: 9,
      reopen: async (offset) => {
        reopens += 1;
        return source(offset, 0, "fail");
      },
    });

    await expect(readAll(stream)).rejects.toThrow("Premature close");
    expect(reopens).toBe(3);
  });

  it("does not retry a refused login", async () => {
    let reopens = 0;
    const stream = resumableReadStream({
      first: source(0, 3, "fail"),
      start: 0,
      end: 9,
      reopen: async () => {
        reopens += 1;
        throw Object.assign(new Error("530 Login incorrect."), { code: 530 });
      },
    });

    await expect(readAll(stream)).rejects.toThrow("530");
    expect(reopens).toBe(1);
  });

  it("retries a reopen that failed to connect", async () => {
    let reopens = 0;
    const stream = resumableReadStream({
      first: source(0, 3, "fail"),
      start: 0,
      end: 9,
      reopen: async (offset) => {
        reopens += 1;
        if (reopens === 1) throw new Error("Timeout (control socket)");
        return source(offset, 10 - offset);
      },
    });

    expect(await readAll(stream)).toBe("0123456789");
    expect(reopens).toBe(2);
  });

  it("ends normally when the failure came after the last byte", async () => {
    let reopens = 0;
    const stream = resumableReadStream({
      first: source(0, 10, "fail"),
      start: 0,
      end: 9,
      reopen: async (offset) => {
        reopens += 1;
        return source(offset, 0);
      },
    });

    expect(await readAll(stream)).toBe("0123456789");
    expect(reopens).toBe(0);
  });

  it("stops the transfer and any pending reopen when the player goes away", async () => {
    let reopenSignal: AbortSignal | undefined;
    let releaseReopen!: () => void;
    const first = source(0, 3, "fail");
    const stream = resumableReadStream({
      first,
      start: 0,
      end: 9,
      reopen: (_offset, signal) => {
        reopenSignal = signal;
        return new Promise((resolve) => {
          releaseReopen = () => resolve(late);
        });
      },
    });
    const late = new Readable({ read() {} });
    stream.on("data", () => undefined);
    stream.on("error", () => undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reopenSignal?.aborted).toBe(false);
    stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(reopenSignal?.aborted).toBe(true);

    releaseReopen();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late.destroyed).toBe(true);
  });

  it("passes the player's backpressure through to the FTP side", async () => {
    const big = new Readable({ read() {} });
    const stream = resumableReadStream({ first: big, start: 0, end: 10 * 1024 * 1024, reopen: async () => big });
    for (let index = 0; index < 64; index += 1) big.push(Buffer.alloc(64 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(big.isPaused()).toBe(true);
    stream.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(big.isPaused()).toBe(false);
    stream.destroy();
  });
});
