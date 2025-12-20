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
 */
export async function fetchFromServer(
  server: string,
  sha256: string,
  extension?: string,
  rangeHeader?: string,
  redirectCount: number = 0
): Promise<Response | null> {
  if (redirectCount > MAX_REDIRECTS) {
    return null; // Too many redirects
  }

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
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle redirects - follow them but ensure sha256 is preserved
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("Location");
          if (location && location.includes(sha256)) {
            // Recursively follow redirect with increased count
            return fetchFromServer(location, sha256, extension, rangeHeader, redirectCount + 1);
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

