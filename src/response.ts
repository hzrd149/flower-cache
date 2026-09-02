// Response handling utilities

import { lookup as lookupMimeType } from "mime-types";
import { PORT } from "./config";
import { getPreferredExtensionFromMimeType } from "./cache-file";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE",
  "Access-Control-Allow-Headers": "Authorization, *",
  "Access-Control-Max-Age": "86400",
} as const;

/**
 * Get content type from file extension
 */
export function getContentType(extension?: string): string {
  if (!extension) {
    return "application/octet-stream";
  }

  const normalizedExtension = extension.startsWith(".")
    ? extension.slice(1)
    : extension;
  return lookupMimeType(normalizedExtension) || "application/octet-stream";
}

/**
 * Get MIME type from Content-Type header
 * @param contentTypeHeader - The Content-Type header value
 * @returns MIME type string, defaults to "application/octet-stream"
 */
export function getMimeTypeFromHeader(
  contentTypeHeader: string | null,
): string {
  if (!contentTypeHeader) {
    return "application/octet-stream";
  }

  // Content-Type header may include charset or other parameters
  // e.g., "text/plain; charset=utf-8" -> "text/plain"
  const mimeType = contentTypeHeader.split(";")[0]?.trim();
  return mimeType || "application/octet-stream";
}

/**
 * Normalize file extension based on MIME type
 * @param mimeType - The MIME type (e.g., "application/pdf")
 * @returns File extension with leading dot (e.g., ".pdf") or empty string if unknown
 */
export function normalizeExtensionFromMimeType(mimeType: string): string {
  return getPreferredExtensionFromMimeType(mimeType);
}

/**
 * Generate ETag from sha256 hash
 * ETag format: "sha256" (wrapped in quotes per HTTP spec)
 */
export function generateETag(sha256: string): string {
  return `"${sha256}"`;
}

/**
 * Check if the request has If-None-Match header matching the ETag
 * Returns true if client has a valid cached version
 */
export function checkIfNoneMatch(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (!ifNoneMatch) {
    return false;
  }

  // If-None-Match can contain multiple ETags separated by commas
  // Also handle weak ETags (W/"...") and quoted ETags
  const etags = ifNoneMatch.split(",").map((e) => e.trim().replace(/^W\//, ""));
  const normalizedETag = etag.replace(/^W\//, "");

  return etags.some((e) => e === normalizedETag || e === etag);
}

/**
 * Create a 304 Not Modified response
 */
export function createNotModifiedResponse(etag: string): Response {
  const response = new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
      "Cache-Control": "public, max-age=31536000, immutable", // 1 year, immutable since content-addressed
    },
  });
  return addCorsHeaders(response);
}

/**
 * Get cache control headers for blob responses
 * Since blobs are content-addressed (sha256), they can be cached indefinitely
 */
export function getCacheControlHeaders(): Record<string, string> {
  return {
    "Cache-Control": "public, max-age=31536000, immutable", // 1 year, immutable
  };
}

/**
 * Add CORS headers to response
 *
 * Mutates the response in place. Rebuilding it as `new Response(response.body)`
 * re-wraps a BunFile body as a generic stream, which costs the Content-Length
 * (every blob response fell back to chunked encoding) and, for a sliced file,
 * loses the end bound entirely — a `bytes=100-199` range was served as
 * everything from byte 100 to EOF.
 */
export function addCorsHeaders(response: Response): Response {
  try {
    response.headers.set(
      "Access-Control-Allow-Origin",
      CORS_HEADERS["Access-Control-Allow-Origin"],
    );
    return response;
  } catch {
    // Guarded headers (e.g. a response handed straight back from fetch) can't
    // be edited, so fall back to a copy.
    const headers = new Headers(response.headers);
    headers.set(
      "Access-Control-Allow-Origin",
      CORS_HEADERS["Access-Control-Allow-Origin"],
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Create error response with X-Reason header
 */
export function createErrorResponse(status: number, reason: string): Response {
  const response = new Response(reason, { status });
  response.headers.set("X-Reason", reason);
  return addCorsHeaders(response);
}

/**
 * Create BUD-02 blob descriptor JSON response
 * @param sha256 - The SHA-256 hash of the blob
 * @param size - The size of the blob in bytes
 * @param mimeType - The MIME type of the blob
 * @param uploadedTimestamp - Unix timestamp when blob was uploaded
 * @param extension - File extension (with leading dot). BUD-02 requires the
 *   descriptor `url` to include an extension, so this defaults to `.bin`.
 * @param serverUrl - Optional server URL (defaults to localhost with PORT from config)
 * @param status - HTTP status code (201 for newly stored blobs, 200 if it already existed)
 * @returns Response with blob descriptor JSON
 */
export function createBlobDescriptor(
  sha256: string,
  size: number,
  mimeType: string,
  uploadedTimestamp: number,
  extension: string = ".bin",
  serverUrl?: string,
  status: number = 200,
): Response {
  // Build URL with extension
  const path = `/${sha256}${extension}`;
  const baseUrl = serverUrl || `http://localhost:${PORT}`;
  const url = `${baseUrl}${path}`;

  const descriptor = {
    url,
    sha256,
    size,
    type: mimeType,
    uploaded: uploadedTimestamp,
  };

  const response = new Response(JSON.stringify(descriptor, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

  return addCorsHeaders(response);
}
