// Main request handler for blob requests

import { mergeBlossomServers } from "applesauce-common/helpers";
import type { ParsedRequest } from "./types";
import { ensureCacheDir, checkCache } from "./cache";
import { fetchFromServer } from "./proxy";
import { resolveAuthorServers } from "./author";
import { FALLBACK_SERVERS, CACHE_DIR, LOOKUP_RELAYS } from "./config";
import { getOrCreateFetch } from "./request-queue";
import { createHashAndCacheStream } from "./stream-utils";

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
  // Note: For range requests, we still fetch the full blob to validate hash
  console.log(`[${sha256}] Resolving blob request`);

  // Use request queue to deduplicate concurrent requests for the same blob
  const fetchResult = await getOrCreateFetch(sha256, async () => {
    let upstreamStream: ReadableStream<Uint8Array> | null = null;
    let contentType = getContentType(extension);
    let contentLength: number | null = null;

    // Collect all servers from sx hints and as hints
    const allServers: string[] = [...serverHints].map(
      normalizeServerUrlForMerge,
    );

    // Collect servers from as hints
    if (authorPubkeys.length > 0) {
      if (LOOKUP_RELAYS.length === 0) {
        console.log(
          `[${sha256}] Skipping as hint resolution: no lookup relays configured`,
        );
      } else {
        console.log(
          `[${sha256}] Resolving ${authorPubkeys.length} as hint(s): ${authorPubkeys.join(", ")}`,
        );
        for (const pubkey of authorPubkeys) {
          console.log(`[${sha256}] Resolving servers for as hint: ${pubkey}`);
          const authorServers = await resolveAuthorServers(pubkey);
          if (authorServers.length > 0) {
            console.log(
              `[${sha256}] Found ${authorServers.length} server(s) for ${pubkey}: ${authorServers.join(", ")}`,
            );
          } else {
            console.log(`[${sha256}] No servers found for ${pubkey}`);
          }
          // Author servers should already be full URLs from resolveAuthorServers,
          // but normalize them just in case
          allServers.push(...authorServers.map(normalizeServerUrlForMerge));
        }
      }
    }

    // Normalize and deduplicate all servers
    const servers = mergeBlossomServers(allServers);
    if (servers.length > 0) {
      if (servers.length < allServers.length) {
        console.log(
          `[${sha256}] Deduplicated ${allServers.length} server(s) to ${servers.length}: ${servers.join(", ")}`,
        );
      } else {
        console.log(
          `[${sha256}] Trying ${servers.length} server(s): ${servers.join(", ")}`,
        );
      }
    } else {
      console.log(`[${sha256}] No servers to try`);
    }

    // Try all servers in order
    for (const server of servers) {
      console.log(`[${sha256}] Trying server: ${server}`);
      // Always fetch full blob (not range) to validate hash
      const response = await fetchFromServer(server, sha256, extension);

      if (response && response.ok && response.body) {
        console.log(`[${sha256}] ✓ Successfully fetched from: ${server}`);
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

        // Get the response body as a stream (don't consume as blob)
        upstreamStream = response.body;
        break;
      } else {
        console.log(`[${sha256}] ✗ Failed to fetch from: ${server}`);
      }
    }

    // If still not found, try fallback servers
    if (!upstreamStream && FALLBACK_SERVERS.length > 0) {
      console.log(
        `[${sha256}] Trying ${FALLBACK_SERVERS.length} fallback server(s): ${FALLBACK_SERVERS.map((url) => url.href).join(", ")}`,
      );

      for (const fallbackServer of FALLBACK_SERVERS) {
        const serverUrl = fallbackServer.href;
        console.log(`[${sha256}] Trying fallback server: ${serverUrl}`);
        // Always fetch full blob to validate hash
        const response = await fetchFromServer(serverUrl, sha256, extension);

        if (response && response.ok && response.body) {
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

          upstreamStream = response.body;
          break;
        } else {
          console.log(
            `[${sha256}] ✗ Failed to fetch from fallback server: ${serverUrl}`,
          );
        }
      }
    }

    // If no stream found, return null
    if (!upstreamStream) {
      return {
        stream: null,
        contentType,
        contentLength,
        hashValidation: Promise.resolve(false),
        cacheWrite: Promise.resolve(),
      };
    }

    // Create hash and cache stream wrapper
    const { stream, hashValidation, cacheWrite } = createHashAndCacheStream(
      sha256,
      upstreamStream,
    );

    return {
      stream,
      contentType,
      contentLength,
      hashValidation,
      cacheWrite,
    };
  });

  // If still not found, return 404
  if (!fetchResult.stream) {
    console.log(`[${sha256}] ✗ Blob not found after trying all hints`);
    return createErrorResponse(404, "Blob not found");
  }

  // Tee the stream to create a new branch for this request
  // This allows multiple concurrent requests to read from the same upstream fetch
  // without locking conflicts. Each request gets its own branch.
  const [requestStream, hashConsumptionStream] = fetchResult.stream.tee();

  const contentType = fetchResult.contentType;
  const contentLength = fetchResult.contentLength;
  const hashValidation = fetchResult.hashValidation;

  // Start hash validation in background (don't await yet)
  hashValidation
    .then(async (isValid) => {
      if (!isValid) {
        // Hash validation failed - delete invalid cache file
        const cachePath = `${CACHE_DIR}/${sha256}`;
        try {
          const file = Bun.file(cachePath);
          await file.delete();
          console.log(`[${sha256}] ✗ Deleted invalid cache file`);
        } catch (error) {
          console.error(`[${sha256}] Error deleting invalid cache:`, error);
        }
      }
    })
    .catch((error) => {
      console.error(`[${sha256}] Hash validation error:`, error);
    });

  // For HEAD requests, consume the stream to ensure hash calculation completes
  // The hash is calculated via the cache write branch, but we consume this branch
  // to ensure data flows through the hash stream
  if (isHead) {
    // Consume stream in background for hash calculation
    // Pipe to a null consumer to ensure all data is processed
    const nullWriter = new WritableStream({
      write() {
        // Discard all data
      },
    });
    // Consume the hashConsumptionStream to ensure data flows through hash stream
    // The cache write branch also consumes data, but this ensures we don't block
    hashConsumptionStream.pipeTo(nullWriter).catch(() => {
      // Ignore errors
    });

    // Return headers only (contentLength may be null if not provided by upstream)
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      ETag: etag,
      ...getCacheControlHeaders(),
    };
    if (contentLength !== null) {
      headers["Content-Length"] = contentLength.toString();
    }
    return addCorsHeaders(new Response(null, { status: 200, headers }));
  }

  // Handle range requests for GET requests
  // Note: We still stream the full blob for hash validation, but only send the range
  if (rangeHeader) {
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = rangeMatch[2] ? parseInt(rangeMatch[2]!, 10) : null;

      // For range requests with streaming, we need to know the total size
      if (contentLength === null) {
        // If we don't know the size, fall back to streaming the full response
        return addCorsHeaders(
          new Response(requestStream, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Accept-Ranges": "bytes",
              ETag: etag,
              ...getCacheControlHeaders(),
            },
          }),
        );
      }

      const endByte = end !== null ? end : contentLength - 1;

      // Validate range
      if (
        start < 0 ||
        start >= contentLength ||
        endByte >= contentLength ||
        start > endByte
      ) {
        return createErrorResponse(416, "Range not satisfiable");
      }

      // Consume hashConsumptionStream to ensure data flows through hash stream
      // This is needed because we're only reading a portion of requestStream for the range
      hashConsumptionStream
        .pipeTo(
          new WritableStream({
            write() {
              // Discard data, we just need to consume it to ensure data flows
            },
          }),
        )
        .catch(() => {
          // Ignore errors
        });

      // Create a transform stream that handles range requests
      const rangeStream = new ReadableStream({
        start(controller) {
          let bytesSkipped = 0;
          let bytesSent = 0;
          const rangeLength = endByte - start + 1;

          const reader = requestStream.getReader();

          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                if (bytesSkipped < start) {
                  // Skip bytes until we reach the start
                  const skipAmount = Math.min(
                    start - bytesSkipped,
                    value.length,
                  );
                  bytesSkipped += skipAmount;
                  if (skipAmount < value.length) {
                    // We've reached the start, send the rest of this chunk
                    const remaining = value.slice(skipAmount);
                    const toSend = Math.min(
                      remaining.length,
                      rangeLength - bytesSent,
                    );
                    if (toSend > 0) {
                      controller.enqueue(remaining.slice(0, toSend));
                      bytesSent += toSend;
                    }
                  }
                } else {
                  // We're in the range, send bytes
                  const remaining = rangeLength - bytesSent;
                  if (remaining <= 0) {
                    // We've sent enough, cancel the reader
                    reader.cancel();
                    break;
                  }
                  const toSend = Math.min(value.length, remaining);
                  controller.enqueue(value.slice(0, toSend));
                  bytesSent += toSend;
                  if (toSend < value.length) {
                    // We've sent enough, cancel the reader
                    reader.cancel();
                    break;
                  }
                }
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          };

          pump();
        },
      });

      const rangeLength = endByte - start + 1;
      return addCorsHeaders(
        new Response(rangeStream, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Length": rangeLength.toString(),
            "Content-Range": `bytes ${start}-${endByte}/${contentLength}`,
            "Accept-Ranges": "bytes",
            ETag: etag,
            ...getCacheControlHeaders(),
          },
        }),
      );
    }
  }

  // Return full stream for GET requests
  // Hash validation is already happening via the cache write branch in createHashAndCacheStream
  // We consume the hashConsumptionStream to ensure data flows, but it's not strictly necessary
  // since the cache write branch is already consuming data
  hashConsumptionStream
    .pipeTo(
      new WritableStream({
        write() {
          // Discard data, we just need to consume it to ensure data flows
        },
      }),
    )
    .catch(() => {
      // Ignore errors
    });

  return addCorsHeaders(
    new Response(requestStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        ...(contentLength !== null
          ? { "Content-Length": contentLength.toString() }
          : {}),
        "Accept-Ranges": "bytes",
        ETag: etag,
        ...getCacheControlHeaders(),
      },
    }),
  );
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
