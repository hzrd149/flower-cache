export interface DownloadJob {
  type: "download";
  jobId: string;
  sha256: string;
  extension?: string;
  servers: string[];
}

export interface DownloadCompleteMessage {
  type: "download:complete";
  jobId: string;
  sha256: string;
  size: number;
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

export type WorkerRequestMessage = DownloadJob;

export type WorkerResponseMessage =
  | DownloadCompleteMessage
  | DownloadNotFoundMessage
  | DownloadErrorMessage;

export interface DownloadResult {
  found: boolean;
  size?: number;
}
