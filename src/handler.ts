// Main request handler for blob requests

import type { ParsedRequest } from "./types";
import { ensureCacheDir, checkCache } from "./cache";
import {
  errorDownload,
  formatDurationMs,
  logDownload,
  warnDownload,
} from "./download-log";
import { getOrCreateDownload, type FollowerResult } from "./request-queue";
import {
  getDownloadWorkerPool,
  DownloadJobTimeoutError,
  DownloadQueueFullError,
  DownloadQueueTimeoutError,
} from "./worker-pool";
import { isKnownMissing, markMissing } from "./negative-cache";
import { resolveCandidateServers } from "./servers";
import type { DownloadOutcome } from "./worker-protocol";
import {
  getContentType,
  addCorsHeaders,
  createErrorResponse,
  generateETag,
  checkIfNoneMatch,
  createNotModifiedResponse,
  getCacheControlHeaders,
} from "./response";

/**
 * Handle GET and HEAD requests for blobs
 * Checks cache first, then proxies to upstream servers
 */
export async function handleBlobRequest(
  req: Request,
  parsed: ParsedRequest,
): Promise<Response> {
  const { sha256, extension, authorPubkeys, serverHints } = parsed;
  const startedAt = performance.now();
  const isHead = req.method === "HEAD";
  const rangeHeader = req.headers.get("Range");
  const etag = generateETag(sha256);

  // Check If-None-Match header for conditional requests
  // Skip this check for range requests as they need partial content
  if (!rangeHeader && checkIfNoneMatch(req, etag)) {
    return createNotModifiedResponse(etag);
  }

  // Ensure cache directory exists
  await ensureCacheDir();

  // Check cache first
  const cachedFile = await checkCache(sha256);
  if (cachedFile) {
    return handleCachedFile(
      req,
      cachedFile,
      extension,
      isHead,
      rangeHeader,
      etag,
    );
  }

  // If we recently confirmed this blob is missing everywhere, answer 404
  // immediately instead of re-hunting every upstream server. This is what
  // stops repeated polling for a not-yet-existent blob from amplifying into
  // continuous upstream fan-out.
  if (isKnownMissing(sha256)) {
    logDownload(
      sha256,
      `download not found (cached) ${formatDurationMs(startedAt)}`,
    );
    return createErrorResponse(404, "Blob not found");
  }

  // Not in cache, try to fetch from upstream servers using request deduplication.
  // A plain full-body GET can be answered while the blob is still arriving; a
  // HEAD has no body to stream, and a Range request wants bytes from an offset
  // rather than a transfer from zero, so both keep the download-then-serve path.
  const wantsStream = !isHead && !rangeHeader;

  let ticket;
  try {
    ticket = await getOrCreateDownload(sha256, async () => {
      const servers = await resolveCandidateServers(authorPubkeys, serverHints);

      if (servers.length === 0) {
        return { kind: "notFound" } as DownloadOutcome;
      }

      const workerPool = getDownloadWorkerPool();
      return workerPool.download(sha256, servers, extension, {
        stream: wantsStream,
      });
    });
  } catch (error) {
    if (
      error instanceof DownloadQueueFullError ||
      error instanceof DownloadQueueTimeoutError
    ) {
      logDownload(
        sha256,
        `download rejected (busy) ${formatDurationMs(startedAt)}`,
      );
      return addCorsHeaders(
        new Response("Server busy, try again later", {
          status: 503,
          headers: { "Retry-After": "5" },
        }),
      );
    }

    if (error instanceof DownloadJobTimeoutError) {
      logDownload(sha256, `download timed out ${formatDurationMs(startedAt)}`);
      return addCorsHeaders(
        new Response("Upstream download timed out", {
          status: 504,
          headers: { "Retry-After": "30" },
        }),
      );
    }

    throw error;
  }

  // The blob is arriving now — answer with it rather than waiting for the last
  // byte, the hash check and a re-read from disk.
  if (ticket.role === "leader" && ticket.outcome.kind === "stream") {
    return createStreamedResponse(
      sha256,
      ticket.outcome,
      extension,
      etag,
      startedAt,
    );
  }

  const result: FollowerResult =
    ticket.role === "follower"
      ? ticket.result
      : ticket.outcome.kind === "cached"
        ? "cached"
        : "notFound";

  if (result === "notFound") {
    markMissing(sha256);
    logDownload(sha256, `download not found ${formatDurationMs(startedAt)}`);
    return createErrorResponse(404, "Blob not found");
  }

  // Another request's transfer broke part-way (its client hung up, its worker
  // was lost). Nothing was learned about the blob, so don't cache a verdict —
  // just tell this caller to come back.
  if (result === "failed") {
    logDownload(
      sha256,
      `download interrupted upstream ${formatDurationMs(startedAt)}`,
    );
    return addCorsHeaders(
      new Response("Download interrupted, try again", {
        status: 503,
        headers: { "Retry-After": "1" },
      }),
    );
  }

  // Another request streamed this blob out and the bytes turned out not to hash
  // to the id we asked for, so nothing was cached. Don't poison the negative
  // cache — the blob exists upstream, it just can't be trusted.
  if (result === "unverified") {
    warnDownload(
      sha256,
      `download unverified upstream ${formatDurationMs(startedAt)}`,
    );
    return createErrorResponse(502, "Upstream blob failed verification");
  }

  const downloadedFile = await checkCache(sha256);
  if (!downloadedFile) {
    errorDownload(
      sha256,
      `download missing from cache ${formatDurationMs(startedAt)}`,
    );
    return createErrorResponse(500, "Downloaded blob was not written to cache");
  }

  const response = await handleCachedFile(
    req,
    downloadedFile,
    extension,
    isHead,
    rangeHeader,
    etag,
  );
  logDownload(
    sha256,
    `download served ${response.status} ${formatDurationMs(startedAt)}`,
  );
  return response;
}

/**
 * Build a response whose body is the upstream transfer still in flight. The
 * hash is only known once the last byte lands, so these bytes are served
 * unverified; the cache itself stays trustworthy because the worker only
 * commits a blob to disk when it hashes correctly.
 */
function createStreamedResponse(
  sha256: string,
  outcome: Extract<DownloadOutcome, { kind: "stream" }>,
  extension: string | undefined,
  etag: string,
  startedAt: number,
): Response {
  const headers = new Headers({
    "Content-Type": outcome.contentType || getContentType(extension),
    "Accept-Ranges": "bytes",
    ETag: etag,
    ...getCacheControlHeaders(),
  });

  // Bun currently drops Content-Length on a ReadableStream body and sends the
  // response chunked, so this is intent rather than effect today. Kept because
  // the length is genuinely known and costs nothing to declare.
  if (outcome.size !== undefined) {
    headers.set("Content-Length", outcome.size.toString());
  }

  void outcome.completion.then((completion) => {
    if (completion.verified) {
      logDownload(
        sha256,
        `download streamed ${completion.size} bytes ${formatDurationMs(startedAt)}`,
      );
    } else {
      warnDownload(
        sha256,
        `download streamed unverified (${completion.error ?? "hash mismatch"}) ${formatDurationMs(startedAt)}`,
      );
    }
  });

  return addCorsHeaders(new Response(outcome.body, { status: 200, headers }));
}

/**
 * Handle requests for cached files
 */
async function handleCachedFile(
  req: Request,
  cachedFile: import("bun").BunFile,
  extension: string | undefined,
  isHead: boolean,
  rangeHeader: string | null,
  etag: string,
): Promise<Response> {
  // Check If-None-Match for conditional requests (skip for range requests)
  if (!rangeHeader && checkIfNoneMatch(req, etag)) {
    return createNotModifiedResponse(etag);
  }

  const stats = await cachedFile.stat();
  const contentType = getContentType(extension);

  let response: Response;

  if (isHead) {
    // HEAD request - return headers only
    response = new Response(null, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": stats.size.toString(),
        "Accept-Ranges": "bytes",
        ETag: etag,
        ...getCacheControlHeaders(),
      },
    });
  } else if (rangeHeader) {
    // Range request on cached file
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = rangeMatch[2] ? parseInt(rangeMatch[2]!, 10) : stats.size - 1;

      // Validate range
      if (
        start < 0 ||
        start >= stats.size ||
        end >= stats.size ||
        start > end
      ) {
        return createErrorResponse(416, "Range not satisfiable");
      }

      const contentLength = end - start + 1;
      const slicedBlob = cachedFile.slice(start, end + 1);

      response = new Response(slicedBlob, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Length": contentLength.toString(),
          "Content-Range": `bytes ${start}-${end}/${stats.size}`,
          "Accept-Ranges": "bytes",
          ETag: etag,
          ...getCacheControlHeaders(),
        },
      });
    } else {
      // Invalid range header, return full file
      response = new Response(cachedFile);
      response.headers.set("Content-Type", contentType);
      response.headers.set("Content-Length", stats.size.toString());
      response.headers.set("Accept-Ranges", "bytes");
      response.headers.set("ETag", etag);
      Object.entries(getCacheControlHeaders()).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
    }
  } else {
    // Full file request
    response = new Response(cachedFile);
    response.headers.set("Content-Type", contentType);
    response.headers.set("Content-Length", stats.size.toString());
    response.headers.set("Accept-Ranges", "bytes");
    response.headers.set("ETag", etag);
    Object.entries(getCacheControlHeaders()).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }

  return addCorsHeaders(response);
}
