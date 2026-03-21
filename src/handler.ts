// Main request handler for blob requests

import { mergeBlossomServers } from "applesauce-common/helpers";
import type { ParsedRequest } from "./types";
import { ensureCacheDir, checkCache } from "./cache";
import { resolveAuthorServers } from "./author";
import { FALLBACK_SERVERS, LOOKUP_RELAYS } from "./config";
import { errorDownload, formatDurationMs, logDownload } from "./download-log";
import { getOrCreateDownload } from "./request-queue";
import { getDownloadWorkerPool } from "./worker-pool";

/**
 * Normalize a server URL by adding protocol if missing
 * Returns the URL with https:// protocol (preferred)
 */
function normalizeServerUrlForMerge(server: string): string {
  // If already has protocol, return as-is
  if (server.startsWith("http://") || server.startsWith("https://")) {
    return server;
  }
  // Add https:// protocol (preferred)
  return `https://${server}`;
}
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

  // Not in cache, try to fetch from upstream servers using request deduplication

  const downloadResult = await getOrCreateDownload(sha256, async () => {
    const servers = await resolveCandidateServers(
      sha256,
      authorPubkeys,
      serverHints,
    );

    if (servers.length === 0) {
      return { found: false };
    }

    const workerPool = getDownloadWorkerPool();
    return workerPool.download(sha256, servers, extension);
  });

  if (!downloadResult.found) {
    logDownload(sha256, `download not found ${formatDurationMs(startedAt)}`);
    return createErrorResponse(404, "Blob not found");
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

async function resolveCandidateServers(
  sha256: string,
  authorPubkeys: string[],
  serverHints: string[],
): Promise<string[]> {
  const allServers: string[] = [...serverHints].map(normalizeServerUrlForMerge);

  if (authorPubkeys.length > 0) {
    if (LOOKUP_RELAYS.length === 0) {
    } else {
      for (const pubkey of authorPubkeys) {
        const authorServers = await resolveAuthorServers(pubkey);
        allServers.push(...authorServers.map(normalizeServerUrlForMerge));
      }
    }
  }

  allServers.push(...FALLBACK_SERVERS.map((url) => url.href));

  return mergeBlossomServers(allServers);
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
