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
  DownloadJob,
  DownloadResult,
  WorkerResponseMessage,
} from "./worker-protocol";

interface TrackedJob {
  job: DownloadJob;
  resolve: (result: DownloadResult) => void;
  reject: (error: Error) => void;
  /** Backstop covering queue wait plus execution. */
  jobTimer: ReturnType<typeof setTimeout>;
  /** Bounds queue wait only; cleared once the job reaches a worker. */
  queueTimer?: ReturnType<typeof setTimeout>;
  worker?: Worker;
  settled: boolean;
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
  ): Promise<DownloadResult> {
    if (this.isTerminating) {
      throw new Error("Download worker pool is shutting down");
    }

    // Reject work once the backlog is saturated. Only busy workers count as
    // "in progress"; anything past that many is queued, so bound the queue.
    if (this.queuedJobs.length >= MAX_DOWNLOAD_QUEUE) {
      throw new DownloadQueueFullError();
    }

    return new Promise<DownloadResult>((resolve, reject) => {
      const job: DownloadJob = {
        type: "download",
        jobId: randomUUID(),
        sha256,
        extension,
        servers,
      };

      const tracked: TrackedJob = {
        job,
        resolve,
        reject,
        settled: false,
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
      this.settle(tracked, () =>
        tracked.reject(new Error("Download worker pool terminated")),
      );
    }

    const workers = [...this.workers];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }

  /** Resolve or reject exactly once, clearing the job's timers. */
  private settle(tracked: TrackedJob, complete: () => void): void {
    if (tracked.settled) {
      return;
    }

    tracked.settled = true;
    clearTimeout(tracked.jobTimer);
    if (tracked.queueTimer) {
      clearTimeout(tracked.queueTimer);
      tracked.queueTimer = undefined;
    }

    complete();
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

      if (!tracked.settled) {
        errorDownload(tracked.job.sha256, `worker lost ${error.message}`);
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
    if (tracked.settled || !this.removeFromQueue(tracked)) {
      return;
    }

    warnDownload(
      tracked.job.sha256,
      `download rejected after ${DOWNLOAD_QUEUE_TIMEOUT}ms waiting for a worker`,
    );
    this.settle(tracked, () => tracked.reject(new DownloadQueueTimeoutError()));
  }

  private handleJobTimeout(tracked: TrackedJob): void {
    if (tracked.settled) {
      return;
    }

    this.removeFromQueue(tracked);
    this.pendingJobs.delete(tracked.job.jobId);

    errorDownload(
      tracked.job.sha256,
      `download timed out after ${DOWNLOAD_JOB_TIMEOUT}ms`,
    );
    this.settle(tracked, () => tracked.reject(new DownloadJobTimeoutError()));

    // The worker is wedged on a job that should have bounded itself, so it
    // can't be trusted with the next one.
    const worker = tracked.worker;
    if (worker && this.busyWorkers.get(worker) === tracked) {
      this.replaceWorker(worker, new DownloadJobTimeoutError());
    }
  }

  private async handleWorkerMessage(
    worker: Worker,
    message: WorkerResponseMessage,
  ): Promise<void> {
    const tracked = this.pendingJobs.get(message.jobId);
    this.pendingJobs.delete(message.jobId);

    if (this.busyWorkers.get(worker) === tracked) {
      this.busyWorkers.delete(worker);
    }

    // Only recycle a worker the pool still owns — a replaced one must stay out.
    if (!this.isTerminating && this.workers.has(worker)) {
      this.idleWorkers.push(worker);
      this.dispatchNext();
    }

    // Late reply for a job that already timed out, or an unknown job id.
    if (!tracked || tracked.settled) {
      return;
    }

    if (message.type === "download:complete") {
      await updateAccessTime(message.sha256, message.size);
      void pruneCacheIfNeeded();
      this.settle(tracked, () =>
        tracked.resolve({ found: true, size: message.size }),
      );
      return;
    }

    if (message.type === "download:notFound") {
      this.settle(tracked, () => tracked.resolve({ found: false }));
      return;
    }

    errorDownload(message.sha256, `worker error ${message.error}`);
    this.settle(tracked, () => tracked.reject(new Error(message.error)));
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
