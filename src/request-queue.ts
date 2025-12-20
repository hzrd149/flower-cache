// Request deduplication queue for in-flight blob fetches
// Prevents multiple concurrent requests for the same blob from triggering redundant upstream fetches

/**
 * Result of a streaming blob fetch operation
 */
export interface StreamResult {
  /**
   * The response stream (with hash calculation and cache writing applied)
   */
  stream: ReadableStream<Uint8Array> | null;
  /**
   * Content type from the upstream response
   */
  contentType: string;
  /**
   * Content length from the upstream response (may be null)
   */
  contentLength: number | null;
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
 * Map tracking in-flight blob fetches
 * Key: sha256 hash
 * Value: Promise that resolves to the stream result
 */
const inFlightFetches = new Map<string, Promise<StreamResult>>();

/**
 * Get or create a fetch promise for a given blob
 * If a fetch is already in progress for this blob, returns the existing promise.
 * Otherwise, creates a new fetch and tracks it.
 *
 * @param sha256 - The SHA256 hash of the blob
 * @param fetchFn - Function that performs the actual fetch and returns a Promise<StreamResult>
 * @returns Promise that resolves to the stream result
 */
export async function getOrCreateFetch(
  sha256: string,
  fetchFn: () => Promise<StreamResult>,
): Promise<StreamResult> {
  // Check if there's already a fetch in progress
  const existingFetch = inFlightFetches.get(sha256);
  if (existingFetch) {
    console.log(`[${sha256}] Waiting on existing fetch`);
    return existingFetch;
  }

  // Create new fetch promise
  console.log(`[${sha256}] Starting new fetch`);
  const fetchPromise = (async () => {
    try {
      const result = await fetchFn();
      return result;
    } finally {
      // Always remove from map after completion (success or failure)
      inFlightFetches.delete(sha256);
      console.log(`[${sha256}] Fetch completed, removed from queue`);
    }
  })();

  // Store the promise in the map
  inFlightFetches.set(sha256, fetchPromise);

  return fetchPromise;
}
