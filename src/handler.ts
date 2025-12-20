// Main request handler for blob requests

import type { ParsedRequest } from "./types";
import { ensureCacheDir, checkCache, writeCache } from "./cache";
import { validateHash } from "./hash";
import { fetchFromServer } from "./proxy";
import { resolveAuthorServers } from "./author";
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
  parsed: ParsedRequest
): Promise<Response> {
  const { sha256, extension, authorPubkeys, serverHints } = parsed;
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
    return handleCachedFile(req, cachedFile, extension, isHead, rangeHeader, etag);
  }

  // Not in cache, try to fetch from upstream servers
  // Note: For range requests, we still fetch the full blob to validate hash
  let blobData: Blob | null = null;
  let contentType = getContentType(extension);
  let contentLength: number | null = null;

  // Try server hints first
  for (const serverHint of serverHints) {
    // Always fetch full blob (not range) to validate hash
    const response = await fetchFromServer(serverHint, sha256, extension);

    if (response && response.ok) {
      // Get content type from response if available
      const responseContentType = response.headers.get("Content-Type");
      if (responseContentType) {
        contentType = responseContentType;
      }

      // Get content length
      const responseContentLength = response.headers.get("Content-Length");
      if (responseContentLength) {
        contentLength = parseInt(responseContentLength, 10);
      }

      // For HEAD requests, return headers only (but we still need to validate hash)
      if (isHead) {
        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
        };
        if (contentLength !== null) {
          headers["Content-Length"] = contentLength.toString();
        }
        // Still download to validate, but don't return body
        blobData = await response.blob();
        break;
      }

      // Fetch full blob for hash validation
      blobData = await response.blob();
      break;
    }
  }

  // If not found in server hints, try author servers
  if (!blobData) {
    for (const pubkey of authorPubkeys) {
      const authorServers = await resolveAuthorServers(pubkey);
      for (const server of authorServers) {
        // Always fetch full blob to validate hash
        const response = await fetchFromServer(server, sha256, extension);

        if (response && response.ok) {
          const responseContentType = response.headers.get("Content-Type");
          if (responseContentType) {
            contentType = responseContentType;
          }

          const responseContentLength = response.headers.get("Content-Length");
          if (responseContentLength) {
            contentLength = parseInt(responseContentLength, 10);
          }

          if (isHead) {
            const headers: Record<string, string> = {
              "Content-Type": contentType,
              "Accept-Ranges": "bytes",
            };
            if (contentLength !== null) {
              headers["Content-Length"] = contentLength.toString();
            }
            // Still download to validate
            blobData = await response.blob();
            break;
          }

          blobData = await response.blob();
          break;
        }
      }
      if (blobData) break;
    }
  }

  // If still not found, return 404
  if (!blobData) {
    return createErrorResponse(404, "Blob not found");
  }

  // Validate hash before caching
  const isValid = await validateHash(blobData, sha256);
  if (!isValid) {
    return createErrorResponse(400, "Hash mismatch: downloaded blob does not match requested sha256");
  }

  // Cache the blob (always cache after validation)
  await writeCache(sha256, blobData);

  // For HEAD requests, return headers only
  if (isHead) {
    const headers = {
      "Content-Type": contentType,
      "Content-Length": blobData.size.toString(),
      "Accept-Ranges": "bytes",
      "ETag": etag,
      ...getCacheControlHeaders(),
    };
    return addCorsHeaders(new Response(null, { status: 200, headers }));
  }

  // Handle range requests for GET requests
  if (rangeHeader) {
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = rangeMatch[2] ? parseInt(rangeMatch[2]!, 10) : blobData.size - 1;

      // Validate range
      if (start < 0 || start >= blobData.size || end >= blobData.size || start > end) {
        return createErrorResponse(416, "Range not satisfiable");
      }

      const slicedBlob = blobData.slice(start, end + 1);
      const contentLength = end - start + 1;

      const response = new Response(slicedBlob, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Length": contentLength.toString(),
          "Content-Range": `bytes ${start}-${end}/${blobData.size}`,
          "Accept-Ranges": "bytes",
          "ETag": etag,
          ...getCacheControlHeaders(),
        },
      });

      return addCorsHeaders(response);
    }
  }

  // Return full blob for GET requests
  const response = new Response(blobData, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": blobData.size.toString(),
      "Accept-Ranges": "bytes",
      "ETag": etag,
      ...getCacheControlHeaders(),
    },
  });

  return addCorsHeaders(response);
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
  etag: string
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
        "ETag": etag,
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
      if (start < 0 || start >= stats.size || end >= stats.size || start > end) {
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
          "ETag": etag,
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

