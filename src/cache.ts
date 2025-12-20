// Cache management functions

import { CACHE_DIR } from "./config";
import type { BunFile } from "bun";

/**
 * Ensure the cache directory exists
 */
export async function ensureCacheDir(): Promise<void> {
  try {
    await Bun.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore
  }
}

/**
 * Get the cache file path for a given sha256 hash
 */
function getCachePath(sha256: string): string {
  return `${CACHE_DIR}/${sha256}`;
}

/**
 * Check if a blob exists in cache
 * @returns BunFile if exists, null otherwise
 */
export async function checkCache(sha256: string): Promise<BunFile | null> {
  const cachePath = getCachePath(sha256);
  try {
    const file = Bun.file(cachePath);
    const exists = await file.exists();
    return exists ? file : null;
  } catch {
    return null;
  }
}

/**
 * Write a blob to cache
 */
export async function writeCache(sha256: string, data: Blob | ArrayBuffer): Promise<void> {
  const cachePath = getCachePath(sha256);
  await Bun.write(cachePath, data);
}

