import { mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CACHE_DIR } from "./config";
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

function getTempCachePath(sha256: string): string {
  return `${CACHE_DIR}/.${sha256}.${randomUUID()}.part`;
}

async function writeValidatedBlobToCache(
  sha256: string,
  extension: string,
  upstreamStream: ReadableStream<Uint8Array>,
): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true });

  const tempPath = getTempCachePath(sha256);
  const finalPath = buildCachePath(sha256, extension);
  const hasher = new Bun.CryptoHasher("sha256");
  const writer = Bun.file(tempPath).writer();
  let size = 0;

  try {
    const reader = upstreamStream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      hasher.update(value);
      size += value.length;
      writer.write(value);
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

    throw error;
  }
}

async function runDownload(job: DownloadJob): Promise<WorkerResponseMessage> {
  const startedAt = performance.now();
  let sawInvalidBlob = false;

  for (const server of job.servers) {
    try {
      const response = await fetchFromServer(server, job.sha256, job.extension);

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
