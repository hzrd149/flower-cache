// Request deduplication queue for in-flight blob downloads
// Prevents multiple concurrent requests for the same blob from triggering redundant upstream downloads

import type { DownloadOutcome } from "./worker-protocol";
import { logDownload } from "./download-log";

/**
 * How a deduplicated download ended, for everyone who wasn't driving it.
 *
 * - `cached`: verified and on disk.
 * - `notFound`: no upstream had it.
 * - `unverified`: an upstream served bytes that didn't hash to this id.
 * - `failed`: the transfer broke (client cancelled, worker lost, timed out).
 *   Nothing conclusive was learned about the blob, so it is worth retrying.
 */
export type FollowerResult = "cached" | "notFound" | "unverified" | "failed";

/**
 * The caller that created the download drives it and, when the worker streams,
 * owns the response body. Everyone else waits for it to land in the cache.
 *
 * Fanning a single live stream out to several clients is a separate feature;
 * followers keeping today's wait-then-serve-from-disk behaviour costs them
 * nothing they weren't already paying.
 */
export type DownloadTicket =
  | { role: "leader"; outcome: DownloadOutcome }
  | { role: "follower"; result: FollowerResult };

interface InFlightEntry {
  /** Resolves once the blob is cached (or known not to be). Never rejects. */
  settled: Promise<FollowerResult>;
}

const inFlightDownloads = new Map<string, InFlightEntry>();

/**
 * Get or create a download for a given blob.
 * If a download is already in progress for this blob, waits for it to finish
 * and reports how it ended. Otherwise starts one and returns the leader ticket.
 *
 * @param sha256 - The SHA256 hash of the blob
 * @param downloadFn - Function that performs the actual download
 */
export async function getOrCreateDownload(
  sha256: string,
  downloadFn: () => Promise<DownloadOutcome>,
): Promise<DownloadTicket> {
  const existing = inFlightDownloads.get(sha256);
  if (existing) {
    return { role: "follower", result: await existing.settled };
  }

  logDownload(sha256, "download start");

  let markSettled!: (result: FollowerResult) => void;
  const settled = new Promise<FollowerResult>((resolve) => {
    markSettled = resolve;
  });

  inFlightDownloads.set(sha256, { settled });

  const release = (result: FollowerResult) => {
    inFlightDownloads.delete(sha256);
    markSettled(result);
  };

  let outcome: DownloadOutcome;
  try {
    outcome = await downloadFn();
  } catch (error) {
    // The leader's own rejection (503/504) says nothing about the blob, so
    // followers are told to retry rather than being handed a miss.
    release("failed");
    throw error;
  }

  if (outcome.kind === "stream") {
    // Hold the entry open for the whole transfer, so a second request for the
    // same hash waits for the cache write instead of opening its own upstream
    // connection.
    void outcome.completion.then(
      (completion) =>
        release(
          completion.verified
            ? "cached"
            : completion.error
              ? "failed"
              : "unverified",
        ),
      () => release("failed"),
    );
  } else {
    release(outcome.kind === "cached" ? "cached" : "notFound");
  }

  return { role: "leader", outcome };
}
