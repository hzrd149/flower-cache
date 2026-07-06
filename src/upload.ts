// Upload handler for BUD-02 PUT /upload endpoint

import {
  ensureCacheDir,
  findCacheEntry,
  writeCacheWithMetadata,
  getUploadTimestampFromDb,
} from "./cache";
import {
  createErrorResponse,
  getMimeTypeFromHeader,
  getContentType,
  normalizeExtensionFromMimeType,
  createBlobDescriptor,
} from "./response";
import { buildCachePath, normalizeCacheExtension } from "./cache-file";
import { validateAllowedIP } from "./security";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "./config";

/**
 * Handle PUT /upload request
 * @param req - The request object
 * @param server - The Bun server instance (for IP validation)
 * @returns Response with blob descriptor or error
 */
export async function handleUploadRequest(
  req: Request,
  server: { requestIP: (req: Request) => { address: string } | null },
): Promise<Response> {
  // Validate allowed IP
  const ipError = validateAllowedIP(req, server);
  if (ipError) return ipError;

  // Ensure cache directory exists
  await ensureCacheDir();

  // Get MIME type from Content-Type header
  const contentType = req.headers.get("Content-Type");
  const mimeType = getMimeTypeFromHeader(contentType);
  const normalizedExt = normalizeCacheExtension(
    normalizeExtensionFromMimeType(mimeType),
  );

  // Get content length if available
  const contentLengthHeader = req.headers.get("Content-Length");
  const contentLength = contentLengthHeader
    ? parseInt(contentLengthHeader, 10)
    : null;

  // Create temporary file path for writing
  const tempId = randomUUID();
  const tempPath = join(CACHE_DIR, `.upload-${tempId}`);

  try {
    // Get request body as stream
    if (!req.body) {
      return createErrorResponse(400, "Request body is required");
    }

    // Create hash stream (we'll use a placeholder hash for now, then validate)
    // Actually, we need to calculate hash first, then validate
    // Let's use a different approach: stream to temp file while calculating hash
    const hasher = new Bun.CryptoHasher("sha256");
    let totalSize = 0;

    // Create a file writer for temp file
    const tempFile = Bun.file(tempPath);
    const writer = tempFile.writer();

    try {
      // Stream the body, calculating hash and writing to temp file
      const reader = req.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Update hash
        hasher.update(value);
        // Write to temp file
        writer.write(value);
        totalSize += value.length;
      }

      // Finalize hash
      const computedHash = hasher.digest("hex").toLowerCase();
      writer.end();

      // Get final size from file stats
      const stats = await tempFile.stat();
      const finalSize = stats.size;

      // If the client provided an X-SHA-256 header, it MUST match the hash of
      // the received body (BUD-02). Reject mismatches with 409 Conflict.
      const claimedHash = req.headers.get("X-SHA-256")?.trim().toLowerCase();
      if (claimedHash && claimedHash !== computedHash) {
        await unlink(tempPath).catch(() => {});
        return createErrorResponse(
          409,
          `X-SHA-256 (${claimedHash}) does not match the uploaded content (${computedHash})`,
        );
      }

      // Check if blob with this hash already exists
      const existingEntry = await findCacheEntry(computedHash);

      if (existingEntry) {
        // Blob already exists, delete temp file
        await unlink(tempPath);
        console.log(`[${computedHash}] Upload skipped: blob already exists`);

        // Get existing file stats for descriptor
        const existingFile = Bun.file(existingEntry.filePath);
        const existingStats = await existingFile.stat();
        const existingSize = existingStats.size;

        // Get upload timestamp from metadata (or use current time as fallback)
        const uploadedTimestamp = await getUploadTimestamp(computedHash);

        // Return descriptor for existing blob
        return createBlobDescriptor(
          computedHash,
          existingSize,
          getContentType(existingEntry.extension),
          uploadedTimestamp,
          existingEntry.extension,
        );
      }

      // Move temp file to final location
      const finalCachePath = buildCachePath(computedHash, normalizedExt);
      await Bun.write(finalCachePath, tempFile);
      await unlink(tempPath).catch(() => {
        // Ignore if temp file already deleted
      });

      // Update cache metadata with upload timestamp
      const uploadedTimestamp = Math.floor(Date.now() / 1000);
      await writeCacheWithMetadata(
        computedHash,
        finalSize,
        uploadedTimestamp,
        normalizedExt,
      );

      console.log(`[${computedHash}] ✓ Upload completed: ${finalSize} bytes`);

      // Return blob descriptor with 201 Created for a newly stored blob (BUD-02)
      return createBlobDescriptor(
        computedHash,
        finalSize,
        mimeType,
        uploadedTimestamp,
        normalizedExt,
        undefined,
        201,
      );
    } catch (error) {
      // Clean up temp file on error
      await unlink(tempPath).catch(() => {
        // Ignore cleanup errors
      });
      throw error;
    }
  } catch (error) {
    console.error("Upload error:", error);
    return createErrorResponse(
      500,
      `Upload failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Get upload timestamp from cache metadata
 * Falls back to current time if not found
 */
async function getUploadTimestamp(sha256: string): Promise<number> {
  try {
    const timestamp = await getUploadTimestampFromDb(sha256);
    return timestamp || Math.floor(Date.now() / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}
