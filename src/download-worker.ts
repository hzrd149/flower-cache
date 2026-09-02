import { mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  CACHE_DIR,
  DOWNLOAD_BUDGET,
  DOWNLOAD_MAX_DURATION,
  DOWNLOAD_MIN_SPEED,
  DOWNLOAD_STALL_TIMEOUT,
  STREAM_CHUNK_CREDITS,
  STREAM_THROUGH,
  STREAM_THROUGH_MIN_SIZE,
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
  DownloadChunkMessage,
  DownloadHeadersMessage,
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

/** Thrown when the bytes an upstream served don't hash to the requested id. */
class HashMismatchError extends Error {
  constructor() {
    super("Hash validation failed");
    this.name = "HashMismatchError";
  }
}

/** Thrown when the client consuming a streamed transfer disconnected. */
class DownloadCancelledError extends Error {
  constructor() {
    super("Client cancelled the transfer");
    this.name = "DownloadCancelledError";
  }
}

/**
 * Pushes chunks to the main thread under a credit window, so a client that
 * reads slower than the upstream sends can't make the worker buffer the whole
 * blob in memory. One credit is granted per `download:pull`, which the response
 * stream emits as its queue drains.
 */
class ChunkRelay {
  private credits = STREAM_CHUNK_CREDITS;
  private waiter: (() => void) | null = null;

  cancelled = false;
  /** Time spent blocked on the client, excluded from throughput judgement. */
  waitedMs = 0;

  constructor(private readonly jobId: string) {}

  grant(): void {
    this.credits += 1;
    this.wake();
  }

  cancel(): void {
    this.cancelled = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async send(chunk: Uint8Array): Promise<void> {
    while (this.credits <= 0 && !this.cancelled) {
      const blockedAt = performance.now();
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waitedMs += performance.now() - blockedAt;
    }

    if (this.cancelled) {
      return;
    }

    this.credits -= 1;

    // The chunk's backing buffer is still owned by the file sink and the
    // hasher, so transfer a copy rather than neutering it under them.
    const copy = chunk.slice();
    self.postMessage(
      {
        type: "download:chunk",
        jobId: this.jobId,
        buffer: copy.buffer as ArrayBuffer,
      } satisfies DownloadChunkMessage,
      [copy.buffer as ArrayBuffer],
    );
  }
}

const activeRelays = new Map<string, ChunkRelay>();

function getTempCachePath(sha256: string): string {
  return `${CACHE_DIR}/.${sha256}.${randomUUID()}.part`;
}

interface TransferResult {
  size: number;
  verified: boolean;
}

/**
 * How a transfer may turn into a stream.
 *
 * An upstream that declares a large enough body opens the stream on the first
 * chunk (`threshold` 0). One that declares nothing has to be measured instead:
 * the first `threshold` bytes are held back, and the stream only opens once the
 * body proves to be large enough to be worth streaming. A body that ends first
 * was a small blob all along and is served the verified way, which is what
 * makes STREAM_THROUGH_MIN_SIZE mean the same thing for every upstream.
 */
interface StreamGate {
  /** Bytes to buffer before committing to a stream. */
  threshold: number;
  /** Opens the stream: posts the headers and registers the relay. */
  begin: () => ChunkRelay;
  /** Set once `begin` has been called; failover is off from that point. */
  started: boolean;
}

async function writeValidatedBlobToCache(
  sha256: string,
  extension: string,
  upstreamStream: ReadableStream<Uint8Array>,
  transferAbort: AbortController,
  gate?: StreamGate,
): Promise<TransferResult> {
  await mkdir(CACHE_DIR, { recursive: true });

  const tempPath = getTempCachePath(sha256);
  const finalPath = buildCachePath(sha256, extension);
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(tempPath).writer();
  const transferStartedAt = performance.now();
  let size = 0;
  let flushedAt = 0;
  let relay: ChunkRelay | undefined;
  /** Chunks held back while the body is still being measured against the gate. */
  const withheld: Uint8Array[] = [];
  let withheldBytes = 0;

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

      if (gate) {
        if (!relay) {
          withheld.push(value);
          withheldBytes += value.length;

          if (withheldBytes >= gate.threshold) {
            relay = gate.begin();
          }
        }

        if (relay) {
          // Waiting on the client is not the upstream stalling, so stand the
          // stall timer down for as long as we're blocked on credit.
          clearTimeout(stallTimer);
          for (const chunk of withheld.length > 0 ? withheld : [value]) {
            await relay.send(chunk);
            if (relay.cancelled) {
              break;
            }
          }
          withheld.length = 0;
          withheldBytes = 0;

          if (relay.cancelled) {
            transferAbort.abort();
            throw new DownloadCancelledError();
          }
          armStallTimer();
        }
      }

      // Only judge throughput once the transfer has run at least as long as the
      // stall window, so slow starts and small blobs aren't measured on a
      // sample that is mostly connection setup.
      const elapsedMs =
        performance.now() - transferStartedAt - (relay?.waitedMs ?? 0);
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
      try {
        await Bun.file(tempPath).delete();
      } catch {
        // ignore cleanup error
      }

      // Once the bytes are already on their way to a client there is nothing
      // to fail over to — report the transfer as unverified and let the caller
      // decide. A body that never crossed the gate was never served, so it
      // still gets the ordinary treatment: skip this server and try the next.
      if (relay) {
        return { size, verified: false };
      }

      throw new HashMismatchError();
    }

    await rename(tempPath, finalPath);
    return { size, verified: true };
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
    if (error instanceof DownloadCancelledError) {
      throw error;
    }
    throw stallError ?? error;
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(maxDurationTimer);
  }
}

/**
 * How many bytes must be seen before this response may be streamed, or
 * `undefined` if it may not be streamed at all.
 *
 * A declared length settles it up front. An undeclared one is measured as the
 * body arrives, so a chunked upstream can't quietly opt every blob — however
 * small — out of verify-before-send.
 */
function streamThresholdFor(
  job: DownloadJob,
  declaredSize: number | undefined,
): number | undefined {
  if (!job.stream || !STREAM_THROUGH) {
    return undefined;
  }

  if (declaredSize === undefined) {
    return STREAM_THROUGH_MIN_SIZE;
  }

  return declaredSize >= STREAM_THROUGH_MIN_SIZE ? 0 : undefined;
}

function readContentLength(response: Response): number | undefined {
  const header = response.headers.get("Content-Length");
  if (header === null) {
    return undefined;
  }

  const size = Number.parseInt(header, 10);
  return Number.isFinite(size) && size >= 0 ? size : undefined;
}

async function runDownload(job: DownloadJob): Promise<WorkerResponseMessage> {
  const startedAt = performance.now();
  const deadline = startedAt + DOWNLOAD_BUDGET;
  let sawInvalidBlob = false;
  let sawStalledUpstream = false;
  let budgetExhausted = false;
  let gate: StreamGate | undefined;

  try {
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

        const declaredSize = readContentLength(response);
        const threshold = streamThresholdFor(job, declaredSize);

        if (threshold !== undefined) {
          const contentType = response.headers.get("Content-Type") ?? undefined;
          gate = {
            threshold,
            started: false,
            begin: () => {
              const relay = new ChunkRelay(job.jobId);
              activeRelays.set(job.jobId, relay);
              gate!.started = true;
              self.postMessage({
                type: "download:headers",
                jobId: job.jobId,
                sha256: job.sha256,
                size: declaredSize,
                contentType,
              } satisfies DownloadHeadersMessage);
              logDownload(
                job.sha256,
                `stream started from ${server} ${declaredSize ?? "unknown"} bytes`,
              );
              return relay;
            },
          };
        }

        const { size, verified } = await writeValidatedBlobToCache(
          job.sha256,
          extension,
          response.body,
          transferAbort,
          gate,
        );

        if (verified) {
          logDownload(
            job.sha256,
            `verify ok ${size} bytes ${formatDurationMs(startedAt)}`,
          );
        } else {
          warnDownload(
            job.sha256,
            `verify failed after streaming ${size} bytes from ${server}; not cached`,
          );
        }

        return {
          type: "download:complete",
          jobId: job.jobId,
          sha256: job.sha256,
          size,
          verified,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown worker error";

        // Once bytes have left for a client there is nothing to fail over to.
        if (gate?.started) {
          throw error;
        }

        // The gate never opened, so this attempt was ordinary buffered work and
        // the next server gets a clean one.
        gate = undefined;

        // A stalled upstream is that server's problem, not a job failure — drop it
        // and let the budget check at the top of the loop decide whether there is
        // time left to try another.
        if (error instanceof DownloadStalledError) {
          sawStalledUpstream = true;
          warnDownload(
            job.sha256,
            `download aborted from ${server}: ${message}`,
          );
          continue;
        }

        if (error instanceof HashMismatchError) {
          sawInvalidBlob = true;
          warnDownload(
            job.sha256,
            `verify skipped invalid blob from ${server}`,
          );
          continue;
        }

        throw error;
      }
    }
  } finally {
    activeRelays.delete(job.jobId);
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

  // Flow control for an in-progress streamed transfer. These arrive while
  // runDownload is still awaiting the body, so they must not be queued behind
  // it — handle and return.
  if (message.type === "download:pull") {
    activeRelays.get(message.jobId)?.grant();
    return;
  }

  if (message.type === "download:cancel") {
    activeRelays.get(message.jobId)?.cancel();
    return;
  }

  if (message.type !== "download") {
    return;
  }

  try {
    const result = await runDownload(message);
    self.postMessage(result);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Unknown worker error";

    if (error instanceof DownloadCancelledError) {
      warnDownload(message.sha256, "download cancelled by client");
    } else {
      errorDownload(message.sha256, `verify failed ${reason}`);
    }

    self.postMessage({
      type: "download:error",
      jobId: message.jobId,
      sha256: message.sha256,
      error: reason,
    } satisfies WorkerResponseMessage);
  }
};
