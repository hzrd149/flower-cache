import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CACHE_DIR } from "./config";
import { errorDownload, formatDurationMs, logDownload } from "./download-log";
import { fetchFromServer } from "./proxy";
import { createHashStream } from "./hash-stream";
import type {
  DownloadJob,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from "./worker-protocol";

function getCachePath(sha256: string): string {
  return `${CACHE_DIR}/${sha256}`;
}

function getTempCachePath(sha256: string): string {
  return `${CACHE_DIR}/.${sha256}.${randomUUID()}.part`;
}

async function writeValidatedBlobToCache(
  sha256: string,
  upstreamStream: ReadableStream<Uint8Array>,
): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true });

  const tempPath = getTempCachePath(sha256);
  const finalPath = getCachePath(sha256);
  const hashStream = createHashStream(sha256);
  const hashedStream = upstreamStream.pipeThrough(hashStream);
  const writer = Bun.file(tempPath).writer();
  let size = 0;

  try {
    const reader = hashedStream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.length;
      writer.write(value);
    }

    writer.end();

    const isValid = await hashStream.validateHash();
    if (!isValid) {
      throw new Error("Hash validation failed");
    }

    await Bun.write(finalPath, Bun.file(tempPath));
    await Bun.file(tempPath).delete();
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

    throw error;
  }
}

async function runDownload(job: DownloadJob): Promise<WorkerResponseMessage> {
  const startedAt = performance.now();

  for (const server of job.servers) {
    const response = await fetchFromServer(server, job.sha256, job.extension);

    if (!response || !response.ok || !response.body) {
      continue;
    }

    const size = await writeValidatedBlobToCache(job.sha256, response.body);
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
