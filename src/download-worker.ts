import { mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  CACHE_DIR,
  DOWNLOAD_BUDGET,
  DOWNLOAD_MAX_DURATION,
  DOWNLOAD_MIN_SPEED,
  DOWNLOAD_STALL_TIMEOUT,
} from "./config";
import {
  buildCachePath,
  getPreferredExtensionFromMimeType,
  normalizeCacheExtension,
} from "./cache-file";
import {
  errorDownload,
  formatDurationMs,
  logDownload,
  warnDownload,
} from "./download-log";
import { fetchFromServer } from "./proxy";
import type {
  DownloadJob,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from "./worker-protocol";

/** Bytes buffered in the file sink before forcing a flush, bounding memory use
 *  when an upstream delivers faster than the disk can absorb. */
const FLUSH_INTERVAL_BYTES = 4 * 1024 * 1024;

/** Thrown when an upstream transfer is aborted for making too little progress. */
class DownloadStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadStalledError";
  }
}

function getTempCachePath(sha256: string): string {
  return `${CACHE_DIR}/.${sha256}.${randomUUID()}.part`;
}

async function writeValidatedBlobToCache(
  sha256: string,
  extension: string,
  upstreamStream: ReadableStream<Uint8Array>,
  transferAbort: AbortController,
): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true });

  const tempPath = getTempCachePath(sha256);
  const finalPath = buildCachePath(sha256, extension);
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(tempPath).writer();
  const transferStartedAt = performance.now();
  let size = 0;
  let flushedAt = 0;

  // A response that starts and never finishes is the cheapest way to pin a
  // download worker indefinitely, so bound the body read three ways: no bytes
  // for DOWNLOAD_STALL_TIMEOUT, sustained throughput under DOWNLOAD_MIN_SPEED,
  // and a hard DOWNLOAD_MAX_DURATION ceiling. Aborting the shared controller
  // also tears down the underlying fetch so the socket is released.
  let stallError: DownloadStalledError | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const failTransfer = (reason: string): DownloadStalledError => {
    const error = new DownloadStalledError(reason);
    stallError ??= error;
    transferAbort.abort(stallError);
    return stallError;
  };

  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => failTransfer(`no data for ${DOWNLOAD_STALL_TIMEOUT}ms`),
      DOWNLOAD_STALL_TIMEOUT,
    );
  };

  const maxDurationTimer = setTimeout(
    () => failTransfer(`transfer exceeded ${DOWNLOAD_MAX_DURATION}ms`),
    DOWNLOAD_MAX_DURATION,
  );

  try {
    const reader = upstreamStream.getReader();
    armStallTimer();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      armStallTimer();
      hasher.update(value);
      size += value.length;
      writer.write(value);

      if (size - flushedAt >= FLUSH_INTERVAL_BYTES) {
        await writer.flush();
        flushedAt = size;
      }

      // Only judge throughput once the transfer has run at least as long as the
      // stall window, so slow starts and small blobs aren't measured on a
      // sample that is mostly connection setup.
      const elapsedMs = performance.now() - transferStartedAt;
      if (
        elapsedMs > DOWNLOAD_STALL_TIMEOUT &&
        size / (elapsedMs / 1000) < DOWNLOAD_MIN_SPEED
      ) {
        throw failTransfer(`throughput below ${DOWNLOAD_MIN_SPEED} B/s`);
      }
    }

    writer.end();

    const digest = hasher.digest("hex").toLowerCase();
    if (digest !== sha256.toLowerCase()) {
      throw new Error("Hash validation failed");
    }

    await rename(tempPath, finalPath);
    return size;
  } catch (error) {
    try {
      writer.end();
    } catch {
      // ignore cleanup error
    }

    try {
      await Bun.file(tempPath).delete();
    } catch {
      // ignore cleanup error
    }

    // An abort surfaces here as a generic stream error; report the reason we
    // aborted for rather than the symptom.
    throw stallError ?? error;
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(maxDurationTimer);
  }
}

async function runDownload(job: DownloadJob): Promise<WorkerResponseMessage> {
  const startedAt = performance.now();
  const deadline = startedAt + DOWNLOAD_BUDGET;
  let sawInvalidBlob = false;
  let sawStalledUpstream = false;
  let budgetExhausted = false;

  for (const server of job.servers) {
    // Stop hunting once the overall time budget is spent, so a miss can't cost
    // REQUEST_TIMEOUT × (number of servers).
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      budgetExhausted = true;
      break;
    }

    // One controller per attempt, shared between the fetch and the body read so
    // the reader can tear down a transfer that stops making progress.
    const transferAbort = new AbortController();

    try {
      const response = await fetchFromServer(
        server,
        job.sha256,
        job.extension,
        undefined,
        0,
        remaining,
        transferAbort.signal,
      );

      if (!response || !response.ok || !response.body) {
        continue;
      }

      const extension = response.headers.get("Content-Type")
        ? getPreferredExtensionFromMimeType(
            response.headers.get("Content-Type"),
          )
        : normalizeCacheExtension(job.extension);

      const size = await writeValidatedBlobToCache(
        job.sha256,
        extension,
        response.body,
        transferAbort,
      );
      logDownload(
        job.sha256,
        `verify ok ${size} bytes ${formatDurationMs(startedAt)}`,
      );
      return {
        type: "download:complete",
        jobId: job.jobId,
        sha256: job.sha256,
        size,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown worker error";

      // A stalled upstream is that server's problem, not a job failure — drop it
      // and let the budget check at the top of the loop decide whether there is
      // time left to try another.
      if (error instanceof DownloadStalledError) {
        sawStalledUpstream = true;
        warnDownload(job.sha256, `download aborted from ${server}: ${message}`);
        continue;
      }

      if (message === "Hash validation failed") {
        sawInvalidBlob = true;
        warnDownload(job.sha256, `verify skipped invalid blob from ${server}`);
        continue;
      }

      throw error;
    }
  }

  if (sawInvalidBlob) {
    warnDownload(
      job.sha256,
      "verify miss after invalid upstream blob responses",
    );
  }
  if (sawStalledUpstream) {
    warnDownload(job.sha256, "verify miss after stalled upstream transfers");
  }
  if (budgetExhausted) {
    warnDownload(
      job.sha256,
      `download budget exhausted after ${formatDurationMs(startedAt)}`,
    );
  }
  logDownload(job.sha256, `verify miss ${formatDurationMs(startedAt)}`);
  return {
    type: "download:notFound",
    jobId: job.jobId,
    sha256: job.sha256,
  };
}

self.onmessage = async (event: MessageEvent<WorkerRequestMessage>) => {
  const message = event.data;

  if (message.type !== "download") {
    return;
  }

  try {
    const result = await runDownload(message);
    self.postMessage(result);
  } catch (error) {
    errorDownload(
      message.sha256,
      `verify failed ${error instanceof Error ? error.message : "Unknown worker error"}`,
    );
    self.postMessage({
      type: "download:error",
      jobId: message.jobId,
      sha256: message.sha256,
      error: error instanceof Error ? error.message : "Unknown worker error",
    } satisfies WorkerResponseMessage);
  }
};
