import { randomUUID } from "node:crypto";
import { pruneCacheIfNeeded, updateAccessTime } from "./cache";
import {
  DOWNLOAD_JOB_TIMEOUT,
  DOWNLOAD_QUEUE_TIMEOUT,
  MAX_DOWNLOAD_QUEUE,
  WORKER_RESPAWN_DELAY,
} from "./config";
import { errorDownload, warnDownload } from "./download-log";
import type {
  DownloadHeadersMessage,
  DownloadJob,
  DownloadOutcome,
  StreamCompletion,
  WorkerResponseMessage,
} from "./worker-protocol";

/** Main-thread end of a streamed transfer, live between headers and complete. */
interface JobStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** Never rejects — a failed stream reports through the errored body instead. */
  finish: (completion: StreamCompletion) => void;
  /** The body is closed, errored or cancelled; nothing more may be enqueued. */
  closed: boolean;
  /**
   * The completion promise has been answered. Tracked apart from `closed`
   * because a client cancelling closes the body without ending the transfer,
   * and whoever is waiting on completion (the dedup queue, for one) must still
   * be told how it finished.
   */
  reported: boolean;
}

interface TrackedJob {
  job: DownloadJob;
  resolve: (outcome: DownloadOutcome) => void;
  reject: (error: Error) => void;
  /** Backstop covering queue wait plus execution. */
  jobTimer: ReturnType<typeof setTimeout>;
  /** Bounds queue wait only; cleared once the job reaches a worker. */
  queueTimer?: ReturnType<typeof setTimeout>;
  worker?: Worker;
  /** The caller's promise has been answered. */
  settled: boolean;
  /** The job reached a terminal state; timers cleared, worker recycled. */
  finished: boolean;
  stream?: JobStream;
}

/** Thrown when the download queue is at capacity and can't accept more work. */
export class DownloadQueueFullError extends Error {
  constructor() {
    super("Download queue is full");
    this.name = "DownloadQueueFullError";
  }
}

/** Thrown when a download waited too long for a free worker. */
export class DownloadQueueTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for a download worker");
    this.name = "DownloadQueueTimeoutError";
  }
}

/** Thrown when a download exceeded its overall deadline. */
export class DownloadJobTimeoutError extends Error {
  constructor() {
    super("Download timed out");
    this.name = "DownloadJobTimeoutError";
  }
}

export class DownloadWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly idleWorkers: Worker[] = [];
  private readonly busyWorkers = new Map<Worker, TrackedJob>();
  private readonly pendingJobs = new Map<string, TrackedJob>();
  private readonly queuedJobs: TrackedJob[] = [];
  private readonly targetWorkerCount: number;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private isTerminating = false;

  constructor(workerCount: number) {
    this.targetWorkerCount = Math.max(1, workerCount);

    for (let index = 0; index < this.targetWorkerCount; index += 1) {
      this.spawnWorker();
    }

    if (this.workers.size < this.targetWorkerCount) {
      this.scheduleRespawn();
    }
  }

  async download(
    sha256: string,
    servers: string[],
    extension?: string,
    options: { stream?: boolean } = {},
  ): Promise<DownloadOutcome> {
    if (this.isTerminating) {
      throw new Error("Download worker pool is shutting down");
    }

    // Reject work once the backlog is saturated. Only busy workers count as
    // "in progress"; anything past that many is queued, so bound the queue.
    if (this.queuedJobs.length >= MAX_DOWNLOAD_QUEUE) {
      throw new DownloadQueueFullError();
    }

    return new Promise<DownloadOutcome>((resolve, reject) => {
      const job: DownloadJob = {
        type: "download",
        jobId: randomUUID(),
        sha256,
        extension,
        servers,
        stream: options.stream,
      };

      const tracked: TrackedJob = {
        job,
        resolve,
        reject,
        settled: false,
        finished: false,
        // Assigned immediately below; the timers need `tracked` to exist first.
        jobTimer: undefined as unknown as ReturnType<typeof setTimeout>,
      };

      // Every caller gets an answer, even if a worker never reports back.
      tracked.jobTimer = setTimeout(
        () => this.handleJobTimeout(tracked),
        DOWNLOAD_JOB_TIMEOUT,
      );
      tracked.queueTimer = setTimeout(
        () => this.handleQueueTimeout(tracked),
        DOWNLOAD_QUEUE_TIMEOUT,
      );

      this.queuedJobs.push(tracked);
      this.dispatchNext();
    });
  }

  async terminate(): Promise<void> {
    this.isTerminating = true;

    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }

    const abandoned = [...this.queuedJobs, ...this.pendingJobs.values()];
    this.queuedJobs.length = 0;
    this.pendingJobs.clear();
    this.busyWorkers.clear();
    this.idleWorkers.length = 0;

    for (const tracked of abandoned) {
      const error = new Error("Download worker pool terminated");
      this.failStream(tracked, error);
      tracked.finished = true;
      clearTimeout(tracked.jobTimer);
      if (tracked.queueTimer) {
        clearTimeout(tracked.queueTimer);
        tracked.queueTimer = undefined;
      }
      this.settle(tracked, () => tracked.reject(error));
    }

    const workers = [...this.workers];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }

  /** Answer the caller's promise exactly once. */
  private settle(tracked: TrackedJob, complete: () => void): void {
    if (tracked.settled) {
      return;
    }

    tracked.settled = true;
    complete();
  }

  /**
   * End a job for good: clear its timers, drop it from the pending map and hand
   * the worker back. A streamed job settles its outcome long before this — the
   * worker stays busy until the last chunk has been relayed.
   */
  private finish(tracked: TrackedJob): void {
    if (tracked.finished) {
      return;
    }

    tracked.finished = true;
    clearTimeout(tracked.jobTimer);
    if (tracked.queueTimer) {
      clearTimeout(tracked.queueTimer);
      tracked.queueTimer = undefined;
    }

    // Backstop: nothing may leave a streamed job's completion unanswered — the
    // dedup queue holds the hash in flight until it settles.
    this.reportStream(tracked, {
      size: 0,
      verified: false,
      error: "Download ended without a result",
    });

    this.pendingJobs.delete(tracked.job.jobId);
    this.recycleWorker(tracked.worker, tracked);
  }

  private recycleWorker(
    worker: Worker | undefined,
    tracked?: TrackedJob,
  ): void {
    if (!worker) {
      return;
    }

    if (!tracked || this.busyWorkers.get(worker) === tracked) {
      this.busyWorkers.delete(worker);
    }

    // Only recycle a worker the pool still owns — a replaced one must stay out.
    if (
      !this.isTerminating &&
      this.workers.has(worker) &&
      !this.busyWorkers.has(worker) &&
      !this.idleWorkers.includes(worker)
    ) {
      this.idleWorkers.push(worker);
      this.dispatchNext();
    }
  }

  /** Error a live response body, so a client never sees a silent truncation. */
  private failStream(tracked: TrackedJob, error: Error): void {
    const stream = tracked.stream;
    if (!stream) {
      return;
    }

    if (!stream.closed) {
      stream.closed = true;
      try {
        stream.controller.error(error);
      } catch {
        // the body was already cancelled or closed
      }
    }

    this.reportStream(tracked, {
      size: 0,
      verified: false,
      error: error.message,
    });
  }

  /** Answer a streamed transfer's completion promise exactly once. */
  private reportStream(
    tracked: TrackedJob,
    completion: StreamCompletion,
  ): void {
    const stream = tracked.stream;
    if (!stream || stream.reported) {
      return;
    }

    stream.reported = true;
    stream.finish(completion);
  }

  private removeFromQueue(tracked: TrackedJob): boolean {
    const index = this.queuedJobs.indexOf(tracked);
    if (index < 0) {
      return false;
    }

    this.queuedJobs.splice(index, 1);
    return true;
  }

  private spawnWorker(): boolean {
    if (this.isTerminating) {
      return false;
    }

    try {
      const worker = new Worker(
        new URL("./download-worker.ts", import.meta.url).href,
        { type: "module" },
      );

      worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
        void this.handleWorkerMessage(worker, event.data);
      };

      worker.onerror = (event) => {
        this.replaceWorker(
          worker,
          new Error(event.message || "Download worker error"),
        );
      };

      this.workers.add(worker);
      this.idleWorkers.push(worker);
      return true;
    } catch (error) {
      console.error(
        "[pool] Failed to spawn download worker:",
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * Retire a worker that crashed or went unresponsive and bring the pool back
   * to strength. Without this the pool silently shrinks to zero and every
   * queued download hangs forever.
   */
  private replaceWorker(worker: Worker, error: Error): void {
    const wasTracked = this.workers.delete(worker);

    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) {
      this.idleWorkers.splice(idleIndex, 1);
    }

    const tracked = this.busyWorkers.get(worker);
    if (tracked) {
      this.busyWorkers.delete(worker);
      this.pendingJobs.delete(tracked.job.jobId);

      if (!tracked.finished) {
        errorDownload(tracked.job.sha256, `worker lost ${error.message}`);
        // A job that was already streaming has an answered caller but a live
        // body; break that rather than leaving the client hanging forever.
        this.failStream(tracked, error);
        tracked.finished = true;
        clearTimeout(tracked.jobTimer);
        this.settle(tracked, () => tracked.reject(error));
      }
    }

    try {
      void worker.terminate();
    } catch {
      // ignore termination failures for an already-dead worker
    }

    if (!wasTracked || this.isTerminating) {
      return;
    }

    console.warn(
      `[pool] Download worker lost (${error.message}); ${this.workers.size}/${this.targetWorkerCount} remaining`,
    );
    this.scheduleRespawn();
  }

  /**
   * Refill the pool after a short delay, so a worker that fails on startup
   * can't spin in a tight respawn loop.
   */
  private scheduleRespawn(): void {
    if (this.isTerminating || this.respawnTimer) {
      return;
    }

    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;

      if (this.isTerminating) {
        return;
      }

      let spawned = false;
      while (this.workers.size < this.targetWorkerCount) {
        if (!this.spawnWorker()) {
          break;
        }
        spawned = true;
      }

      if (spawned) {
        this.dispatchNext();
      }

      if (this.workers.size < this.targetWorkerCount) {
        this.scheduleRespawn();
      }
    }, WORKER_RESPAWN_DELAY);
  }

  private dispatchNext(): void {
    if (this.isTerminating) {
      return;
    }

    while (this.idleWorkers.length > 0 && this.queuedJobs.length > 0) {
      const worker = this.idleWorkers.shift();
      const tracked = this.queuedJobs.shift();

      if (!worker || !tracked) {
        return;
      }

      if (tracked.settled) {
        // Timed out while queued; put the worker back and take the next job.
        this.idleWorkers.unshift(worker);
        continue;
      }

      if (tracked.queueTimer) {
        clearTimeout(tracked.queueTimer);
        tracked.queueTimer = undefined;
      }

      tracked.worker = worker;
      this.pendingJobs.set(tracked.job.jobId, tracked);
      this.busyWorkers.set(worker, tracked);
      worker.postMessage(tracked.job);
    }
  }

  private handleQueueTimeout(tracked: TrackedJob): void {
    if (tracked.finished || !this.removeFromQueue(tracked)) {
      return;
    }

    warnDownload(
      tracked.job.sha256,
      `download rejected after ${DOWNLOAD_QUEUE_TIMEOUT}ms waiting for a worker`,
    );
    this.finish(tracked);
    this.settle(tracked, () => tracked.reject(new DownloadQueueTimeoutError()));
  }

  private handleJobTimeout(tracked: TrackedJob): void {
    if (tracked.finished) {
      return;
    }

    this.removeFromQueue(tracked);
    this.pendingJobs.delete(tracked.job.jobId);

    errorDownload(
      tracked.job.sha256,
      `download timed out after ${DOWNLOAD_JOB_TIMEOUT}ms`,
    );
    // A streamed job has already answered its caller, so the deadline has to
    // reach the client through the response body.
    this.failStream(tracked, new DownloadJobTimeoutError());
    tracked.finished = true;
    this.settle(tracked, () => tracked.reject(new DownloadJobTimeoutError()));

    // The worker is wedged on a job that should have bounded itself, so it
    // can't be trusted with the next one.
    const worker = tracked.worker;
    if (worker && this.busyWorkers.get(worker) === tracked) {
      this.replaceWorker(worker, new DownloadJobTimeoutError());
    }
  }

  /**
   * Open the client-facing body for a transfer the worker has just committed to
   * streaming. The caller is answered here — long before the blob is verified —
   * which is the entire point: time-to-first-byte stops being the length of the
   * upstream transfer.
   */
  private beginStream(
    tracked: TrackedJob,
    worker: Worker,
    message: DownloadHeadersMessage,
  ): void {
    if (tracked.stream || tracked.finished) {
      return;
    }

    let finish!: (completion: StreamCompletion) => void;
    const completion = new Promise<StreamCompletion>((resolve) => {
      finish = resolve;
    });

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        tracked.stream = { controller, finish, closed: false, reported: false };
      },
      // One credit per drain. The worker blocks once it runs out, so a client
      // reading slower than the upstream sends can't inflate memory here.
      pull: () => {
        if (!tracked.finished) {
          worker.postMessage({
            type: "download:pull",
            jobId: tracked.job.jobId,
          });
        }
      },
      cancel: () => {
        if (tracked.stream) {
          tracked.stream.closed = true;
        }
        if (!tracked.finished) {
          worker.postMessage({
            type: "download:cancel",
            jobId: tracked.job.jobId,
          });
        }
      },
    });

    this.settle(tracked, () =>
      tracked.resolve({
        kind: "stream",
        contentType: message.contentType,
        size: message.size,
        body,
        completion,
      }),
    );
  }

  private async handleWorkerMessage(
    worker: Worker,
    message: WorkerResponseMessage,
  ): Promise<void> {
    const tracked = this.pendingJobs.get(message.jobId);

    // Mid-transfer traffic keeps the job (and its worker) in flight.
    if (message.type === "download:headers") {
      if (tracked) {
        this.beginStream(tracked, worker, message);
      }
      return;
    }

    if (message.type === "download:chunk") {
      const stream = tracked?.stream;
      if (stream && !stream.closed) {
        try {
          stream.controller.enqueue(new Uint8Array(message.buffer));
        } catch {
          // the client cancelled between chunks; the worker is being told
        }
      }
      return;
    }

    // Everything below is terminal: the worker is done and can take more work.
    if (!tracked) {
      // Late reply for a job that already timed out, or an unknown job id.
      this.recycleWorker(worker);
      return;
    }

    if (message.type === "download:complete") {
      const stream = tracked.stream;

      // Nothing was written when the hash didn't match, so there is no entry to
      // touch — but the bytes did go out, which the caller learns from
      // `verified`.
      if (message.verified) {
        await updateAccessTime(message.sha256, message.size);
        void pruneCacheIfNeeded();
      }

      if (stream) {
        if (!stream.closed) {
          stream.closed = true;
          try {
            stream.controller.close();
          } catch {
            // already cancelled by the client
          }
        }
        this.reportStream(tracked, {
          size: message.size,
          verified: message.verified,
        });
        this.finish(tracked);
        return;
      }

      this.finish(tracked);
      this.settle(tracked, () =>
        tracked.resolve(
          message.verified
            ? { kind: "cached", size: message.size }
            : { kind: "notFound" },
        ),
      );
      return;
    }

    if (message.type === "download:notFound") {
      this.finish(tracked);
      this.settle(tracked, () => tracked.resolve({ kind: "notFound" }));
      return;
    }

    const error = new Error(message.error);
    if (tracked.stream) {
      // The caller already holds the body, so the failure has to travel through
      // it rather than through the (already settled) outcome promise.
      warnDownload(message.sha256, `stream failed ${message.error}`);
      this.failStream(tracked, error);
      this.finish(tracked);
      return;
    }

    errorDownload(message.sha256, `worker error ${message.error}`);
    this.finish(tracked);
    this.settle(tracked, () => tracked.reject(error));
  }
}

let workerPool: DownloadWorkerPool | null = null;

export function initializeDownloadWorkerPool(
  workerCount: number,
): DownloadWorkerPool {
  if (!workerPool) {
    workerPool = new DownloadWorkerPool(workerCount);
  }

  return workerPool;
}

export function getDownloadWorkerPool(): DownloadWorkerPool {
  if (!workerPool) {
    throw new Error("Download worker pool has not been initialized");
  }

  return workerPool;
}

export async function terminateDownloadWorkerPool(): Promise<void> {
  if (!workerPool) {
    return;
  }

  const pool = workerPool;
  workerPool = null;
  await pool.terminate();
}
