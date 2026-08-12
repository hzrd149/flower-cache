// Proxy client for fetching blobs from upstream servers

import { REQUEST_TIMEOUT, MAX_REDIRECTS } from "./config";

/**
 * Normalize server URL - add protocol if missing, try https first
 * Returns array of URLs to try (https first, then http)
 */
export function normalizeServerUrl(server: string): string[] {
  // If already has protocol, return as-is
  if (server.startsWith("http://") || server.startsWith("https://")) {
    return [server];
  }

  // Try https first, then http
  return [`https://${server}`, `http://${server}`];
}

/**
 * Fetch blob from upstream server
 * Handles redirects, timeouts, and multiple server attempts
 *
 * @param bodySignal - Optional caller-owned signal that stays armed after the
 *   response headers arrive. The internal timeout only covers the header phase
 *   (a healthy large transfer must not be killed by it), so consumers that read
 *   the body are responsible for bounding it and aborting through this signal.
 */
export async function fetchFromServer(
  server: string,
  sha256: string,
  extension?: string,
  rangeHeader?: string,
  redirectCount: number = 0,
  timeoutMs: number = REQUEST_TIMEOUT,
  bodySignal?: AbortSignal,
): Promise<Response | null> {
  if (redirectCount > MAX_REDIRECTS) {
    return null; // Too many redirects
  }

  if (bodySignal?.aborted) {
    return null;
  }

  // Never exceed the per-attempt timeout, but allow the caller to shrink it
  // (e.g. when only a little of the overall download budget remains).
  const attemptTimeout = Math.min(timeoutMs, REQUEST_TIMEOUT);

  const servers = normalizeServerUrl(server);

  for (const serverUrl of servers) {
    try {
      const path = extension ? `/${sha256}${extension}` : `/${sha256}`;
      const url = `${serverUrl.replace(/\/$/, "")}${path}`;

      const headers: Record<string, string> = {};
      if (rangeHeader) {
        headers["Range"] = rangeHeader;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);
      // The header timer is cleared below, but bodySignal is not, so the caller
      // keeps a live handle on the connection for as long as it reads the body.
      const signal = bodySignal
        ? AbortSignal.any([controller.signal, bodySignal])
        : controller.signal;

      try {
        const response = await fetch(url, {
          headers,
          signal,
        });

        clearTimeout(timeoutId);

        // Handle redirects - follow them but ensure sha256 is preserved
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("Location");
          if (location && location.includes(sha256)) {
            // Recursively follow redirect with increased count
            return fetchFromServer(
              location,
              sha256,
              extension,
              rangeHeader,
              redirectCount + 1,
              timeoutMs,
              bodySignal,
            );
          }
        }

        // Return response if successful or if it's a range request (206)
        if (response.ok || response.status === 206) {
          return response;
        }

        // If 404 or other error, try next server
        if (response.status === 404) {
          continue;
        }

        // For other errors, return null to try next server
        return null;
      } catch (error) {
        clearTimeout(timeoutId);
        // The caller gave up on this blob entirely (budget spent, stalled
        // transfer) — don't fall through to the http:// variant or another URL.
        if (bodySignal?.aborted) {
          return null;
        }
        // Network error or timeout, try next server
        if (error instanceof Error && error.name === "AbortError") {
          continue;
        }
        throw error;
      }
    } catch {
      // Try next server
      continue;
    }
  }

  return null;
}
