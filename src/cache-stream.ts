// Streaming cache writes

import { mkdir } from "node:fs/promises";
import { CACHE_DIR } from "./config";

/**
 * Get the cache file path for a given sha256 hash
 */
function getCachePath(sha256: string): string {
  return `${CACHE_DIR}/${sha256}`;
}

/**
 * Create a writable stream that writes chunks to cache file as they arrive
 * @param sha256 - The SHA256 hash of the blob being cached
 * @returns WritableStream that writes to the cache file
 */
export function createCacheStream(sha256: string): WritableStream<Uint8Array> {
  const cachePath = getCachePath(sha256);
  let writer: Bun.FileSink | null = null;

  return new WritableStream({
    async start() {
      // Ensure cache directory exists
      await mkdir(CACHE_DIR, { recursive: true });
      // Open file for writing using FileSink
      const file = Bun.file(cachePath);
      writer = file.writer();
    },
    async write(chunk) {
      if (!writer) {
        throw new Error("Cache stream writer not initialized");
      }
      // Write chunk to file using FileSink
      writer.write(chunk);
    },
    async close() {
      if (writer) {
        // Flush any remaining buffered data and close
        writer.end();
        writer = null;
      }
    },
    async abort(reason) {
      // Clean up: delete partial file on error
      if (writer) {
        try {
          writer.end();
        } catch {
          // Ignore errors during cleanup
        }
        writer = null;
      }
      try {
        const file = Bun.file(cachePath);
        await file.delete();
      } catch {
        // Ignore errors during cleanup
      }
    },
  });
}
