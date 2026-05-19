import { performance } from "node:perf_hooks";
import type { Request, Response } from "express";
import { Router } from "express";
import { lookup } from "mime-types";
import { parseRangeHeader } from "./range.js";

type ProxyFile = {
  filename: string;
  sizeBytes: number | null;
  warmReadStream?: () => void;
  openReadStream(input: { start: number; end: number; signal?: AbortSignal }): Promise<NodeJS.ReadableStream>;
};

type ProxyDeps = {
  resolve(input: { installToken: string; fileId: number } | { installToken: string; serverId: number; sharedMediaId: number }): Promise<ProxyFile | null>;
};

type ProxyTiming = {
  startedAt: number;
  routeKind: "profile" | "shared";
  method: string;
  headOnly: boolean;
  resolveMs?: number;
  headersMs?: number;
  openMs?: number;
  firstByteMs?: number;
  status?: number;
  range?: string;
  sizeBytes?: number | null;
  contentLength?: number | null;
  bytesFromFtp: number;
  logged: boolean;
};

export function createProxyRouter(deps: ProxyDeps) {
  const router = Router();

  router.head("/proxy/:installToken/:fileId", (req, res, next) => {
    void handleProxyRequest(deps, req, res, true).catch(next);
  });

  router.head("/proxy/:installToken/shared/:serverId/:sharedMediaId", (req, res, next) => {
    void handleSharedProxyRequest(deps, req, res, true).catch(next);
  });

  router.get("/proxy/:installToken/:fileId", (req, res, next) => {
    void handleProxyRequest(deps, req, res, false).catch(next);
  });

  router.get("/proxy/:installToken/shared/:serverId/:sharedMediaId", (req, res, next) => {
    void handleSharedProxyRequest(deps, req, res, false).catch(next);
  });

  return router;
}

async function handleSharedProxyRequest(deps: ProxyDeps, req: Request, res: Response, headOnly: boolean) {
  const timing = startProxyTiming(req, "shared", headOnly);
  const installToken = req.params.installToken;
  const serverIdParam = req.params.serverId;
  const sharedMediaIdParam = req.params.sharedMediaId;
  if (typeof installToken !== "string" || typeof serverIdParam !== "string" || typeof sharedMediaIdParam !== "string") {
    res.sendStatus(404);
    return;
  }

  if (!/^[1-9]\d*$/.test(serverIdParam) || !/^[1-9]\d*$/.test(sharedMediaIdParam)) {
    res.sendStatus(404);
    return;
  }

  const resolveStartedAt = performance.now();
  const file = await deps.resolve({
    installToken,
    serverId: Number(serverIdParam),
    sharedMediaId: Number(sharedMediaIdParam),
  });
  timing.resolveMs = elapsedMs(resolveStartedAt);
  if (!file) {
    res.sendStatus(404);
    logProxyTiming(timing, "not_found");
    return;
  }
  await streamProxyFile(file, req, res, headOnly, timing);
}

async function handleProxyRequest(deps: ProxyDeps, req: Request, res: Response, headOnly: boolean) {
  const timing = startProxyTiming(req, "profile", headOnly);
  const installToken = req.params.installToken;
  const fileIdParam = req.params.fileId;
  if (typeof installToken !== "string" || typeof fileIdParam !== "string") {
    res.sendStatus(404);
    return;
  }

  if (!/^[1-9]\d*$/.test(fileIdParam)) {
    res.sendStatus(404);
    return;
  }
  const fileId = Number(fileIdParam);

  const resolveStartedAt = performance.now();
  const file = await deps.resolve({ installToken, fileId });
  timing.resolveMs = elapsedMs(resolveStartedAt);
  if (!file) {
    res.sendStatus(404);
    logProxyTiming(timing, "not_found");
    return;
  }

  await streamProxyFile(file, req, res, headOnly, timing);
}

async function streamProxyFile(file: ProxyFile, req: Request, res: Response, headOnly: boolean, timing: ProxyTiming) {
  const rangeHeader = req.header("range");
  const range = parseRangeHeader(rangeHeader, file.sizeBytes);
  timing.range = rangeHeader ?? undefined;
  timing.sizeBytes = file.sizeBytes;
  if (rangeHeader && file.sizeBytes !== null && !range) {
    if (file.sizeBytes !== null) {
      res.setHeader("Content-Range", `bytes */${file.sizeBytes}`);
      res.setHeader("Accept-Ranges", "bytes");
    }
    res.sendStatus(416);
    timing.status = 416;
    logProxyTiming(timing, "invalid_range");
    return;
  }

  const status = range && file.sizeBytes !== null ? 206 : 200;
  const start = range?.start ?? 0;
  const end = range?.end ?? (file.sizeBytes === null ? Number.MAX_SAFE_INTEGER : file.sizeBytes - 1);
  const contentLength = status === 206 ? range?.size ?? null : file.sizeBytes;
  timing.status = status;
  timing.contentLength = contentLength;

  res.status(status);
  res.setHeader("Content-Type", lookup(file.filename) || "application/octet-stream");
  if (file.sizeBytes !== null) {
    res.setHeader("Accept-Ranges", "bytes");
  }
  if (status === 206 && range && file.sizeBytes !== null) {
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
  }
  if (contentLength !== null) {
    res.setHeader("Content-Length", String(contentLength));
  }

  if (headOnly) {
    file.warmReadStream?.();
    res.end();
    logProxyTiming(timing, "head");
    return;
  }

  if (file.sizeBytes === 0) {
    res.end();
    logProxyTiming(timing, "empty_file");
    return;
  }

  res.flushHeaders();
  timing.headersMs = elapsedMs(timing.startedAt);

  const openController = new AbortController();
  let streamOpened = false;
  const abortPendingOpen = () => {
    if (!streamOpened) openController.abort();
  };
  res.once("close", abortPendingOpen);

  let stream: NodeJS.ReadableStream;
  try {
    const openStartedAt = performance.now();
    stream = await file.openReadStream({ start, end, signal: openController.signal });
    timing.openMs = elapsedMs(openStartedAt);
  } catch (error) {
    res.off("close", abortPendingOpen);
    if (openController.signal.aborted) {
      logProxyTiming(timing, "client_closed_before_open");
      return;
    }
    logProxyTiming(timing, "open_failed");
    throw error;
  }
  streamOpened = true;
  res.off("close", abortPendingOpen);
  if (openController.signal.aborted || res.destroyed) {
    destroyStream(stream);
    logProxyTiming(timing, "client_closed_after_open");
    return;
  }

  let streamFinished = false;
  let streamDestroyed = false;
  const cleanup = () => {
    if (streamFinished || streamDestroyed) return;
    streamDestroyed = true;
    destroyStream(stream);
  };
  const markFinished = () => {
    streamFinished = true;
    res.off("close", cleanup);
  };

  res.once("finish", () => logProxyTiming(timing, "finish"));
  res.once("close", () => {
    cleanup();
    logProxyTiming(timing, streamFinished ? "close" : "client_closed");
  });
  stream.on("data", (chunk: Buffer | string) => {
    timing.firstByteMs ??= elapsedMs(timing.startedAt);
    timing.bytesFromFtp += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
  });
  stream.once("end", markFinished);
  stream.on("error", (error) => {
    markFinished();
    logProxyTiming(timing, "stream_error");
    if (!res.headersSent) {
      res.sendStatus(500);
      return;
    }
    res.destroy(error instanceof Error ? error : undefined);
  });
  stream.pipe(res);
}

function destroyStream(stream: NodeJS.ReadableStream) {
  if ("destroy" in stream && typeof stream.destroy === "function") {
    stream.destroy();
  }
}

function startProxyTiming(req: Request, routeKind: ProxyTiming["routeKind"], headOnly: boolean): ProxyTiming {
  return {
    startedAt: performance.now(),
    routeKind,
    method: req.method,
    headOnly,
    bytesFromFtp: 0,
    logged: false,
  };
}

function logProxyTiming(timing: ProxyTiming, outcome: string) {
  if (timing.logged) return;
  timing.logged = true;
  console.info(
    "[proxy-timing]",
    JSON.stringify({
      outcome,
      routeKind: timing.routeKind,
      method: timing.method,
      headOnly: timing.headOnly,
      status: timing.status,
      range: timing.range,
      sizeBytes: timing.sizeBytes,
      contentLength: timing.contentLength,
      resolveMs: timing.resolveMs,
      headersMs: timing.headersMs,
      openMs: timing.openMs,
      firstByteMs: timing.firstByteMs,
      totalMs: elapsedMs(timing.startedAt),
      bytesFromFtp: timing.bytesFromFtp,
    }),
  );
}

function elapsedMs(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}
