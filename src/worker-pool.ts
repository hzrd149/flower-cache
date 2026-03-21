import { randomUUID } from "node:crypto";
import { pruneCacheIfNeeded, updateAccessTime } from "./cache";
import { errorDownload, logDownload } from "./download-log";
import type {
  DownloadJob,
  DownloadResult,
  WorkerResponseMessage,
} from "./worker-protocol";

interface PendingJob {
  job: DownloadJob;
  resolve: (result: DownloadResult) => void;
  reject: (error: Error) => void;
}

interface BusyWorker {
  jobId: string;
  sha256: string;
}

export class DownloadWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idleWorkers: Worker[] = [];
  private readonly busyWorkers = new Map<Worker, BusyWorker>();
  private readonly pendingJobs = new Map<
    string,
    {
      resolve: (result: DownloadResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly queuedJobs: PendingJob[] = [];
  private isTerminating = false;

  constructor(workerCount: number) {
    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(
        new URL("./download-worker.ts", import.meta.url).href,
        { type: "module" },
      );

      worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
        void this.handleWorkerMessage(worker, event.data);
      };

      worker.onerror = (event) => {
        this.handleWorkerFailure(worker, new Error(event.message));
      };

      this.workers.push(worker);
      this.idleWorkers.push(worker);
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

    return new Promise<DownloadResult>((resolve, reject) => {
      const job: DownloadJob = {
        type: "download",
        jobId: randomUUID(),
        sha256,
        extension,
        servers,
      };

      this.queuedJobs.push({ job, resolve, reject });
      this.dispatchNext();
    });
  }

  async terminate(): Promise<void> {
    this.isTerminating = true;

    while (this.queuedJobs.length > 0) {
      const pending = this.queuedJobs.shift();
      pending?.reject(new Error("Download worker pool terminated"));
    }

    for (const pending of this.pendingJobs.values()) {
      pending.reject(new Error("Download worker pool terminated"));
    }
    this.pendingJobs.clear();
    this.busyWorkers.clear();
    this.idleWorkers.length = 0;

    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private dispatchNext(): void {
    if (this.isTerminating) {
      return;
    }

    while (this.idleWorkers.length > 0 && this.queuedJobs.length > 0) {
      const worker = this.idleWorkers.shift();
      const pending = this.queuedJobs.shift();

      if (!worker || !pending) {
        return;
      }

      this.pendingJobs.set(pending.job.jobId, {
        resolve: pending.resolve,
        reject: pending.reject,
      });
      this.busyWorkers.set(worker, {
        jobId: pending.job.jobId,
        sha256: pending.job.sha256,
      });
      worker.postMessage(pending.job);
    }
  }

  private async handleWorkerMessage(
    worker: Worker,
    message: WorkerResponseMessage,
  ): Promise<void> {
    const pending = this.pendingJobs.get(message.jobId);
    this.pendingJobs.delete(message.jobId);
    this.busyWorkers.delete(worker);

    if (!this.isTerminating) {
      this.idleWorkers.push(worker);
      this.dispatchNext();
    }

    if (!pending) {
      return;
    }

    if (message.type === "download:complete") {
      await updateAccessTime(message.sha256, message.size);
      void pruneCacheIfNeeded();
      pending.resolve({ found: true, size: message.size });
      return;
    }

    if (message.type === "download:notFound") {
      pending.resolve({ found: false });
      return;
    }

    errorDownload(message.sha256, `worker error ${message.error}`);
    pending.reject(new Error(message.error));
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    const busy = this.busyWorkers.get(worker);
    if (busy) {
      this.busyWorkers.delete(worker);
      const pending = this.pendingJobs.get(busy.jobId);
      this.pendingJobs.delete(busy.jobId);
      errorDownload(busy.sha256, `worker crashed ${error.message}`);
      pending?.reject(error);
    }

    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex >= 0) {
      this.idleWorkers.splice(idleIndex, 1);
    }
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
