// Main request handler for blob requests

import type { ParsedRequest } from "./types";
import { ensureCacheDir, checkCache, writeCache } from "./cache";
import { validateHash } from "./hash";
import { fetchFromServer } from "./proxy";
import { resolveAuthorServers } from "./author";
import { FALLBACK_SERVERS } from "./config";
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
    console.log(`[${sha256}] ✓ Found in cache`);
    return handleCachedFile(
      req,
      cachedFile,
      extension,
      isHead,
      rangeHeader,
      etag,
    );
  }

  // Not in cache, try to fetch from upstream servers
  // Note: For range requests, we still fetch the full blob to validate hash
  console.log(`[${sha256}] Resolving blob request`);

  let blobData: Blob | null = null;
  let contentType = getContentType(extension);
  let contentLength: number | null = null;

  // Try server hints first
  if (serverHints.length > 0) {
    console.log(
      `[${sha256}] Found ${serverHints.length} sx hint(s):`,
      serverHints,
    );
  } else {
    console.log(`[${sha256}] No sx hints provided`);
  }

  for (const serverHint of serverHints) {
    console.log(`[${sha256}] Trying sx hint: ${serverHint}`);
    // Always fetch full blob (not range) to validate hash
    const response = await fetchFromServer(serverHint, sha256, extension);

    if (response && response.ok) {
      console.log(
        `[${sha256}] ✓ Successfully fetched from sx hint: ${serverHint}`,
      );
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
    } else {
      console.log(`[${sha256}] ✗ Failed to fetch from sx hint: ${serverHint}`);
    }
  }

  // If not found in server hints, try author servers from all as hints
  if (!blobData) {
    if (authorPubkeys.length > 0) {
      console.log(
        `[${sha256}] No sx hints worked, resolving ${authorPubkeys.length} as hint(s):`,
        authorPubkeys,
      );
    } else {
      console.log(`[${sha256}] No sx hints worked and no as hints provided`);
    }

    // Collect all blossom servers from all as hints
    const allAuthorServers: string[] = [];
    for (const pubkey of authorPubkeys) {
      console.log(`[${sha256}] Resolving servers for as hint: ${pubkey}`);
      const authorServers = await resolveAuthorServers(pubkey);
      if (authorServers.length > 0) {
        console.log(
          `[${sha256}] Found ${authorServers.length} server(s) for ${pubkey}:`,
          authorServers,
        );
      } else {
        console.log(`[${sha256}] No servers found for ${pubkey}`);
      }
      allAuthorServers.push(...authorServers);
    }

    if (allAuthorServers.length > 0) {
      console.log(
        `[${sha256}] Trying ${allAuthorServers.length} server(s) from all as hints`,
      );
    } else {
      console.log(`[${sha256}] No servers found from any as hints`);
    }

    // Try all collected servers in order
    for (const server of allAuthorServers) {
      console.log(`[${sha256}] Trying server from as hint: ${server}`);
      // Always fetch full blob to validate hash
      const response = await fetchFromServer(server, sha256, extension);

      if (response && response.ok) {
        console.log(
          `[${sha256}] ✓ Successfully fetched from as hint server: ${server}`,
        );
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
      } else {
        console.log(
          `[${sha256}] ✗ Failed to fetch from as hint server: ${server}`,
        );
      }
    }
  }

  // If still not found, try fallback servers
  if (!blobData && FALLBACK_SERVERS.length > 0) {
    console.log(
      `[${sha256}] Trying ${FALLBACK_SERVERS.length} fallback server(s):`,
      FALLBACK_SERVERS.map((url) => url.href),
    );

    for (const fallbackServer of FALLBACK_SERVERS) {
      const serverUrl = fallbackServer.href;
      console.log(`[${sha256}] Trying fallback server: ${serverUrl}`);
      // Always fetch full blob to validate hash
      const response = await fetchFromServer(serverUrl, sha256, extension);

      if (response && response.ok) {
        console.log(
          `[${sha256}] ✓ Successfully fetched from fallback server: ${serverUrl}`,
        );
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
      } else {
        console.log(
          `[${sha256}] ✗ Failed to fetch from fallback server: ${serverUrl}`,
        );
      }
    }
  }

  // If still not found, return 404
  if (!blobData) {
    console.log(`[${sha256}] ✗ Blob not found after trying all hints`);
    return createErrorResponse(404, "Blob not found");
  }

  // Validate hash before caching
  console.log(`[${sha256}] Validating hash...`);
  const isValid = await validateHash(blobData, sha256);
  if (!isValid) {
    console.log(`[${sha256}] ✗ Hash validation failed`);
    return createErrorResponse(
      400,
      "Hash mismatch: downloaded blob does not match requested sha256",
    );
  }
  console.log(`[${sha256}] ✓ Hash validated, caching blob`);

  // Cache the blob (always cache after validation)
  await writeCache(sha256, blobData);

  // For HEAD requests, return headers only
  if (isHead) {
    const headers = {
      "Content-Type": contentType,
      "Content-Length": blobData.size.toString(),
      "Accept-Ranges": "bytes",
      ETag: etag,
      ...getCacheControlHeaders(),
    };
    return addCorsHeaders(new Response(null, { status: 200, headers }));
  }

  // Handle range requests for GET requests
  if (rangeHeader) {
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = rangeMatch[2]
        ? parseInt(rangeMatch[2]!, 10)
        : blobData.size - 1;

      // Validate range
      if (
        start < 0 ||
        start >= blobData.size ||
        end >= blobData.size ||
        start > end
      ) {
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
          ETag: etag,
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
      ETag: etag,
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
