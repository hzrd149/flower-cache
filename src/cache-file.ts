import { join } from "node:path";
import { extension as getExtension } from "mime-types";
import { CACHE_DIR } from "./config";

export interface ParsedCacheFilename {
  sha256: string;
  extension?: string;
}

const CACHE_FILENAME_PATTERN = /^([a-f0-9]{64})(\.[a-z0-9]+)?$/i;

export function normalizeCacheExtension(extension?: string | null): string {
  if (!extension) {
    return ".bin";
  }

  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const lower = normalized.toLowerCase();

  if (!/^\.[a-z0-9]+$/.test(lower)) {
    return ".bin";
  }

  if (lower === ".jpeg") {
    return ".jpg";
  }

  if (lower === ".text") {
    return ".txt";
  }

  return lower;
}

export function parseCacheFilename(
  filename: string,
): ParsedCacheFilename | null {
  const match = filename.match(CACHE_FILENAME_PATTERN);
  if (!match) {
    return null;
  }

  return {
    sha256: match[1]!.toLowerCase(),
    extension: match[2] ? normalizeCacheExtension(match[2]) : undefined,
  };
}

export function buildCacheFilename(
  sha256: string,
  extension?: string | null,
): string {
  return `${sha256.toLowerCase()}${normalizeCacheExtension(extension)}`;
}

export function buildCachePath(
  sha256: string,
  extension?: string | null,
): string {
  return join(CACHE_DIR, buildCacheFilename(sha256, extension));
}

export function getPreferredExtensionFromMimeType(
  mimeType?: string | null,
): string {
  if (!mimeType) {
    return ".bin";
  }

  const normalizedMimeType = mimeType.split(";")[0]?.trim().toLowerCase();
  if (!normalizedMimeType) {
    return ".bin";
  }

  return normalizeCacheExtension(getExtension(normalizedMimeType) || undefined);
}

function matchesSignature(
  bytes: Uint8Array,
  signature: number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }

  return signature.every((value, index) => bytes[offset + index] === value);
}

function isLikelyUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  let printable = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      return false;
    }

    if (
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e)
    ) {
      printable += 1;
    }
  }

  return printable / bytes.length > 0.85;
}

export function inferExtensionFromBytes(bytes: Uint8Array): string {
  if (matchesSignature(bytes, [0xff, 0xd8, 0xff])) {
    return ".jpg";
  }

  if (
    matchesSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return ".png";
  }

  if (
    matchesSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    matchesSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return ".gif";
  }

  if (
    matchesSignature(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    matchesSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return ".webp";
  }

  if (matchesSignature(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return ".pdf";
  }

  if (matchesSignature(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return ".zip";
  }

  if (matchesSignature(bytes, [0x1f, 0x8b])) {
    return ".gz";
  }

  if (matchesSignature(bytes, [0x66, 0x4c, 0x61, 0x43])) {
    return ".flac";
  }

  if (matchesSignature(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return ".ogg";
  }

  if (
    matchesSignature(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    matchesSignature(bytes, [0x57, 0x41, 0x56, 0x45], 8)
  ) {
    return ".wav";
  }

  if (matchesSignature(bytes, [0x49, 0x44, 0x33])) {
    return ".mp3";
  }

  if (bytes.length > 1 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    return ".mp3";
  }

  if (matchesSignature(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ".webm";
  }

  if (matchesSignature(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    return ".mp4";
  }

  if (isLikelyUtf8Text(bytes)) {
    const text = new TextDecoder().decode(bytes).trimStart().toLowerCase();

    if (
      text.startsWith("<svg") ||
      text.startsWith("<?xml") ||
      text.includes("<svg")
    ) {
      return ".svg";
    }

    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      return ".json";
    }

    if (text.startsWith("<!doctype html") || text.startsWith("<html")) {
      return ".html";
    }

    return ".txt";
  }

  return ".bin";
}

export async function inferExtensionFromFile(
  filePath: string,
): Promise<string> {
  try {
    const slice = Bun.file(filePath).slice(0, 4096);
    const buffer = await slice.arrayBuffer();
    return inferExtensionFromBytes(new Uint8Array(buffer));
  } catch {
    return ".bin";
  }
}
