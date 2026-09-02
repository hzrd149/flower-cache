export interface DownloadJob {
  type: "download";
  jobId: string;
  sha256: string;
  extension?: string;
  servers: string[];
  /**
   * Whether the requester can consume the blob as a stream. The worker still
   * decides whether streaming actually applies (see STREAM_THROUGH_MIN_SIZE).
   */
  stream?: boolean;
}

/** One credit: the response stream is ready for another chunk. */
export interface DownloadPullMessage {
  type: "download:pull";
  jobId: string;
}

/** The client went away; tear the upstream transfer down. */
export interface DownloadCancelMessage {
  type: "download:cancel";
  jobId: string;
}

/**
 * Posted the moment the worker commits to streaming a transfer, so the main
 * thread can answer the client before a single byte has been verified.
 */
export interface DownloadHeadersMessage {
  type: "download:headers";
  jobId: string;
  sha256: string;
  size?: number;
  contentType?: string;
}

export interface DownloadChunkMessage {
  type: "download:chunk";
  jobId: string;
  buffer: ArrayBuffer;
}

export interface DownloadCompleteMessage {
  type: "download:complete";
  jobId: string;
  sha256: string;
  size: number;
  /**
   * False when the transfer was already being streamed to a client by the time
   * the hash came out wrong. The bytes were served; nothing was cached.
   */
  verified: boolean;
}

export interface DownloadNotFoundMessage {
  type: "download:notFound";
  jobId: string;
  sha256: string;
}

export interface DownloadErrorMessage {
  type: "download:error";
  jobId: string;
  sha256: string;
  error: string;
}

export type WorkerRequestMessage =
  | DownloadJob
  | DownloadPullMessage
  | DownloadCancelMessage;

export type WorkerResponseMessage =
  | DownloadHeadersMessage
  | DownloadChunkMessage
  | DownloadCompleteMessage
  | DownloadNotFoundMessage
  | DownloadErrorMessage;

/** What a streamed download reports once the whole transfer has finished. */
export interface StreamCompletion {
  size: number;
  /** True when the bytes hashed to the requested sha256 and were cached. */
  verified: boolean;
  error?: string;
}

/**
 * How a download ended up being delivered.
 *
 * - `stream`: bytes are flowing now; the blob lands in the cache only if it
 *   verifies, which is known when `completion` settles.
 * - `cached`: downloaded, verified and written; serve it from disk.
 * - `notFound`: no upstream had it.
 */
export type DownloadOutcome =
  | {
      kind: "stream";
      contentType?: string;
      size?: number;
      body: ReadableStream<Uint8Array>;
      completion: Promise<StreamCompletion>;
    }
  | { kind: "cached"; size: number }
  | { kind: "notFound" };
