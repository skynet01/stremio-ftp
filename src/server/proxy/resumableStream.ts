import { PassThrough } from "node:stream";

// An FTP download can stall or drop partway (the data socket times out after FTP_TIMEOUT_MS without bytes, or the
// server closes it). Ending the HTTP response there stops playback until the player notices and asks again, and
// players often do not. Instead the response stays open and the rest of the range is fetched with a new transfer
// from the exact byte where the old one stopped, so the player only sees a slow patch.

// Give up after this many reopens in a row that produced no data; the account or server is really unavailable.
const MAX_FAILED_RESUMES_IN_A_ROW = 3;

export type StreamResume = {
  attempt: number;
  offset: number;
  bytesDelivered: number;
  error: string;
};

export type ResumableStreamOptions = {
  first: NodeJS.ReadableStream;
  start: number;
  // Inclusive last byte of the range.
  end: number;
  reopen(offset: number, signal: AbortSignal): Promise<NodeJS.ReadableStream>;
  onResume?(resume: StreamResume): void;
  onResumed?(resume: StreamResume & { resumeMs: number }): void;
};

export function resumableReadStream(options: ResumableStreamOptions): PassThrough {
  const output = new PassThrough();
  const total = options.end - options.start + 1;
  const controller = new AbortController();
  let delivered = 0;
  let attempts = 0;
  let failedInARow = 0;
  let current: NodeJS.ReadableStream | null = null;
  let stopped = false;

  output.once("close", () => {
    stopped = true;
    controller.abort();
    if (current) destroyStream(current);
  });

  const attach = (segment: NodeJS.ReadableStream) => {
    current = segment;
    let settled = false;
    let gotData = false;
    const onData = (chunk: Buffer | string) => {
      const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      delivered += length;
      if (!gotData) {
        gotData = true;
        failedInARow = 0;
      }
      if (!output.write(chunk)) {
        segment.pause();
        output.once("drain", () => segment.resume());
      }
    };
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      segment.off("data", onData);
      if (current === segment) current = null;
      if (stopped) return;
      if (!error || delivered >= total) {
        output.end();
        return;
      }
      if (!gotData) failedInARow += 1;
      void resume(error);
    };
    segment.on("data", onData);
    segment.once("end", () => finish(null));
    segment.once("error", (error: Error) => finish(error));
    // A source destroyed without an error or an end still stopped short.
    segment.once("close", () => finish(new Error("FTP stream closed early")));
  };

  const resume = async (cause: Error) => {
    if (failedInARow >= MAX_FAILED_RESUMES_IN_A_ROW) {
      output.destroy(cause);
      return;
    }
    attempts += 1;
    const info: StreamResume = { attempt: attempts, offset: options.start + delivered, bytesDelivered: delivered, error: cause.message };
    options.onResume?.(info);
    const startedAt = Date.now();
    let segment: NodeJS.ReadableStream;
    try {
      segment = await options.reopen(info.offset, controller.signal);
    } catch (error) {
      if (stopped) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      // A refused login will not get better on another try.
      if (failure.name === "FtpLoginRefusedError" || isRefusedLogin(failure)) {
        output.destroy(failure);
        return;
      }
      failedInARow += 1;
      void resume(failure);
      return;
    }
    if (stopped) {
      destroyStream(segment);
      return;
    }
    options.onResumed?.({ ...info, resumeMs: Date.now() - startedAt });
    attach(segment);
  };

  attach(options.first);
  return output;
}

function destroyStream(stream: NodeJS.ReadableStream) {
  if ("destroy" in stream && typeof stream.destroy === "function") stream.destroy();
}

function isRefusedLogin(error: Error) {
  return (error as { code?: unknown }).code === 530;
}
