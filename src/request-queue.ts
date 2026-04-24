// Request deduplication queue for in-flight blob downloads
// Prevents multiple concurrent requests for the same blob from triggering redundant upstream downloads

import type { DownloadResult } from "./worker-protocol";
import { logDownload } from "./download-log";

const inFlightDownloads = new Map<string, Promise<DownloadResult>>();

/**
 * Get or create a download promise for a given blob.
 * If a download is already in progress for this blob, returns the existing promise.
 * Otherwise, creates a new download and tracks it.
 *
 * @param sha256 - The SHA256 hash of the blob
 * @param downloadFn - Function that performs the actual download
 * @returns Promise that resolves to the download result
 */
export async function getOrCreateDownload(
  sha256: string,
  downloadFn: () => Promise<DownloadResult>,
): Promise<DownloadResult> {
  // Check if there's already a download in progress
  const existingDownload = inFlightDownloads.get(sha256);
  if (existingDownload) {
    return existingDownload;
  }

  // Create new download promise
  logDownload(sha256, "download start");
  const downloadPromise = (async () => {
    try {
      const result = await downloadFn();
      return result;
    } finally {
      // Always remove from map after completion (success or failure)
      inFlightDownloads.delete(sha256);
    }
  })();

  // Store the promise in the map
  inFlightDownloads.set(sha256, downloadPromise);

  return downloadPromise;
}
