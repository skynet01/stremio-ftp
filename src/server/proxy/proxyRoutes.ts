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
  resolve(input: { installToken: string; fileId: number }): Promise<ProxyFile | null>;
};

export function createProxyRouter(deps: ProxyDeps) {
  const router = Router();

  router.head("/proxy/:installToken/:fileId", (req, res, next) => {
    void handleProxyRequest(deps, req, res, true).catch(next);
  });

  router.get("/proxy/:installToken/:fileId", (req, res, next) => {
    void handleProxyRequest(deps, req, res, false).catch(next);
  });

  return router;
}

async function handleProxyRequest(deps: ProxyDeps, req: Request, res: Response, headOnly: boolean) {
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

  const file = await deps.resolve({ installToken, fileId });
  if (!file) {
    res.sendStatus(404);
    return;
  }

  const rangeHeader = req.header("range");
  const range = parseRangeHeader(rangeHeader, file.sizeBytes);
  if (rangeHeader && file.sizeBytes !== null && !range) {
    if (file.sizeBytes !== null) {
      res.setHeader("Content-Range", `bytes */${file.sizeBytes}`);
      res.setHeader("Accept-Ranges", "bytes");
    }
    res.sendStatus(416);
    return;
  }

  const status = range && file.sizeBytes !== null ? 206 : 200;
  const start = range?.start ?? 0;
  const end = range?.end ?? (file.sizeBytes === null ? Number.MAX_SAFE_INTEGER : file.sizeBytes - 1);
  const contentLength = status === 206 ? range?.size ?? null : file.sizeBytes;

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
    return;
  }

  if (file.sizeBytes === 0) {
    res.end();
    return;
  }

  res.flushHeaders();

  const openController = new AbortController();
  let streamOpened = false;
  const abortPendingOpen = () => {
    if (!streamOpened) openController.abort();
  };
  res.once("close", abortPendingOpen);

  let stream: NodeJS.ReadableStream;
  try {
    stream = await file.openReadStream({ start, end, signal: openController.signal });
  } catch (error) {
    res.off("close", abortPendingOpen);
    if (openController.signal.aborted) return;
    throw error;
  }
  streamOpened = true;
  res.off("close", abortPendingOpen);
  if (openController.signal.aborted || res.destroyed) {
    destroyStream(stream);
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

  res.once("close", cleanup);
  stream.once("end", markFinished);
  stream.on("error", (error) => {
    markFinished();
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
