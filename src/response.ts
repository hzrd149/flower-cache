// Response handling utilities

import mime from "mime";

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
