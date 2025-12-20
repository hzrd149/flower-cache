// Combined stream utilities for hash calculation and cache writing

import { createHashStream, HashTransformStream } from "./hash-stream";
import { createCacheStream } from "./cache-stream";

/**
 * Result of creating a hash and cache stream
 */
export interface HashAndCacheResult {
  /**
   * The stream to use for responses (passes data through with hash calculation)
   */
  stream: ReadableStream<Uint8Array>;
  /**
   * Promise that resolves when hash validation completes
   * true if hash is valid, false otherwise
   */
  hashValidation: Promise<boolean>;
  /**
   * Promise that resolves when cache write completes
   */
  cacheWrite: Promise<void>;
}

/**
 * Create a stream transformer that:
 * 1. Calculates SHA256 hash incrementally
 * 2. Writes chunks to cache file as they arrive
 * 3. Passes data through for responses
 *
 * Flow:
 * - Upstream stream -> Hash transform (calculates hash, passes through)
 * - Hashed stream -> Tee into cache branch and response branch
 * - Cache branch -> Cache writer
 * - Response branch -> Returned to caller
 *
 * @param sha256 - The expected SHA256 hash
 * @param upstreamStream - The upstream response stream
 * @returns Result containing the response stream and validation promises
 */
export function createHashAndCacheStream(
  sha256: string,
  upstreamStream: ReadableStream<Uint8Array>,
): HashAndCacheResult {
  // Create hash transform stream
  const hashStream = createHashStream(sha256);

  // Pipe upstream through hash stream (this calculates hash and passes data through)
  const hashedStream = upstreamStream.pipeThrough(hashStream);

  // Tee the hashed stream into two branches:
  // 1. Cache writing branch
  // 2. Response branch (for clients)
  const [cacheStream, responseStream] = hashedStream.tee();

  // Create cache write stream
  const cacheWriter = createCacheStream(sha256);

  // Pipe cache branch to cache writer
  const cacheWritePromise = (async () => {
    try {
      await cacheStream.pipeTo(cacheWriter);
      console.log(`[${sha256}] ✓ Cache write completed`);
    } catch (error) {
      console.error(`[${sha256}] ✗ Cache write error:`, error);
      // Don't throw - we want to continue even if cache write fails
    }
  })();

  // Hash validation happens after the stream completes
  // We need to wait for both branches to complete to ensure all data is processed
  const hashValidationPromise = (async () => {
    try {
      // Wait for cache write to complete (ensures all data has been processed by hash stream)
      await cacheWritePromise;
      // Now validate the hash
      const isValid = await hashStream.validateHash();
      if (!isValid) {
        console.error(`[${sha256}] ✗ Hash validation failed`);
      } else {
        console.log(`[${sha256}] ✓ Hash validated`);
      }
      return isValid;
    } catch (error) {
      console.error(`[${sha256}] Hash validation error:`, error);
      return false;
    }
  })();

  return {
    stream: responseStream,
    hashValidation: hashValidationPromise,
    cacheWrite: cacheWritePromise,
  };
}
