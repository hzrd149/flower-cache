// Upload handler for BUD-02 PUT /upload and BUD-13 PUT /<sha256> endpoints

import {
  ensureCacheDir,
  findCacheEntry,
  writeCacheWithMetadata,
  getUploadTimestampFromDb,
} from "./cache";
import {
  createErrorResponse,
  getMimeTypeFromHeader,
  getContentType,
  normalizeExtensionFromMimeType,
  createBlobDescriptor,
} from "./response";
import {
  buildCachePath,
  inferExtensionFromFile,
  normalizeCacheExtension,
} from "./cache-file";
import { clearMissing } from "./negative-cache";
import { validateAllowedIP } from "./security";
import { isHexKey } from "applesauce-core/helpers";
import { randomUUID } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR, REQUEST_TIMEOUT } from "./config";
import { resolveCandidateServers } from "./servers";
import { fetchFromServer } from "./proxy";
import { logDownload } from "./download-log";

interface UploadOptions {
  expectedSha256?: string;
  url?: URL;
}

interface TempBlobResult {
  tempPath: string;
  computedHash: string;
  size: number;
}

interface RemoteFetchResult {
  response: Response;
}

/**
 * Handle PUT /upload request
 * @param req - The request object
 * @param server - The Bun server instance (for IP validation)
 * @returns Response with blob descriptor or error
 */
export async function handleUploadRequest(
  req: Request,
  server: { requestIP: (req: Request) => { address: string } | null },
  options: UploadOptions = {},
): Promise<Response> {
  // Validate allowed IP
  const ipError = validateAllowedIP(req, server);
  if (ipError) return ipError;

  try {
    await ensureCacheDir();

    const expectedSha256 = options.expectedSha256?.toLowerCase();
    const remoteUrls = options.url?.searchParams.getAll("url") ?? [];
    const hasRemoteUrls = remoteUrls.length > 0;
    const hasBud10Sources = hasBud10SourceParams(options.url);

    if (expectedSha256 && hasRemoteUrls) {
      return handleRemoteUrlUpload(req, expectedSha256, remoteUrls);
    }

    if (expectedSha256 && hasBud10Sources && isRequestBodyEmpty(req)) {
      return handleBlossomMirrorUpload(options.url!, expectedSha256);
    }

    return handleBinaryUpload(req, expectedSha256);
  } catch (error) {
    console.error("Upload error:", error);
    return createErrorResponse(
      500,
      `Upload failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

async function handleBinaryUpload(
  req: Request,
  expectedSha256?: string,
): Promise<Response> {
  if (!req.body) {
    return createErrorResponse(400, "Request body is required");
  }

  const contentType = req.headers.get("Content-Type");
  const mimeType = getMimeTypeFromHeader(contentType);
  const extension = normalizeCacheExtension(
    normalizeExtensionFromMimeType(mimeType),
  );
  const temp = await writeStreamToTempFile(req.body);

  try {
    const conflict = validateUploadHash(req, temp.computedHash, expectedSha256);
    if (conflict) {
      await unlink(temp.tempPath).catch(() => {});
      return conflict;
    }

    return storeTempBlob(temp, extension, mimeType);
  } catch (error) {
    await unlink(temp.tempPath).catch(() => {});
    throw error;
  }
}

async function handleRemoteUrlUpload(
  req: Request,
  expectedSha256: string,
  remoteUrls: string[],
): Promise<Response> {
  if (!isRequestBodyEmpty(req)) {
    return createErrorResponse(
      400,
      "Request body must be empty when url query parameters are provided",
    );
  }

  const urls = parseRemoteUrls(remoteUrls);
  if (!urls) {
    return createErrorResponse(
      400,
      "url parameters must be absolute http or https URLs",
    );
  }

  const existing = await createExistingBlobDescriptor(expectedSha256);
  if (existing) return existing;

  let sawHashMismatch = false;

  for (const source of urls) {
    const response = await fetchRemoteSource(source.href);
    if (!response.response.body) continue;

    const contentType = response.response.headers.get("Content-Type");
    const temp = await writeStreamToTempFile(response.response.body);
    const extension = contentType
      ? normalizeExtensionFromMimeType(getMimeTypeFromHeader(contentType))
      : await inferExtensionFromFile(temp.tempPath);
    const mimeType = contentType
      ? getMimeTypeFromHeader(contentType)
      : getContentType(extension);

    try {
      if (temp.computedHash !== expectedSha256) {
        sawHashMismatch = true;
        await unlink(temp.tempPath).catch(() => {});
        continue;
      }

      return storeTempBlob(temp, extension, mimeType);
    } catch (error) {
      await unlink(temp.tempPath).catch(() => {});
      throw error;
    }
  }

  if (sawHashMismatch) {
    return createErrorResponse(
      409,
      "sha256 from the path does not match any fetched remote blob",
    );
  }

  return createErrorResponse(502, "Could not fetch blob from any remote URL");
}

async function handleBlossomMirrorUpload(
  url: URL,
  expectedSha256: string,
): Promise<Response> {
  const authorPubkeys = url.searchParams.getAll("as").filter(isHexKey);
  const serverHints = [
    ...url.searchParams.getAll("xs"),
    ...url.searchParams.getAll("sx"),
  ].map((s) => (s.startsWith("http") ? s : `https://${s}`));
  const servers = await resolveCandidateServers(authorPubkeys, serverHints);

  if (servers.length === 0) {
    return createErrorResponse(502, "No Blossom source servers available");
  }

  const existing = await createExistingBlobDescriptor(expectedSha256);
  if (existing) return existing;

  const response = await fetchBlossomSource(servers, expectedSha256);
  if (!response || !response.response.body) {
    return createErrorResponse(
      502,
      "Could not fetch blob from Blossom sources",
    );
  }

  const contentType = response.response.headers.get("Content-Type");
  const temp = await writeStreamToTempFile(response.response.body);
  const extension = contentType
    ? normalizeExtensionFromMimeType(getMimeTypeFromHeader(contentType))
    : await inferExtensionFromFile(temp.tempPath);
  const mimeType = contentType
    ? getMimeTypeFromHeader(contentType)
    : getContentType(extension);

  try {
    if (temp.computedHash !== expectedSha256) {
      await unlink(temp.tempPath).catch(() => {});
      return createErrorResponse(
        409,
        "sha256 from the path does not match fetched Blossom blob",
      );
    }

    return storeTempBlob(temp, extension, mimeType);
  } catch (error) {
    await unlink(temp.tempPath).catch(() => {});
    throw error;
  }
}

async function writeStreamToTempFile(
  stream: ReadableStream<Uint8Array>,
): Promise<TempBlobResult> {
  const tempId = randomUUID();
  const tempPath = join(CACHE_DIR, `.upload-${tempId}`);
  const tempFile = Bun.file(tempPath);
  const writer = tempFile.writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;

  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      hasher.update(value);
      writer.write(value);
      size += value.length;
    }

    writer.end();
    return {
      tempPath,
      computedHash: hasher.digest("hex").toLowerCase(),
      size,
    };
  } catch (error) {
    try {
      writer.end();
    } catch {}
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function validateUploadHash(
  req: Request,
  computedHash: string,
  expectedSha256?: string,
): Response | null {
  if (expectedSha256 && expectedSha256 !== computedHash) {
    return createErrorResponse(
      409,
      `sha256 from the path (${expectedSha256}) does not match the uploaded content (${computedHash})`,
    );
  }

  const claimedHash = req.headers.get("X-SHA-256")?.trim().toLowerCase();
  if (claimedHash && claimedHash !== computedHash) {
    return createErrorResponse(
      409,
      `X-SHA-256 (${claimedHash}) does not match the uploaded content (${computedHash})`,
    );
  }

  return null;
}

async function storeTempBlob(
  temp: TempBlobResult,
  extension: string,
  mimeType: string,
): Promise<Response> {
  clearMissing(temp.computedHash);

  const existing = await createExistingBlobDescriptor(temp.computedHash);
  if (existing) {
    await unlink(temp.tempPath).catch(() => {});
    logDownload(temp.computedHash, "upload skipped: blob already exists");
    return existing;
  }

  const normalizedExt = normalizeCacheExtension(extension);
  const finalCachePath = buildCachePath(temp.computedHash, normalizedExt);
  await rename(temp.tempPath, finalCachePath);

  const uploadedTimestamp = Math.floor(Date.now() / 1000);
  await writeCacheWithMetadata(
    temp.computedHash,
    temp.size,
    uploadedTimestamp,
    normalizedExt,
  );

  logDownload(temp.computedHash, `✓ upload completed: ${temp.size} bytes`);

  return createBlobDescriptor(
    temp.computedHash,
    temp.size,
    mimeType,
    uploadedTimestamp,
    normalizedExt,
    undefined,
    201,
  );
}

async function createExistingBlobDescriptor(
  sha256: string,
): Promise<Response | null> {
  const existingEntry = await findCacheEntry(sha256);
  if (!existingEntry) return null;

  const existingFile = Bun.file(existingEntry.filePath);
  const existingStats = await existingFile.stat();
  const uploadedTimestamp = await getUploadTimestamp(sha256);

  return createBlobDescriptor(
    sha256,
    existingStats.size,
    getContentType(existingEntry.extension),
    uploadedTimestamp,
    existingEntry.extension,
  );
}

function parseRemoteUrls(values: string[]): URL[] | null {
  const urls: URL[] = [];

  for (const value of values) {
    if (!URL.canParse(value)) return null;

    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    urls.push(url);
  }

  return urls;
}

async function fetchRemoteSource(url: string): Promise<RemoteFetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      return { response: new Response(null, { status: 502 }) };
    }

    return { response };
  } catch {
    return { response: new Response(null, { status: 502 }) };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchBlossomSource(
  servers: string[],
  sha256: string,
): Promise<RemoteFetchResult | null> {
  for (const server of servers) {
    const response = await fetchFromServer(server, sha256);
    if (response?.ok && response.body) {
      return { response };
    }
  }

  return null;
}

function hasBud10SourceParams(url?: URL): boolean {
  if (!url) return false;
  return (
    url.searchParams.has("xs") ||
    url.searchParams.has("sx") ||
    url.searchParams.has("as")
  );
}

function isRequestBodyEmpty(req: Request): boolean {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength !== null) {
    return parseInt(contentLength, 10) === 0;
  }

  return !req.body;
}

/**
 * Get upload timestamp from cache metadata
 * Falls back to current time if not found
 */
async function getUploadTimestamp(sha256: string): Promise<number> {
  try {
    const timestamp = await getUploadTimestampFromDb(sha256);
    return timestamp || Math.floor(Date.now() / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}
