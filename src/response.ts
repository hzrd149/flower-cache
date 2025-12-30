// Response handling utilities

import mime from "mime";
import { PORT } from "./config";

/**
 * Get content type from file extension
 */
export function getContentType(extension?: string): string {
  if (!extension) {
    return "application/octet-stream";
  }

  const lowerExt = extension.toLowerCase();
  return mime.getType(extension) || "application/octet-stream";
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
  if (!mimeType || mimeType === "application/octet-stream") {
    return "";
  }

  const extension = mime.getExtension(mimeType);
  return extension ? `.${extension}` : "";
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
 */
export function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
 * @param extension - Optional file extension (with leading dot)
 * @param serverUrl - Optional server URL (defaults to localhost with PORT from config)
 * @returns Response with blob descriptor JSON
 */
export function createBlobDescriptor(
  sha256: string,
  size: number,
  mimeType: string,
  uploadedTimestamp: number,
  extension: string = "",
  serverUrl?: string,
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
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });

  return addCorsHeaders(response);
}
